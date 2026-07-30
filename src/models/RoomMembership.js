'use strict';

const mongoose = require('mongoose');

const roomMembershipSchema = new mongoose.Schema(
  {
    room: { type: mongoose.Schema.Types.ObjectId, ref: 'Room', required: true, index: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  },
  { timestamps: true }
);

roomMembershipSchema.index({ room: 1, user: 1 }, { unique: true });

module.exports = mongoose.model('RoomMembership', roomMembershipSchema);
