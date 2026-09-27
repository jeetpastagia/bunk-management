'use strict';

const mongoose = require('mongoose');

/**
 * An exam-period date. Mirrors Holiday.js in shape and purpose — both are
 * "this date doesn't count toward attendance" markers — but kept as a
 * separate resource (per spec) so exam days show up distinctly from
 * holidays in history/calendar views, via LectureRecord.status = 'exam'
 * instead of 'holiday'.
 */
const examSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    date: { type: Date, required: true },
    name: { type: String, trim: true, required: true },
    type: { type: String, enum: ['internal', 'midterm', 'final', 'other'], default: 'internal' },
  },
  { timestamps: true }
);

examSchema.index({ user: 1, date: 1 }, { unique: true });

module.exports = mongoose.model('Exam', examSchema);
