'use strict';

const mongoose = require('mongoose');

/**
 * A Room's owner is the single source of truth for its shared subjects +
 * timetable — members get that template copied into their own Subject/
 * TimetableSlot documents (so their attendance marking stays entirely
 * personal), and re-synced whenever the owner changes it. See
 * services/roomService.js for the sync logic.
 */
const roomSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, unique: true, uppercase: true, index: true },
    name: { type: String, required: true, trim: true },
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    semester: { type: mongoose.Schema.Types.ObjectId, ref: 'Semester', required: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Room', roomSchema);
