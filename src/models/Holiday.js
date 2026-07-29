'use strict';

const mongoose = require('mongoose');

const holidaySchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    date: { type: Date, required: true },
    name: { type: String, trim: true, required: true },
    type: { type: String, enum: ['manual', 'college', 'national'], default: 'manual' },
  },
  { timestamps: true }
);

holidaySchema.index({ user: 1, date: 1 }, { unique: true });

module.exports = mongoose.model('Holiday', holidaySchema);
