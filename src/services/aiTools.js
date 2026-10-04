'use strict';

/**
 * Bunk AI's deterministic tool layer. Claude never computes an attendance
 * number itself — it calls one of these functions and explains the result
 * in plain language. Every function here either calls straight into
 * attendanceEngine.js (the app's single source of truth for attendance
 * math — see that file's header) or reuses attendanceController.js's own
 * data-building functions via its `_internal`/named exports, so this file
 * adds orchestration for the chat use case, not a second copy of the math.
 *
 * Every function takes the authenticated `user` document (from
 * req.user, set by middleware/auth.js's requireAuth) as its first
 * argument and only ever queries records scoped to that user's own id —
 * this is what guarantees Bunk AI can never see or report on another
 * student's data, since there is no code path here that accepts or
 * derives a different user id from anywhere (not from the request body,
 * not from the model's tool-call arguments).
 */

const Subject = require('../models/Subject');
const TimetableSlot = require('../models/TimetableSlot');
const LectureRecord = require('../models/LectureRecord');
const Holiday = require('../models/Holiday');
const Semester = require('../models/Semester');
const engine = require('../services/attendanceEngine');
const attendanceController = require('../controllers/attendanceController');

const { ensureLecturesForDate, startOfDay, semesterRecords, DAY_NAMES } = attendanceController._internal;

async function requireActiveSemester(user) {
  const semester = await Semester.findById(user.currentSemester);
  if (!semester) throw new Error('No active semester is set up yet — finish Setup first.');
  return semester;
}

