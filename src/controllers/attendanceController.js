'use strict';

const LectureRecord = require('../models/LectureRecord');
const TimetableSlot = require('../models/TimetableSlot');
const Subject = require('../models/Subject');
const Holiday = require('../models/Holiday');
const Exam = require('../models/Exam');
const Semester = require('../models/Semester');
const engine = require('../services/attendanceEngine');
const { ApiError, asyncHandler } = require('../middleware/errorHandler');

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}
function endOfDay(date) {
  const d = new Date(date);
  d.setHours(23, 59, 59, 999);
  return d;
}

/**
 * Ensures LectureRecord documents exist for the given date, generated from
 * the weekly timetable template. Idempotent: safe to call every time a
 * date is opened. If the date is a holiday, records are created with
 * status 'holiday' so the day still shows up but never affects attendance.
 */
async function ensureLecturesForDate(user, date) {
  const day = startOfDay(date);
  const dayName = DAY_NAMES[day.getDay()];

  const [slots, holiday, existing] = await Promise.all([
    TimetableSlot.find({ user: user._id, semester: user.currentSemester, day: dayName }).populate('subject'),
    Holiday.findOne({ user: user._id, date: day }),
    LectureRecord.find({ user: user._id, date: day }),
  ]);

  const existingByLectureNumber = new Map(existing.map((r) => [r.lectureNumber, r]));
  const toCreate = [];

  for (const slot of slots) {
    if (existingByLectureNumber.has(slot.lectureNumber)) continue;
    toCreate.push({
      user: user._id,
      semester: user.currentSemester,
      subject: slot.subject._id,
      facultyName: slot.subject.facultyName,
      date: day,
      lectureNumber: slot.lectureNumber,
      status: holiday ? 'holiday' : 'pending',
      sourceSlot: slot._id,
    });
  }

  if (toCreate.length) {
    await LectureRecord.insertMany(toCreate, { ordered: false }).catch((err) => {
      // Duplicate-key races (e.g. two rapid requests) are safe to ignore here.
      if (err.code !== 11000) throw err;
    });
  }

  return LectureRecord.find({ user: user._id, date: day }).populate('subject', 'name code facultyName').sort({ lectureNumber: 1 });
}

const getDayLectures = asyncHandler(async (req, res) => {
  const { date } = req.params;
  const records = await ensureLecturesForDate(req.user, new Date(date));
  res.json({ date, lectures: records });
});

/** Extra lecture: not on the regular timetable but held anyway. */
const addExtraLecture = asyncHandler(async (req, res) => {
  const { date, subject, lectureNumber, status } = req.body;
  const subj = await Subject.findOne({ _id: subject, user: req.user._id });
  if (!subj) throw new ApiError(404, 'Subject not found');

  const record = await LectureRecord.create({
    user: req.user._id,
    semester: req.user.currentSemester,
    subject: subj._id,
    facultyName: subj.facultyName,
    date: startOfDay(date),
    lectureNumber,
    status: status || 'extra',
    markedAt: new Date(),
  });

  res.status(201).json({ lecture: record });
});

/** Mark one lecture's status: attended / bunked / holiday / cancelled / extra. */
const markLecture = asyncHandler(async (req, res) => {
  const { status } = req.body;
  const record = await LectureRecord.findOneAndUpdate(
    { _id: req.params.id, user: req.user._id },
    { status, markedAt: new Date() },
    { new: true, runValidators: true }
  );
  if (!record) throw new ApiError(404, 'Lecture record not found');
  res.json({ lecture: record });
});

/** Bulk-mark every lecture on a given date (e.g. "Mark whole day attended"). */
const markDay = asyncHandler(async (req, res) => {
  const { date, status } = req.body;
  const records = await ensureLecturesForDate(req.user, new Date(date));
  const ids = records.map((r) => r._id);
  await LectureRecord.updateMany({ _id: { $in: ids } }, { status, markedAt: new Date() });
  const updated = await LectureRecord.find({ _id: { $in: ids } }).populate('subject', 'name');
  res.json({ lectures: updated });
});

/**
 * Generates any missing 'pending' LectureRecords for one subject across its
 * whole history so far (semester start -> today), from the weekly
 * timetable template — the same generation rule ensureLecturesForDate uses
 * per-day, just applied across a range for a single subject. Idempotent
 * (unique index + insertMany ordered:false swallows duplicate-key races),
 * so it's safe to call every time a backfill is requested.
 */
