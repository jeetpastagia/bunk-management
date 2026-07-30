'use strict';

const mongoose = require('mongoose');

const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/**
 * One recurring weekly slot, e.g. "Monday, Lecture 2 -> DBMS, 10:00-11:00".
 * The actual per-date attendance records (LectureRecord) are generated
 * FROM this template when a date is opened/marked — the template itself
 * carries no attendance state.
 */
const timetableSlotSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    semester: { type: mongoose.Schema.Types.ObjectId, ref: 'Semester', required: true, index: true },
    day: { type: String, enum: DAYS, required: true },
    lectureNumber: { type: Number, required: true, min: 1 }, // 1st, 2nd, 3rd... lecture of the day
    subject: { type: mongoose.Schema.Types.ObjectId, ref: 'Subject', required: true },
    startTime: { type: String }, // "HH:mm", optional
    endTime: { type: String }, // "HH:mm", optional
    syncedFromRoom: { type: mongoose.Schema.Types.ObjectId, ref: 'Room' },
  },
  { timestamps: true }
);

timetableSlotSchema.index({ user: 1, semester: 1, day: 1, lectureNumber: 1 }, { unique: true });

module.exports = mongoose.model('TimetableSlot', timetableSlotSchema);
module.exports.DAYS = DAYS;