/** Case-insensitive, either-direction substring match — same approach the frontend's timetable OCR uses to match a scanned name against real subjects. */
function findSubjectMatch(subjects, name) {
  if (!name) return null;
  const norm = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!norm) return null;
  return (
    subjects.find((s) => {
      const subjName = (s.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const code = (s.code || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      return (subjName && (norm.includes(subjName) || subjName.includes(norm))) || (code && (norm.includes(code) || code.includes(norm)));
    }) || null
  );
}

function toDateOnly(d) {
  return startOfDay(d).toISOString().slice(0, 10);
}

/** get_attendance_overview — the same numbers the Dashboard shows: overall/monthly attendance, safe bunks, semester-end achievability. */
async function getAttendanceOverview(user) {
  const data = await attendanceController.buildOverviewData(user);
  return {
    semesterName: data.semester.name,
    semesterStartDate: toDateOnly(data.semester.startDate),
    semesterEndDate: data.semester.endDate ? toDateOnly(data.semester.endDate) : null,
    requiredAttendancePercentage: data.requiredAttendancePercentage,
    overall: data.overall,
    monthly: data.monthly,
    safeBunksRemaining: data.safeBunksRemaining,
    belowRequirement: data.danger,
    semesterEndInfo: data.semesterEndInfo,
  };
}

/** get_subject_breakdown — per-subject attended/conducted/percentage/safe-bunks, optionally filtered to one subject by (fuzzy) name. */
async function getSubjectBreakdown(user, { subjectName } = {}) {
  const semester = await requireActiveSemester(user);
  const rows = await attendanceController.buildSubjectAnalyticsData(user, semester);
  const formatted = rows.map((r) => ({
    subjectName: r.subject.name,
    code: r.subject.code || null,
    facultyName: r.subject.facultyName || null,
    attended: r.attended,
    conducted: r.conducted,
    bunked: r.bunked,
    percentage: r.percentage,
    safeBunksRemaining: r.safeBunksRemaining,
    lecturesNeededForRequirement: r.lecturesNeeded,
    semesterEndAchievability: r.achievability,
  }));

  if (!subjectName) return { requiredAttendancePercentage: semester.requiredAttendancePercentage, subjects: formatted };

  const match = findSubjectMatch(
    rows.map((r) => r.subject),
    subjectName
  );
  if (!match) return { error: `No subject matching "${subjectName}" was found.`, subjects: formatted };
  const row = formatted.find((r) => r.subjectName === match.name);
  return { requiredAttendancePercentage: semester.requiredAttendancePercentage, subject: row };
}

/**
 * get_timetable — lectures for a given date (default today). Today/past
 * dates read real LectureRecord status; a future date is a read-only
 * preview straight from the weekly TimetableSlot template (same approach
 * futureSimulator uses) so asking the AI about tomorrow never creates
 * lecture records early the way opening that date in the UI eventually
 * would — this tool only ever reads, it never writes attendance state.
 */
async function getTimetable(user, { date } = {}) {
  const semester = await requireActiveSemester(user);
  const today = startOfDay(new Date());
  const target = date ? startOfDay(new Date(date)) : today;
  if (Number.isNaN(target.getTime())) throw new Error(`"${date}" is not a valid date.`);

  if (target.getTime() === today.getTime()) {
    const records = await ensureLecturesForDate(user, target);
    return {
      date: toDateOnly(target),
      lectures: records.map((r) => ({ lectureNumber: r.lectureNumber, subjectName: r.subject?.name, facultyName: r.subject?.facultyName, status: r.status })),
    };
  }

  if (target < today) {
    const records = await LectureRecord.find({ user: user._id, date: target }).populate('subject', 'name facultyName').sort({ lectureNumber: 1 });
    return {
      date: toDateOnly(target),
      lectures: records.map((r) => ({ lectureNumber: r.lectureNumber, subjectName: r.subject?.name, facultyName: r.subject?.facultyName, status: r.status })),
    };
  }

  if (semester.endDate && target > startOfDay(semester.endDate)) {
    return { date: toDateOnly(target), error: `That date is after "${semester.name}" ends.`, lectures: [] };
  }

  const dayName = DAY_NAMES[target.getDay()];
  const [slots, holiday] = await Promise.all([
    TimetableSlot.find({ user: user._id, semester: semester._id, day: dayName }).populate('subject', 'name facultyName').sort({ lectureNumber: 1 }),
    Holiday.findOne({ user: user._id, date: target }),
  ]);
  if (holiday) return { date: toDateOnly(target), isHoliday: true, lectures: [] };
  return {
    date: toDateOnly(target),
    isHoliday: false,
    lectures: slots.map((s) => ({ lectureNumber: s.lectureNumber, subjectName: s.subject?.name, facultyName: s.subject?.facultyName, status: 'not yet conducted' })),
  };
}

/** calculate_bunk_limit — how many more lectures can be missed and still hold the required %, overall or for one subject. */
async function calculateBunkLimit(user, { subjectName } = {}) {
  const semester = await requireActiveSemester(user);
  const requiredPct = semester.requiredAttendancePercentage;

  if (subjectName) {
    const subjects = await Subject.find({ user: user._id, semester: semester._id });
    const match = findSubjectMatch(subjects, subjectName);
    if (!match) return { error: `No subject matching "${subjectName}" was found.` };
    const records = await LectureRecord.find({ user: user._id, subject: match._id, semester: semester._id }).lean();
    const stats = engine.summarize(records);
    return {
      subjectName: match.name,
      ...stats,
      requiredAttendancePercentage: requiredPct,
      safeBunksRemaining: engine.safeBunksRemaining(stats.attended, stats.conducted, requiredPct),
    };
  }

  const records = await semesterRecords(user, semester._id);
  const stats = engine.summarize(records);
  return {
    ...stats,
    requiredAttendancePercentage: requiredPct,
    safeBunksRemaining: engine.safeBunksRemaining(stats.attended, stats.conducted, requiredPct),
  };
}

/** calculate_required_lectures — how many more (attended) lectures are needed to reach a target %, overall or for one subject. */
async function calculateRequiredLectures(user, { targetPercentage, subjectName } = {}) {
  const semester = await requireActiveSemester(user);
  const target = Number.isFinite(targetPercentage) ? targetPercentage : semester.requiredAttendancePercentage;

  if (subjectName) {
    const subjects = await Subject.find({ user: user._id, semester: semester._id });
    const match = findSubjectMatch(subjects, subjectName);
    if (!match) return { error: `No subject matching "${subjectName}" was found.` };
    const records = await LectureRecord.find({ user: user._id, subject: match._id, semester: semester._id }).lean();
    const stats = engine.summarize(records);
    return { subjectName: match.name, ...stats, targetPercentage: target, lecturesNeeded: engine.lecturesNeededForTarget(stats.attended, stats.conducted, target) };
  }

  const records = await semesterRecords(user, semester._id);
  const stats = engine.summarize(records);
  return { ...stats, targetPercentage: target, lecturesNeeded: engine.lecturesNeededForTarget(stats.attended, stats.conducted, target) };
}

/** simulate_attendance — "what happens if I miss/attend N more lectures", overall or for one subject. */
async function simulateAttendance(user, { lecturesToMiss, subjectName } = {}) {
  const semester = await requireActiveSemester(user);
  const n = Number.isFinite(lecturesToMiss) ? Math.max(0, Math.floor(lecturesToMiss)) : 1;

  let stats;
  let label = null;
  if (subjectName) {
    const subjects = await Subject.find({ user: user._id, semester: semester._id });
    const match = findSubjectMatch(subjects, subjectName);
    if (!match) return { error: `No subject matching "${subjectName}" was found.` };
    label = match.name;
    const records = await LectureRecord.find({ user: user._id, subject: match._id, semester: semester._id }).lean();
    stats = engine.summarize(records);
  } else {
    const records = await semesterRecords(user, semester._id);
    stats = engine.summarize(records);
  }

  const simulation = engine.simulateFuture(stats.attended, stats.conducted, n, semester.requiredAttendancePercentage);
  return {
    subjectName: label,
    current: stats,
    lecturesSimulated: n,
    requiredAttendancePercentage: semester.requiredAttendancePercentage,
    ifAllMissed: simulation.bunkAllScenario,
    ifAllAttended: simulation.attendAllScenario,
  };
}

module.exports = {
  getAttendanceOverview,
  getSubjectBreakdown,
  getTimetable,
  calculateBunkLimit,
  calculateRequiredLectures,
  simulateAttendance,
};