async function backfillSubjectLectures(user, subject, semester) {
  const slots = await TimetableSlot.find({ user: user._id, semester: semester._id, subject: subject._id });
  if (!slots.length) return;

  const slotsByDay = new Map();
  for (const slot of slots) {
    if (!slotsByDay.has(slot.day)) slotsByDay.set(slot.day, []);
    slotsByDay.get(slot.day).push(slot);
  }

  const start = startOfDay(semester.startDate);
  // Stop at YESTERDAY, never today — today's lecture(s) must stay whatever
  // they currently are (usually 'pending') and only get marked through the
  // normal Dashboard/Attendance flow once the user actually attends them.
  // A "past history" tool has no business deciding today's attendance.
  const end = startOfDay(new Date());
  end.setDate(end.getDate() - 1);
  if (end < start) return;
  const holidays = await Holiday.find({ user: user._id, date: { $gte: start, $lte: end } }).lean();
  const holidaySet = new Set(holidays.map((h) => startOfDay(h.date).toISOString().slice(0, 10)));

  const toCreate = [];
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const dayName = DAY_NAMES[d.getDay()];
    const daySlots = slotsByDay.get(dayName);
    if (!daySlots) continue;

    const isHoliday = holidaySet.has(d.toISOString().slice(0, 10));
    for (const slot of daySlots) {
      toCreate.push({
        user: user._id,
        semester: semester._id,
        subject: subject._id,
        facultyName: subject.facultyName,
        date: new Date(d),
        lectureNumber: slot.lectureNumber,
        status: isHoliday ? 'holiday' : 'pending',
        sourceSlot: slot._id,
      });
    }
  }

  if (toCreate.length) {
    await LectureRecord.insertMany(toCreate, { ordered: false }).catch((err) => {
      if (err.code !== 11000) throw err;
    });
  }
}

/**
 * Quick Bunk Backfill: user only remembers HOW MANY lectures of a subject
 * they bunked, not which specific dates. Backfills real lecture records for
 * every past date that subject was on the timetable, then resolves the
 * still-pending ones into bunked/attended via attendanceEngine — so the
 * result is ordinary LectureRecord data, correctly reflected everywhere
 * (calendar, monthly report, overview) with no separate running total.
 */
const backfillBunks = asyncHandler(async (req, res) => {
  const { bunked } = req.body;
  const subject = await Subject.findOne({ _id: req.params.subjectId, user: req.user._id });
  if (!subject) throw new ApiError(404, 'Subject not found');

  const semester = await Semester.findById(req.user.currentSemester);
  if (!semester) throw new ApiError(400, 'No active semester');

  await backfillSubjectLectures(req.user, subject, semester);

  // Defensive re-check: never touch today's (or any future) lecture here,
  // even if one already existed as 'pending' from elsewhere (e.g. the
  // Dashboard generates today's records on every visit).
  const pending = await LectureRecord.find({
    user: req.user._id,
    subject: subject._id,
    status: 'pending',
    date: { $lt: startOfDay(new Date()) },
  }).sort({ date: 1, lectureNumber: 1 });

  const resolved = engine.resolveBackfillCounts(pending.length, Number(bunked));
  const bunkedIds = pending.slice(0, resolved.bunked).map((r) => r._id);
  const attendedIds = pending.slice(resolved.bunked).map((r) => r._id);

  await Promise.all([
    bunkedIds.length ? LectureRecord.updateMany({ _id: { $in: bunkedIds } }, { status: 'bunked', markedAt: new Date() }) : null,
    attendedIds.length
      ? LectureRecord.updateMany({ _id: { $in: attendedIds } }, { status: 'attended', markedAt: new Date() })
      : null,
  ]);

  res.json({
    subject: { id: subject._id, name: subject.name },
    totalResolved: pending.length,
    bunked: resolved.bunked,
    attended: resolved.attended,
    requestedBunked: Number(bunked),
    clamped: resolved.bunked !== Number(bunked),
  });
});

// ---------------------------------------------------------------------------
// Analytics endpoints — all delegate their math to attendanceEngine.js
// ---------------------------------------------------------------------------

async function semesterRecords(user, semesterId) {
  return LectureRecord.find({ user: user._id, semester: semesterId }).lean();
}

/**
 * Projects the weekly timetable template forward across [fromDate, toDate]
 * (inclusive) to count how many lectures will actually still be conducted
 * before a semester's end date — the piece needed to tell "you need 12 more
 * lectures to reach 75%" apart from "...but only 8 remain before the
 * semester ends, so 75% is no longer reachable." Holidays and exam-period
 * dates in range are excluded, same as they are from real attendance.
 * Returns { total, bySubject } where bySubject maps subjectId -> count.
 */
