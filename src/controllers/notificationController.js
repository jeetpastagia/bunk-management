'use strict';

const Notification = require('../models/Notification');
const { ApiError, asyncHandler } = require('../middleware/errorHandler');

const registerToken = asyncHandler(async (req, res) => {
  const { fcmToken } = req.body;
  if (!req.user.fcmTokens.includes(fcmToken)) {
    req.user.fcmTokens.push(fcmToken);
    await req.user.save();
  }
  res.status(201).json({ fcmTokens: req.user.fcmTokens });
});

const removeToken = asyncHandler(async (req, res) => {
  const { fcmToken } = req.body;
  req.user.fcmTokens = req.user.fcmTokens.filter((t) => t !== fcmToken);
  await req.user.save();
  res.json({ fcmTokens: req.user.fcmTokens });
});

const list = asyncHandler(async (req, res) => {
  const { unreadOnly, limit = 30, page = 1 } = req.query;
  const filter = { user: req.user._id };
  if (unreadOnly === 'true') filter.read = false;

  const pageNum = Math.max(1, Number(page));
  const limitNum = Math.min(100, Math.max(1, Number(limit)));

  const [notifications, total, unreadCount] = await Promise.all([
    Notification.find(filter)
      .sort({ sentAt: -1 })
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum),
    Notification.countDocuments(filter),
    Notification.countDocuments({ user: req.user._id, read: false }),
  ]);

  res.json({ notifications, total, page: pageNum, limit: limitNum, unreadCount });
});

const unreadCount = asyncHandler(async (req, res) => {
  const count = await Notification.countDocuments({ user: req.user._id, read: false });
  res.json({ unreadCount: count });
});

const markRead = asyncHandler(async (req, res) => {
  const notification = await Notification.findOneAndUpdate(
    { _id: req.params.id, user: req.user._id },
    { read: true },
    { new: true }
  );
  if (!notification) throw new ApiError(404, 'Notification not found');
  res.json({ notification });
});

const markAllRead = asyncHandler(async (req, res) => {
  await Notification.updateMany({ user: req.user._id, read: false }, { read: true });
  res.json({ message: 'All notifications marked as read' });
});

module.exports = { registerToken, removeToken, list, unreadCount, markRead, markAllRead };
