'use strict';

const Exam = require('../models/Exam');
const LectureRecord = require('../models/LectureRecord');
const { ApiError, asyncHandler } = require('../middleware/errorHandler');

const MAX_RANGE_DAYS = 120; // sanity cap so a typo'd year range can't create thousands of records

function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function eachDayInRange(start, end) {
  const days = [];
  const cursor = startOfDay(start);
  const last = startOfDay(end);
  while (cursor <= last) {
    days.push(new Date(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return days;
}

const create = asyncHandler(async (req, res) => {
  const { date, name, type } = req.body;
  const day = startOfDay(date);

  let exam;
  try {
    exam = await Exam.create({ user: req.user._id, date: day, name, type });
  } catch (err) {
    if (Number(err.code) === 11000) throw new ApiError(409, 'An exam is already registered on that date');
    throw err;
  }

  // Same treatment as a holiday: retroactively neutralize the day so it
  // never counts toward attendance, regardless of anything already marked.
  await LectureRecord.updateMany({ user: req.user._id, date: day }, { status: 'exam' });

  res.status(201).json({ exam });
});

const createRange = asyncHandler(async (req, res) => {
  const { startDate, endDate, name, type } = req.body;
  const start = startOfDay(startDate);
  const end = startOfDay(endDate);
  if (end < start) throw new ApiError(400, 'End date must be on or after the start date');

  const days = eachDayInRange(start, end);
  if (days.length > MAX_RANGE_DAYS) {
    throw new ApiError(400, `Range is too long (${days.length} days) — split it into smaller chunks (max ${MAX_RANGE_DAYS})`);
  }

  const existing = await Exam.find({ user: req.user._id, date: { $gte: start, $lte: end } }).select('date').lean();
  const existingDates = new Set(existing.map((e) => e.date.toISOString().slice(0, 10)));

  const toCreate = days
    .filter((d) => !existingDates.has(d.toISOString().slice(0, 10)))
    .map((d) => ({ user: req.user._id, date: d, name, type }));

  const created = toCreate.length ? await Exam.insertMany(toCreate, { ordered: false }) : [];

  if (created.length) {
    await LectureRecord.updateMany({ user: req.user._id, date: { $gte: start, $lte: end } }, { status: 'exam' });
  }

  res.status(201).json({
    created,
    createdCount: created.length,
    skippedCount: days.length - toCreate.length,
  });
});

const list = asyncHandler(async (req, res) => {
  const exams = await Exam.find({ user: req.user._id }).sort({ date: 1 });
  res.json({ exams });
});

const update = asyncHandler(async (req, res) => {
  const exam = await Exam.findOne({ _id: req.params.id, user: req.user._id });
  if (!exam) throw new ApiError(404, 'Exam not found');

  const { date, name, type } = req.body;
  const oldDay = exam.date;
  const newDay = date !== undefined ? startOfDay(date) : oldDay;
  const dateChanged = newDay.getTime() !== oldDay.getTime();

  if (name !== undefined) exam.name = name;
  if (type !== undefined) exam.type = type;
  exam.date = newDay;

  try {
    await exam.save();
  } catch (err) {
    if (Number(err.code) === 11000) throw new ApiError(409, 'An exam is already registered on that date');
    throw err;
  }

  if (dateChanged) {
    await LectureRecord.updateMany({ user: req.user._id, date: oldDay, status: 'exam' }, { status: 'pending' });
    await LectureRecord.updateMany({ user: req.user._id, date: newDay }, { status: 'exam' });
  }

  res.json({ exam });
});

const remove = asyncHandler(async (req, res) => {
  const exam = await Exam.findOneAndDelete({ _id: req.params.id, user: req.user._id });
  if (!exam) throw new ApiError(404, 'Exam not found');

  await LectureRecord.updateMany({ user: req.user._id, date: exam.date, status: 'exam' }, { status: 'pending' });

  res.json({ message: 'Exam removed' });
});

module.exports = { create, createRange, list, update, remove };
