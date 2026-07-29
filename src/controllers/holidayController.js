'use strict';

const Holiday = require('../models/Holiday');
const LectureRecord = require('../models/LectureRecord');
const { ApiError, asyncHandler } = require('../middleware/errorHandler');

function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

const create = asyncHandler(async (req, res) => {
  const { date, name, type } = req.body;
  const day = startOfDay(date);

  const holiday = await Holiday.create({ user: req.user._id, date: day, name, type });

  // Retroactively mark any already-generated lecture records that day as holiday
  // so it never affects attendance, per spec ("Holiday lectures should not affect attendance").
  await LectureRecord.updateMany(
    { user: req.user._id, date: day, status: { $in: ['pending'] } },
    { status: 'holiday' }
  );

  res.status(201).json({ holiday });
});

const list = asyncHandler(async (req, res) => {
  const holidays = await Holiday.find({ user: req.user._id }).sort({ date: 1 });
  res.json({ holidays });
});

const remove = asyncHandler(async (req, res) => {
  const holiday = await Holiday.findOneAndDelete({ _id: req.params.id, user: req.user._id });
  if (!holiday) throw new ApiError(404, 'Holiday not found');
  res.json({ message: 'Holiday removed' });
});

module.exports = { create, list, remove };