async function countRemainingLectures(user, semesterId, fromDate, toDate) {
  const from = startOfDay(fromDate);
  const to = startOfDay(toDate);
  if (to < from) return { total: 0, bySubject: {} };

  const slots = await TimetableSlot.find({ user: user._id, semester: semesterId }).lean();
  if (!slots.length) return { total: 0, bySubject: {} };

  const slotsByDay = new Map();
  for (const slot of slots) {
    if (!slotsByDay.has(slot.day)) slotsByDay.set(slot.day, []);
    slotsByDay.get(slot.day).push(slot);
  }

  const [holidays, exams] = await Promise.all([
    Holiday.find({ user: user._id, date: { $gte: from, $lte: to } }).select('date').lean(),
    Exam.find({ user: user._id, date: { $gte: from, $lte: to } }).select('date').lean(),
  ]);
  const excludedDates = new Set(
    [...holidays, ...exams].map((h) => startOfDay(h.date).toISOString().slice(0, 10))
  );

  let total = 0;
  const bySubject = {};
  for (let d = new Date(from); d <= to; d.setDate(d.getDate() + 1)) {
    if (excludedDates.has(d.toISOString().slice(0, 10))) continue;
    const daySlots = slotsByDay.get(DAY_NAMES[d.getDay()]);
    if (!daySlots) continue;
    total += daySlots.length;
    for (const slot of daySlots) {
      const key = slot.subject.toString();
      bySubject[key] = (bySubject[key] || 0) + 1;
    }
  }
  return { total, bySubject };
}

/**
 * Given current totals + a target %, reports whether hitting that target is
 * still mathematically reachable by the semester's end date (attending
 * every single remaining lecture), and what the best-case final percentage
 * would be either way. Returns null if the semester has no end date set —
 * callers should omit the field entirely in that case rather than guessing.
 */
function achievability(attended, conducted, targetPct, remainingCount) {
  const bestPossible = engine.percentage(attended + remainingCount, conducted + remainingCount);
  return { remainingLectures: remainingCount, achievable: bestPossible >= targetPct, bestPossiblePercentage: bestPossible };
}

const overview = asyncHandler(async (req, res) => {
  const semester = await Semester.findById(req.user.currentSemester);
  if (!semester) throw new ApiError(400, 'No active semester');

  const records = await semesterRecords(req.user, semester._id);
  const overall = engine.summarize(records);

  const now = new Date();
  const monthRecords = records.filter((r) => {
    const d = new Date(r.date);
    return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
  });
  const monthly = engine.summarize(monthRecords);

  const requiredPct = semester.requiredAttendancePercentage;
  const safeBunks = engine.safeBunksRemaining(overall.attended, overall.conducted, requiredPct);
  const neededFor75 = engine.lecturesNeededForTarget(overall.attended, overall.conducted, requiredPct);

  const todayRecords = await ensureLecturesForDate(req.user, now);
  const todayAttendance = engine.summarize(todayRecords);

  // Only meaningful once the semester has an end date (see Settings) — the
  // "X% must be reached within the semester's date range" mapping.
  let semesterEndInfo = null;
  if (semester.endDate) {
    const today = startOfDay(now);
    const end = startOfDay(semester.endDate);
    const daysRemaining = Math.max(0, Math.ceil((end - today) / 86400000));
    const { total: remainingLectures } = end >= today
      ? await countRemainingLectures(req.user, semester._id, today, end)
      : { total: 0 };
    semesterEndInfo = {
      endDate: semester.endDate,
      daysRemaining,
      ended: end < today,
      ...achievability(overall.attended, overall.conducted, requiredPct, remainingLectures),
    };
  }

  res.json({
    overall,
    monthly,
    requiredAttendancePercentage: requiredPct,
    danger: overall.percentage < requiredPct,
    monthlyDanger: monthly.percentage < requiredPct,
    safeBunksRemaining: safeBunks,
    lecturesNeededForTarget: neededFor75,
    semesterEndInfo,
    today: {
      lectures: todayRecords,
      summary: todayAttendance,
    },
  });
});

