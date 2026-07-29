'use strict';

const Semester = require('../models/Semester');
const Subject = require('../models/Subject');
const TimetableSlot = require('../models/TimetableSlot');
const { ApiError, asyncHandler } = require('../middleware/errorHandler');

/** First-time setup: create the user's profile fields + first active semester. */
const completeSetup = asyncHandler(async (req, res) => {
  const { studentName, collegeName, semesterName, semesterStartDate, semesterEndDate, requiredAttendancePercentage } =
    req.body;

  const semester = await Semester.create({
    user: req.user._id,
    name: semesterName,
    startDate: new Date(semesterStartDate),
    endDate: semesterEndDate ? new Date(semesterEndDate) : undefined,
    requiredAttendancePercentage: requiredAttendancePercentage || 75,
  });

  req.user.studentName = studentName;
  req.user.collegeName = collegeName;
  req.user.requiredAttendancePercentage = requiredAttendancePercentage || 75;
  req.user.currentSemester = semester._id;
  req.user.setupCompleted = true;
  await req.user.save();

  res.status(201).json({ user: req.user.toSafeJSON(), semester });
});

/**
 * Ends the current semester (archives it) and starts a new one. Optionally
 * reuses the previous semester's subjects and timetable, per spec:
 * "Archive previous semester. Keep reports. Reset attendance. Reuse
 * timetable if user wants."
 * Attendance records are naturally "reset" because all new LectureRecords
 * are scoped to the new semester's id — nothing needs deleting, and old
 * reports remain queryable against the archived semester.
 */
const startNewSemester = asyncHandler(async (req, res) => {
  const { semesterName, semesterStartDate, semesterEndDate, requiredAttendancePercentage, reuseTimetable } = req.body;

  const oldSemester = await Semester.findById(req.user.currentSemester);
  if (!oldSemester) throw new ApiError(400, 'No active semester to archive');

  oldSemester.status = 'archived';
  oldSemester.archivedAt = new Date();
  await oldSemester.save();

  const newSemester = await Semester.create({
    user: req.user._id,
    name: semesterName,
    startDate: new Date(semesterStartDate),
    endDate: semesterEndDate ? new Date(semesterEndDate) : undefined,
    requiredAttendancePercentage: requiredAttendancePercentage || req.user.requiredAttendancePercentage,
  });

  if (reuseTimetable) {
    const oldSubjects = await Subject.find({ user: req.user._id, semester: oldSemester._id });
    const subjectIdMap = new Map();

    for (const s of oldSubjects) {
      const clone = await Subject.create({
        user: req.user._id,
        semester: newSemester._id,
        name: s.name,
        code: s.code,
        facultyName: s.facultyName,
        credits: s.credits,
        weeklyLectureCount: s.weeklyLectureCount,
      });
      subjectIdMap.set(s._id.toString(), clone._id);
    }

    const oldSlots = await TimetableSlot.find({ user: req.user._id, semester: oldSemester._id });
    const newSlots = oldSlots
      .filter((slot) => subjectIdMap.has(slot.subject.toString()))
      .map((slot) => ({
        user: req.user._id,
        semester: newSemester._id,
        day: slot.day,
        lectureNumber: slot.lectureNumber,
        subject: subjectIdMap.get(slot.subject.toString()),
        startTime: slot.startTime,
        endTime: slot.endTime,
      }));

    if (newSlots.length) await TimetableSlot.insertMany(newSlots);
  }

  req.user.currentSemester = newSemester._id;
  await req.user.save();

  res.status(201).json({ archivedSemester: oldSemester, newSemester });
});

const listSemesters = asyncHandler(async (req, res) => {
  const semesters = await Semester.find({ user: req.user._id }).sort({ startDate: -1 });
  res.json({ semesters });
});

module.exports = { completeSetup, startNewSemester, listSemesters };
