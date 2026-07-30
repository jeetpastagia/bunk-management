'use strict';

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const { EMAIL_PATTERN, PHONE_PATTERN } = require('../utils/identifier');

const userSchema = new mongoose.Schema(
  {
    studentName: { type: String, trim: true },
    // A user has at least one of these (enforced below), set from whichever
    // they signed up with via the combined email/phone login box.
    mobileNumber: {
      type: String,
      unique: true,
      sparse: true,
      trim: true,
      match: [PHONE_PATTERN, 'Enter a valid mobile number'],
      index: true,
    },
    email: {
      type: String,
      unique: true,
      sparse: true,
      trim: true,
      lowercase: true,
      match: [EMAIL_PATTERN, 'Enter a valid email address'],
    },
    googleId: { type: String, unique: true, sparse: true, index: true },
    passwordHash: { type: String, select: false }, // not required: Google sign-in accounts have no password

    // First-time setup fields
    collegeName: { type: String, trim: true },
    currentSemester: { type: mongoose.Schema.Types.ObjectId, ref: 'Semester' },
    setupCompleted: { type: Boolean, default: false },

    requiredAttendancePercentage: { type: Number, default: 75, min: 0, max: 100 },

    // OTP for forgot-password flow
    otp: {
      codeHash: { type: String, select: false },
      expiresAt: { type: Date, select: false },
      attempts: { type: Number, default: 0, select: false },
    },

    role: { type: String, enum: ['user', 'admin'], default: 'user' },
    isActive: { type: Boolean, default: true },

    fcmTokens: [{ type: String }], // for push notifications, one per device
  },
  { timestamps: true }
);

userSchema.pre('validate', function enforceIdentifier(next) {
  if (!this.email && !this.mobileNumber && !this.googleId) {
    this.invalidate('email', 'Either an email, a mobile number, or a Google account is required');
  }
  next();
});

userSchema.methods.setPassword = async function setPassword(plainPassword) {
  const salt = await bcrypt.genSalt(12);
  this.passwordHash = await bcrypt.hash(plainPassword, salt);
};

userSchema.methods.comparePassword = function comparePassword(plainPassword) {
  if (!this.passwordHash) return false; // Google-only account, no password set
  return bcrypt.compare(plainPassword, this.passwordHash);
};

userSchema.methods.setOtp = async function setOtp(code, ttlMinutes = 10) {
  const salt = await bcrypt.genSalt(10);
  this.otp = {
    codeHash: await bcrypt.hash(code, salt),
    expiresAt: new Date(Date.now() + ttlMinutes * 60 * 1000),
    attempts: 0,
  };
};

userSchema.methods.verifyOtp = async function verifyOtp(code) {
  if (!this.otp || !this.otp.codeHash || !this.otp.expiresAt) return false;
  if (this.otp.expiresAt.getTime() < Date.now()) return false;
  if (this.otp.attempts >= 5) return false;
  const match = await bcrypt.compare(code, this.otp.codeHash);
  if (!match) {
    this.otp.attempts = (this.otp.attempts || 0) + 1;
    await this.save();
  }
  return match;
};

userSchema.methods.clearOtp = function clearOtp() {
  this.otp = undefined;
};

userSchema.methods.toSafeJSON = function toSafeJSON() {
  const obj = this.toObject();
  delete obj.passwordHash;
  delete obj.otp;
  delete obj.__v;
  return obj;
};

module.exports = mongoose.model('User', userSchema);