const subjectAnalytics = asyncHandler(async (req, res) => {
  const semester = await Semester.findById(req.user.currentSemester);
  const records = await semesterRecords(req.user, semester._id);
  const subjects = await Subject.find({ user: req.user._id, semester: semester._id });

  const bySubjectId = engine.groupSummarize(records, (r) => r.subject.toString());

  let remainingBySubject = {};
  if (semester.endDate) {
    const today = startOfDay(new Date());
    const end = startOfDay(semester.endDate);
    if (end >= today) {
      ({ bySubject: remainingBySubject } = await countRemainingLectures(req.user, semester._id, today, end));
    }
  }

  const result = subjects.map((s) => {
    const stats = bySubjectId[s._id.toString()] || engine.summarize([]);
    const remaining = remainingBySubject[s._id.toString()] || 0;
    return {
      subject: { id: s._id, name: s.name, code: s.code, facultyName: s.facultyName },
      ...stats,
      safeBunksRemaining: engine.safeBunksRemaining(stats.attended, stats.conducted, semester.requiredAttendancePercentage),
      lecturesNeeded: engine.lecturesNeededForTarget(stats.attended, stats.conducted, semester.requiredAttendancePercentage),
      achievability: semester.endDate
        ? achievability(stats.attended, stats.conducted, semester.requiredAttendancePercentage, remaining)
        : null,
    };
  });

  res.json({ subjects: result });
});

const facultyAnalytics = asyncHandler(async (req, res) => {
  const semester = await Semester.findById(req.user.currentSemester);
  const records = await semesterRecords(req.user, semester._id);

  const byFaculty = engine.groupSummarize(records, (r) => r.facultyName || 'Unknown');
  const ranked = Object.entries(byFaculty)
    .map(([facultyName, stats]) => ({ facultyName, ...stats }))
    .sort((a, b) => b.percentage - a.percentage);

  res.json({
    faculty: ranked,
    mostAttended: ranked[0] || null,
    mostBunked: [...ranked].sort((a, b) => b.bunked - a.bunked)[0] || null,
  });
});

/**
 * Overview + subject breakdown for ANY semester the user owns (active or
 * archived) — the current-semester endpoints above always read
 * req.user.currentSemester, which can't show a past semester's numbers.
 * Used by Settings > "click a past semester to see its details".
 */
const semesterOverview = asyncHandler(async (req, res) => {
  const semester = await Semester.findOne({ _id: req.params.semesterId, user: req.user._id });
  if (!semester) throw new ApiError(404, 'Semester not found');

  const records = await semesterRecords(req.user, semester._id);
  const overall = engine.summarize(records);
  const requiredPct = semester.requiredAttendancePercentage;

  const subjects = await Subject.find({ user: req.user._id, semester: semester._id });
  const bySubjectId = engine.groupSummarize(records, (r) => r.subject.toString());
  const subjectBreakdown = subjects.map((s) => {
    const stats = bySubjectId[s._id.toString()] || engine.summarize([]);
    return { subject: { id: s._id, name: s.name, code: s.code, facultyName: s.facultyName }, ...stats };
  });

  res.json({
    semester,
    overall,
    requiredAttendancePercentage: requiredPct,
    danger: overall.percentage < requiredPct,
    subjects: subjectBreakdown,
  });
});

const monthlyReport = asyncHandler(async (req, res) => {
  const semester = await Semester.findById(req.user.currentSemester);
  const records = await semesterRecords(req.user, semester._id);

  const byMonth = engine.groupSummarize(records, (r) => {
    const d = new Date(r.date);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  });

  res.json({ months: byMonth });
});

const calendar = asyncHandler(async (req, res) => {
  const { month, year } = req.query; // month: 1-12
  if (!month || !year) throw new ApiError(400, 'month and year query params are required');

  const start = new Date(Number(year), Number(month) - 1, 1);
  const end = new Date(Number(year), Number(month), 0, 23, 59, 59, 999);

  const records = await LectureRecord.find({
    user: req.user._id,
    date: { $gte: start, $lte: end },
  }).lean();

  const byDate = engine.groupSummarize(records, (r) => new Date(r.date).toISOString().slice(0, 10));

  // Color classification per spec: Green=attended day, Red=bunked present, Grey=holiday, Blue=today
  const todayStr = startOfDay(new Date()).toISOString().slice(0, 10);
  const days = Object.entries(byDate).map(([date, stats]) => {
    let color = 'green';
    if (stats.conducted === 0) color = 'grey'; // fully holiday/cancelled day
    else if (stats.bunked > 0) color = 'red';
    if (date === todayStr) color = 'blue';
    return { date, ...stats, color };
  });

  res.json({ days });
});

