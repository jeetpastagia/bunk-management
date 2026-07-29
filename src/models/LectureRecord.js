'use strict';

const mongoose = require('mongoose');

const STATUSES = ['pending', 'attended', 'bunked', 'holiday', 'cancelled', 'extra'];

/**
 * The atomic unit of the whole system. One document = one lecture, on one
 * date, for one subject. Every aggregate number in the app (subject,
 * monthly, semester, overall, faculty) is derived by querying and
 * reducing THESE records through attendanceEngine.js — nothing is stored
 * as a separately-maintained running total, which avoids drift bugs.
 */
const lectureRecordSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    semester: { type: mongoose.Schema.Types.ObjectId, ref: 'Semester', required: true, index: true },
    subject: { type: mongoose.Schema.Types.ObjectId, ref: 'Subject', required: true, index: true },
    facultyName: { type: String, trim: true }, // denormalized snapshot at record-creation time
    date: { type: Date, required: true, index: true },
    lectureNumber: { type: Number, required: true, min: 1 },
    status: { type: String, enum: STATUSES, default: 'pending', index: true },
    sourceSlot: { type: mongoose.Schema.Types.ObjectId, ref: 'TimetableSlot' }, // which template slot generated this
    notes: { type: String, trim: true },
    markedAt: { type: Date },
  },
  { timestamps: true }
);

// One lecture per subject/date/lectureNumber per user — prevents duplicate attendance entries.
lectureRecordSchema.index({ user: 1, date: 1, lectureNumber: 1 }, { unique: true });
lectureRecordSchema.index({ user: 1, subject: 1, date: 1 });
lectureRecordSchema.index({ user: 1, semester: 1, status: 1 });

module.exports = mongoose.model('LectureRecord', lectureRecordSchema);
module.exports.STATUSES = STATUSES;
