'use strict';

const mongoose = require('mongoose');

const TYPES = [
  'lecture_reminder',
  'attendance_reminder',
  'below_75_warning',
  'close_to_75_warning',
  'missed_attendance',
  'daily_summary',
  'room_activity',
  'timetable_update',
];

/**
 * A record of a notification that was (or is about to be) delivered to a
 * user, both for the in-app notifications list and as the dedup ledger for
 * the scheduler — `dedupeKey` is unique per user so a cron tick that fires
 * twice for the same condition on the same day can't double-send. Content
 * itself is never computed here; jobs compose it from attendanceEngine.js
 * output and pass it straight through.
 */
const notificationSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    type: { type: String, enum: TYPES, required: true },
    title: { type: String, required: true, trim: true },
    body: { type: String, required: true, trim: true },
    data: { type: mongoose.Schema.Types.Mixed },
    dedupeKey: { type: String, required: true },
    read: { type: Boolean, default: false },
    sentAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

// Prevents the same condition (e.g. "below 75% on 2026-07-29") from being
// sent to the same user twice, even under concurrent cron ticks.
notificationSchema.index({ user: 1, dedupeKey: 1 }, { unique: true });
notificationSchema.index({ user: 1, read: 1, sentAt: -1 });

module.exports = mongoose.model('Notification', notificationSchema);
module.exports.TYPES = TYPES;