// ---------------------------------------------------------------------------
// Smart Calculator / Predictor / Simulator
// ---------------------------------------------------------------------------

const smartCalculator = asyncHandler(async (req, res) => {
  const semester = await Semester.findById(req.user.currentSemester);
  const records = await semesterRecords(req.user, semester._id);
  const { attended, conducted } = engine.summarize(records);

  res.json({
    current: engine.summarize(records),
    nextLectureProjection: engine.projectNextLecture(attended, conducted),
    lecturesNeededForTargets: engine.lecturesNeededForTargets(attended, conducted, [75, 80, 85, 90]),
    safeBunksRemaining: engine.safeBunksRemaining(attended, conducted, semester.requiredAttendancePercentage),
  });
});

/**
 * Future Lecture Simulator: reads the timetable for the given future date
 * and simulates bunking vs attending every lecture that day.
 */
const futureSimulator = asyncHandler(async (req, res) => {
  const { date } = req.query;
  if (!date) throw new ApiError(400, 'date query param is required');

  const semester = await Semester.findById(req.user.currentSemester);
  const records = await semesterRecords(req.user, semester._id);
  const { attended, conducted } = engine.summarize(records);

  const day = startOfDay(new Date(date));
  if (semester.endDate && day > startOfDay(semester.endDate)) {
    throw new ApiError(400, `That date is after "${semester.name}" ends on ${startOfDay(semester.endDate).toISOString().slice(0, 10)}`);
  }
  const dayName = DAY_NAMES[day.getDay()];
  const [slots, holiday] = await Promise.all([
    TimetableSlot.find({ user: req.user._id, semester: semester._id, day: dayName }),
    Holiday.findOne({ user: req.user._id, date: day }),
  ]);

  const upcomingCount = holiday ? 0 : slots.length;
  const simulation = engine.simulateFuture(attended, conducted, upcomingCount, semester.requiredAttendancePercentage);

  res.json({ date, upcomingLectureCount: upcomingCount, isHoliday: !!holiday, ...simulation });
});

/** AI Smart Insights: rule-based, generated from real attendance data (no external AI call needed). */
const insights = asyncHandler(async (req, res) => {
  const semester = await Semester.findById(req.user.currentSemester);
  const records = await semesterRecords(req.user, semester._id);
  const requiredPct = semester.requiredAttendancePercentage;

  const overall = engine.summarize(records);
  const bySubject = engine.groupSummarize(records, (r) => r.subject.toString());
  const subjects = await Subject.find({ user: req.user._id, semester: semester._id });
  const subjectNameById = new Map(subjects.map((s) => [s._id.toString(), s.name]));

  const messages = [];

  const safeBunks = engine.safeBunksRemaining(overall.attended, overall.conducted, requiredPct);
  if (safeBunks > 0) messages.push(`You can safely bunk ${safeBunks} more lecture(s) and stay above ${requiredPct}%.`);

  const needed = engine.lecturesNeededForTarget(overall.attended, overall.conducted, requiredPct);
  if (needed > 0) messages.push(`Attend the next ${needed} lecture(s) to reach ${requiredPct}%.`);

  for (const [subjectId, stats] of Object.entries(bySubject)) {
    const name = subjectNameById.get(subjectId) || 'A subject';
    if (stats.conducted >= 3 && stats.percentage < requiredPct) {
      messages.push(`${name} attendance is low (${stats.percentage}%).`);
    } else if (stats.conducted >= 3 && stats.percentage >= 95) {
      messages.push(`${name} attendance is excellent (${stats.percentage}%).`);
    }
  }

  const dayPattern = engine.dayOfWeekBunkPattern(records);
  if (dayPattern.worstDay !== null && dayPattern.worstBunkRate > 0) {
    const dayNameCap = DAY_NAMES[dayPattern.worstDay];
    messages.push(`${dayNameCap.charAt(0).toUpperCase() + dayNameCap.slice(1)} has your highest bunk rate.`);
  }

  const proj = engine.projectNextLecture(overall.attended, overall.conducted);
  messages.push(`If you bunk your next lecture, attendance becomes ${proj.ifBunked}%.`);

  res.json({ insights: messages });
});

module.exports = {
  getDayLectures,
  addExtraLecture,
  markLecture,
  markDay,
  backfillBunks,
  overview,
  semesterOverview,
  subjectAnalytics,
  facultyAnalytics,
  monthlyReport,
  calendar,
  smartCalculator,
  futureSimulator,
  insights,
  _internal: { ensureLecturesForDate, startOfDay, endOfDay },
};
