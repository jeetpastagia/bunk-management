'use strict';

const crypto = require('crypto');
const User = require('../models/User');
const { signToken } = require('../middleware/auth');
const { ApiError, asyncHandler } = require('../middleware/errorHandler');
const { classifyIdentifier } = require('../utils/identifier');

/**
 * OTP delivery is intentionally abstracted behind these two functions —
 * wire an SMS provider (Twilio, MSG91) and an email provider (Resend,
 * SES, SMTP) in production. For now both just log server-side so the
 * flow is fully testable end-to-end without a paid account for either.
 */
async function deliverOtpSms(mobileNumber, code) {
  // eslint-disable-next-line no-console
  console.log(`[OTP] Sending ${code} to ${mobileNumber} via SMS (wire a real SMS provider here)`);
}
async function deliverOtpEmail(email, code) {
  // eslint-disable-next-line no-console
  console.log(`[OTP] Sending ${code} to ${email} via email (wire a real email provider here)`);
}

/** Looks up a user by whichever identifier type they entered. Returns null if the input matches neither format. */
function findUserByIdentifier(identifier) {
  const classified = classifyIdentifier(identifier);
  if (classified.type === 'email') return { user: User.findOne({ email: classified.value }), classified };
  if (classified.type === 'phone') return { user: User.findOne({ mobileNumber: classified.value }), classified };
  return { user: null, classified };
}

const signup = asyncHandler(async (req, res) => {
  const { identifier, password, studentName } = req.body;
  const classified = classifyIdentifier(identifier);
  if (!classified.type) throw new ApiError(400, 'Enter a valid email address or mobile number');

  const field = classified.type === 'email' ? 'email' : 'mobileNumber';
  const existing = await User.findOne({ [field]: classified.value });
  if (existing) {
    throw new ApiError(409, 'An account with this email or mobile number already exists');
  }

  const user = new User({ [field]: classified.value, studentName });
  await user.setPassword(password);
  await user.save();

  const token = signToken(user);
  res.status(201).json({ token, user: user.toSafeJSON() });
});

const login = asyncHandler(async (req, res) => {
  const { identifier, password } = req.body;
  const { user: userQuery, classified } = findUserByIdentifier(identifier);
  if (!classified.type) throw new ApiError(400, 'Enter a valid email address or mobile number');

  const user = userQuery ? await userQuery.select('+passwordHash') : null;

  // Distinct messages per failure reason (root cause of the old
  // "Record not found" vs "Already registered" contradiction): that bug
  // happened because a Google-only account (no passwordHash) always fell
  // through to one generic "invalid" message on login, while Register
  // correctly recognised the same email as taken. Google-only accounts now
  // get a message that tells them what actually happened instead.
  if (!user) {
    throw new ApiError(404, 'No account found with that email/mobile number');
  }
  if (!user.passwordHash) {
    throw new ApiError(400, 'This account signed up with Google. Continue with Google, or use "Forgot password" to set a password for it.');
  }
  if (!(await user.comparePassword(password))) {
    throw new ApiError(401, 'Incorrect password');
  }
  if (!user.isActive) {
    throw new ApiError(403, 'This account has been deactivated');
  }

  const token = signToken(user);
  res.json({ token, user: user.toSafeJSON() });
});

const requestOtp = asyncHandler(async (req, res) => {
  const { identifier } = req.body;
  const { user: userQuery, classified } = findUserByIdentifier(identifier);
  const user = userQuery ? await userQuery : null;

  // Always respond the same way whether or not the account exists, to
  // avoid leaking which emails/mobile numbers are registered.
  if (user) {
    const code = crypto.randomInt(100000, 999999).toString();
    await user.setOtp(code, 10);
    await user.save();
    if (classified.type === 'email') await deliverOtpEmail(classified.value, code);
    else await deliverOtpSms(classified.value, code);
  }

  res.json({ message: 'If that account exists, an OTP has been sent.' });
});

const resetPasswordWithOtp = asyncHandler(async (req, res) => {
  const { identifier, otp, newPassword } = req.body;
  const { user: userQuery } = findUserByIdentifier(identifier);

  const user = userQuery ? await userQuery.select('+otp.codeHash +otp.expiresAt +otp.attempts') : null;
  if (!user) {
    throw new ApiError(400, 'Invalid OTP or account');
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

/**
 * Google Sign-In: the frontend uses Google Identity Services to get an ID
 * token straight from Google, then sends just that token here — we verify
 * it against Google's public keys (never trusting a client-supplied email
 * directly) and create/link the account. Requires GOOGLE_CLIENT_ID to be
 * configured; without it this endpoint clearly reports that instead of
 * quietly failing.
 */
const googleAuth = asyncHandler(async (req, res) => {
  const { credential } = req.body;
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    throw new ApiError(501, 'Google Sign-In is not configured on this server yet (GOOGLE_CLIENT_ID missing)');
  }

  // eslint-disable-next-line global-require
  const { OAuth2Client } = require('google-auth-library');
  const client = new OAuth2Client(clientId);

  let payload;
  try {
    const ticket = await client.verifyIdToken({ idToken: credential, audience: clientId });
    payload = ticket.getPayload();
  } catch (err) {
    throw new ApiError(401, 'Invalid Google credential');
  }

  let user = await User.findOne({ googleId: payload.sub });
  if (!user) {
    user = await User.findOne({ email: payload.email });
    if (user) {
      user.googleId = payload.sub;
    } else {
      user = new User({ googleId: payload.sub, email: payload.email, studentName: payload.name });
    }
    await user.save();
  }
  if (!user.isActive) throw new ApiError(403, 'This account has been deactivated');

  const token = signToken(user);
  res.json({ token, user: user.toSafeJSON() });
});

const me = asyncHandler(async (req, res) => {
  res.json({ user: req.user.toSafeJSON() });
});

const updateMe = asyncHandler(async (req, res) => {
  const {
    studentName,
    mobileNumber,
    email,
    collegeName,
    theme,
    notificationPrefs,
    defaultStartPage,
    confirmBeforeDelete,
  } = req.body;

  if (mobileNumber && mobileNumber !== req.user.mobileNumber) {
    const existing = await User.findOne({ mobileNumber });
    if (existing) throw new ApiError(409, 'That mobile number is already in use by another account');
    req.user.mobileNumber = mobileNumber;
  }
  if (email && email.toLowerCase() !== req.user.email) {
    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing) throw new ApiError(409, 'That email is already in use by another account');
    req.user.email = email.toLowerCase();
  }
  if (studentName !== undefined) req.user.studentName = studentName;
  if (collegeName !== undefined) req.user.collegeName = collegeName;
  if (theme !== undefined) req.user.theme = theme;
  if (defaultStartPage !== undefined) req.user.defaultStartPage = defaultStartPage;
  if (confirmBeforeDelete !== undefined) req.user.confirmBeforeDelete = confirmBeforeDelete;
  if (notificationPrefs !== undefined) {
    // .toObject() first: notificationPrefs is a Mongoose nested-subdocument
    // instance, not a plain object — spreading it directly can pick up
    // internal Mongoose properties instead of just the three boolean fields.
    const current = req.user.notificationPrefs?.toObject
      ? req.user.notificationPrefs.toObject()
      : req.user.notificationPrefs || {};
    req.user.notificationPrefs = { ...current, ...notificationPrefs };
  }

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

module.exports = { signup, login, requestOtp, resetPasswordWithOtp, googleAuth, me, updateMe, logout };
