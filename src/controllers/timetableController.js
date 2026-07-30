'use strict';

const TimetableSlot = require('../models/TimetableSlot');
const Subject = require('../models/Subject');
const { ApiError, asyncHandler } = require('../middleware/errorHandler');
const roomService = require('../services/roomService');

/** Replace the entire weekly timetable in one call (typical "manual setup" UX). */
const setTimetable = asyncHandler(async (req, res) => {
  const { slots } = req.body; // [{day, lectureNumber, subject, startTime, endTime}]
  if (!Array.isArray(slots)) throw new ApiError(400, 'Provide a "slots" array');

  const subjectIds = [...new Set(slots.map((s) => s.subject))];
  const ownedCount = await Subject.countDocuments({
    _id: { $in: subjectIds },
    user: req.user._id,
    semester: req.user.currentSemester,
  });
  if (ownedCount !== subjectIds.length) {
    throw new ApiError(400, 'One or more subjects do not belong to your current semester');
  }

  await TimetableSlot.deleteMany({ user: req.user._id, semester: req.user.currentSemester });

  const docs = slots.map((s) => ({
    user: req.user._id,
    semester: req.user.currentSemester,
    day: s.day,
    lectureNumber: s.lectureNumber,
    subject: s.subject,
    startTime: s.startTime,
    endTime: s.endTime,
  }));

  const created = docs.length ? await TimetableSlot.insertMany(docs) : [];
  await roomService.syncOwnedRoomsForSemester(req.user._id, req.user.currentSemester);
  res.status(201).json({ slots: created });
});

const getTimetable = asyncHandler(async (req, res) => {
  const slots = await TimetableSlot.find({ user: req.user._id, semester: req.user.currentSemester })
    .populate('subject', 'name code facultyName')
    .sort({ day: 1, lectureNumber: 1 });
  res.json({ slots });
});

/**
 * Weekly Analysis: total lecture count and subject-wise weekly counts,
 * derived directly from the timetable template (no attendance data needed).
 */
const weeklyAnalysis = asyncHandler(async (req, res) => {
  const slots = await TimetableSlot.find({ user: req.user._id, semester: req.user.currentSemester }).populate(
    'subject',
    'name'
  );

  const tally = {};
  for (const slot of slots) {
    const name = slot.subject ? slot.subject.name : 'Unknown';
    tally[name] = (tally[name] || 0) + 1;
  }

  res.json({ totalWeeklyLectures: slots.length, subjectWise: tally });
});

module.exports = { setTimetable, getTimetable, weeklyAnalysis };
