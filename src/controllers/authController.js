'use strict';

const crypto = require('crypto');
const User = require('../models/User');
const { signToken } = require('../middleware/auth');
const { ApiError, asyncHandler } = require('../middleware/errorHandler');

/**
 * OTP delivery is intentionally abstracted behind this function. Wire it
 * to an SMS provider (Twilio, MSG91, etc.) in production. For now it logs
 * the OTP server-side so the flow is fully testable end-to-end without a
 * paid SMS account.
 */
async function deliverOtp(mobileNumber, code) {
  // eslint-disable-next-line no-console
  console.log(`[OTP] Sending ${code} to ${mobileNumber} (wire a real SMS provider here)`);
}

const signup = asyncHandler(async (req, res) => {
  const { mobileNumber, password, studentName } = req.body;

  const existing = await User.findOne({ mobileNumber });
  if (existing) {
    throw new ApiError(409, 'An account with this mobile number already exists');
  }

  const user = new User({ mobileNumber, studentName });
  await user.setPassword(password);
  await user.save();

  const token = signToken(user);
  res.status(201).json({ token, user: user.toSafeJSON() });
});

const login = asyncHandler(async (req, res) => {
  const { mobileNumber, password } = req.body;

  const user = await User.findOne({ mobileNumber }).select('+passwordHash');
  if (!user || !(await user.comparePassword(password))) {
    throw new ApiError(401, 'Invalid mobile number or password');
  }
  if (!user.isActive) {
    throw new ApiError(403, 'This account has been deactivated');
  }

  const token = signToken(user);
  res.json({ token, user: user.toSafeJSON() });
});

const requestOtp = asyncHandler(async (req, res) => {
  const { mobileNumber } = req.body;
  const user = await User.findOne({ mobileNumber });

  // Always respond the same way whether or not the account exists, to
  // avoid leaking which mobile numbers are registered.
  if (user) {
    const code = crypto.randomInt(100000, 999999).toString();
    await user.setOtp(code, 10);
    await user.save();
    await deliverOtp(mobileNumber, code);
  }

  res.json({ message: 'If that account exists, an OTP has been sent.' });
});

const resetPasswordWithOtp = asyncHandler(async (req, res) => {
  const { mobileNumber, otp, newPassword } = req.body;

  const user = await User.findOne({ mobileNumber }).select('+otp.codeHash +otp.expiresAt +otp.attempts');
  if (!user) {
    throw new ApiError(400, 'Invalid OTP or mobile number');
  }

  const valid = await user.verifyOtp(otp);
  if (!valid) {
    throw new ApiError(400, 'Invalid or expired OTP');
  }

  await user.setPassword(newPassword);
  user.clearOtp();
  await user.save();

  res.json({ message: 'Password reset successfully. Please log in.' });
});

const me = asyncHandler(async (req, res) => {
  res.json({ user: req.user.toSafeJSON() });
});

const updateMe = asyncHandler(async (req, res) => {
  const { studentName, mobileNumber, collegeName } = req.body;

  if (mobileNumber && mobileNumber !== req.user.mobileNumber) {
    const existing = await User.findOne({ mobileNumber });
    if (existing) throw new ApiError(409, 'That mobile number is already in use by another account');
    req.user.mobileNumber = mobileNumber;
  }
  if (studentName !== undefined) req.user.studentName = studentName;
  if (collegeName !== undefined) req.user.collegeName = collegeName;

  await req.user.save();
  res.json({ user: req.user.toSafeJSON() });
});

const logout = asyncHandler(async (req, res) => {
  // Stateless JWT: logout is a client-side token discard. If a device
  // token was supplied, unregister it from push notifications.
  const { fcmToken } = req.body || {};
  if (fcmToken) {
    req.user.fcmTokens = req.user.fcmTokens.filter((t) => t !== fcmToken);
    await req.user.save();
  }
  res.json({ message: 'Logged out' });
});

module.exports = { signup, login, requestOtp, resetPasswordWithOtp, me, updateMe, logout };
