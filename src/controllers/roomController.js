'use strict';

const roomService = require('../services/roomService');
const { asyncHandler } = require('../middleware/errorHandler');

const create = asyncHandler(async (req, res) => {
  const room = await roomService.createRoom(req.user, req.body.name);
  res.status(201).json({ room });
});

const join = asyncHandler(async (req, res) => {
  const room = await roomService.joinRoom(req.user, req.body.code);
  res.json({ room, message: 'Joined — subjects and timetable have been copied in.' });
});

const list = asyncHandler(async (req, res) => {
  const rooms = await roomService.listMyRooms(req.user);
  res.json({ rooms });
});

const leave = asyncHandler(async (req, res) => {
  await roomService.leaveRoom(req.user, req.params.id);
  res.json({ message: 'Left the room' });
});

const remove = asyncHandler(async (req, res) => {
  await roomService.deleteRoom(req.user, req.params.id);
  res.json({ message: 'Room deleted' });
});

module.exports = { create, join, list, leave, remove };
