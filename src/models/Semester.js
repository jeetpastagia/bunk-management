'use strict';

const mongoose = require('mongoose');

const semesterSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    name: { type: String, required: true, trim: true },
    startDate: { type: Date, required: true },
    endDate: { type: Date }, // optional, per spec
    requiredAttendancePercentage: { type: Number, default: 75, min: 0, max: 100 },
    status: { type: String, enum: ['active', 'archived'], default: 'active', index: true },
    archivedAt: { type: Date },
  },
  { timestamps: true }
);

semesterSchema.index({ user: 1, status: 1 });

module.exports = mongoose.model('Semester', semesterSchema);
