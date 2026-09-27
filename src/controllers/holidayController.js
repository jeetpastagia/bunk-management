'use strict';

const Holiday = require('../models/Holiday');
const LectureRecord = require('../models/LectureRecord');
const { ApiError, asyncHandler } = require('../middleware/errorHandler');

const MAX_RANGE_DAYS = 120; // sanity cap so a typo'd year range can't create thousands of records

function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** Every calendar date from start to end inclusive, as day-truncated Date objects. */
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

  let holiday;
  try {
    holiday = await Holiday.create({ user: req.user._id, date: day, name, type });
  } catch (err) {
    if (Number(err.code) === 11000) throw new ApiError(409, 'A holiday is already registered on that date');
    throw err;
  }

  // Retroactively neutralize every lecture record that date — including ones
  // already marked attended/bunked/extra before the holiday was declared —
  // so a holiday always fully removes that day from attendance calculations,
  // per spec ("Holiday lectures should not affect attendance").
  await LectureRecord.updateMany({ user: req.user._id, date: day }, { status: 'holiday' });

  res.status(201).json({ holiday });
});

/** Group/range holiday: registers every date from startDate to endDate (inclusive) in one call. */
const createRange = asyncHandler(async (req, res) => {
  const { startDate, endDate, name, type } = req.body;
  const start = startOfDay(startDate);
  const end = startOfDay(endDate);
  if (end < start) throw new ApiError(400, 'End date must be on or after the start date');

  const days = eachDayInRange(start, end);
  if (days.length > MAX_RANGE_DAYS) {
    throw new ApiError(400, `Range is too long (${days.length} days) — split it into smaller chunks (max ${MAX_RANGE_DAYS})`);
  }

  const existing = await Holiday.find({ user: req.user._id, date: { $gte: start, $lte: end } }).select('date').lean();
  const existingDates = new Set(existing.map((h) => h.date.toISOString().slice(0, 10)));

  const toCreate = days
    .filter((d) => !existingDates.has(d.toISOString().slice(0, 10)))
    .map((d) => ({ user: req.user._id, date: d, name, type }));

  const created = toCreate.length ? await Holiday.insertMany(toCreate, { ordered: false }) : [];

  if (created.length) {
    await LectureRecord.updateMany(
      { user: req.user._id, date: { $gte: start, $lte: end } },
      { status: 'holiday' }
    );
  }

  res.status(201).json({
    created,
    createdCount: created.length,
    skippedCount: days.length - toCreate.length,
  });
});

const list = asyncHandler(async (req, res) => {
  const holidays = await Holiday.find({ user: req.user._id }).sort({ date: 1 });
  res.json({ holidays });
});

const update = asyncHandler(async (req, res) => {
  const holiday = await Holiday.findOne({ _id: req.params.id, user: req.user._id });
  if (!holiday) throw new ApiError(404, 'Holiday not found');

  const { date, name, type } = req.body;
  const oldDay = holiday.date;
  const newDay = date !== undefined ? startOfDay(date) : oldDay;
  const dateChanged = newDay.getTime() !== oldDay.getTime();

  if (name !== undefined) holiday.name = name;
  if (type !== undefined) holiday.type = type;
  holiday.date = newDay;

  try {
    await holiday.save();
  } catch (err) {
    if (Number(err.code) === 11000) throw new ApiError(409, 'A holiday is already registered on that date');
    throw err;
  }

  if (dateChanged) {
    // Un-neutralize the old date (nothing else should still call it a holiday)...
    await LectureRecord.updateMany({ user: req.user._id, date: oldDay, status: 'holiday' }, { status: 'pending' });
    // ...and neutralize the new one.
    await LectureRecord.updateMany({ user: req.user._id, date: newDay }, { status: 'holiday' });
  }

  res.json({ holiday });
});

const remove = asyncHandler(async (req, res) => {
  const holiday = await Holiday.findOneAndDelete({ _id: req.params.id, user: req.user._id });
  if (!holiday) throw new ApiError(404, 'Holiday not found');

  // Un-neutralize: records that were only 'holiday' because of this entry
  // go back to markable 'pending' now that the day is a normal day again.
  await LectureRecord.updateMany({ user: req.user._id, date: holiday.date, status: 'holiday' }, { status: 'pending' });

  res.json({ message: 'Holiday removed' });
});

module.exports = { create, createRange, list, update, remove };
