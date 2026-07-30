'use strict';

const mongoose = require('mongoose');

const subjectSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    semester: { type: mongoose.Schema.Types.ObjectId, ref: 'Semester', required: true, index: true },
    name: { type: String, required: true, trim: true },
    code: { type: String, trim: true },
    facultyName: { type: String, trim: true, index: true },
    credits: { type: Number, min: 0 },
    weeklyLectureCount: { type: Number, min: 0, default: 0 },
    isActive: { type: Boolean, default: true },
    // Set when this subject was copied in via a Room join/sync (see
    // services/roomService.js) rather than added by hand — lets the sync
    // tell "still matches the room's template" apart from "user's own".
    syncedFromRoom: { type: mongoose.Schema.Types.ObjectId, ref: 'Room' },
  },
  { timestamps: true }
);

subjectSchema.index({ user: 1, semester: 1, name: 1 }, { unique: true });
subjectSchema.index({ user: 1, name: 'text', facultyName: 'text' }); // for search

module.exports = mongoose.model('Subject', subjectSchema);
