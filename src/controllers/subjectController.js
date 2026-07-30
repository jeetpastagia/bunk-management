'use strict';

const Subject = require('../models/Subject');
const TimetableSlot = require('../models/TimetableSlot');
const LectureRecord = require('../models/LectureRecord');
const { ApiError, asyncHandler } = require('../middleware/errorHandler');
const roomService = require('../services/roomService');

const create = asyncHandler(async (req, res) => {
  const subject = await Subject.create({ ...req.body, user: req.user._id, semester: req.user.currentSemester });
  await roomService.syncOwnedRoomsForSemester(req.user._id, req.user.currentSemester);
  res.status(201).json({ subject });
});

/** Bulk add multiple subjects in one call, per spec. */
const bulkCreate = asyncHandler(async (req, res) => {
  const { subjects } = req.body;
  if (!Array.isArray(subjects) || subjects.length === 0) {
    throw new ApiError(400, 'Provide a non-empty "subjects" array');
  }

  const docs = subjects.map((s) => ({ ...s, user: req.user._id, semester: req.user.currentSemester }));
  const created = await Subject.insertMany(docs, { ordered: false });
  await roomService.syncOwnedRoomsForSemester(req.user._id, req.user.currentSemester);
  res.status(201).json({ subjects: created, count: created.length });
});

const list = asyncHandler(async (req, res) => {
  const { search } = req.query;
  const filter = { user: req.user._id, semester: req.user.currentSemester };
  if (search) filter.$text = { $search: search };

  const subjects = await Subject.find(filter).sort({ name: 1 });
  res.json({ subjects });
});

const update = asyncHandler(async (req, res) => {
  const subject = await Subject.findOneAndUpdate(
    { _id: req.params.id, user: req.user._id },
    req.body,
    { new: true, runValidators: true }
  );
  if (!subject) throw new ApiError(404, 'Subject not found');
  await roomService.syncOwnedRoomsForSemester(req.user._id, req.user.currentSemester);
  res.json({ subject });
});

const remove = asyncHandler(async (req, res) => {
  const subject = await Subject.findOne({ _id: req.params.id, user: req.user._id });
  if (!subject) throw new ApiError(404, 'Subject not found');

  // Prevent orphaned data: remove dependent timetable slots + lecture records.
  await Promise.all([
    TimetableSlot.deleteMany({ user: req.user._id, subject: subject._id }),
    LectureRecord.deleteMany({ user: req.user._id, subject: subject._id }),
    subject.deleteOne(),
  ]);
  await roomService.syncOwnedRoomsForSemester(req.user._id, req.user.currentSemester);

  res.json({ message: 'Subject and its dependent timetable/attendance data removed' });
});

module.exports = { create, bulkCreate, list, update, remove };
