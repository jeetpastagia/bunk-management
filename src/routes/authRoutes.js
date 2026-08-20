'use strict';

const express = require('express');
const { body } = require('express-validator');
const ctrl = require('../controllers/authController');
const { validate } = require('../middleware/validate');
const { requireAuth } = require('../middleware/auth');
const { authLimiter } = require('../middleware/rateLimiters');

const router = express.Router();

// Format itself (email vs phone) is validated inside the controller via
// classifyIdentifier — here we only guard against an empty/missing field.
const identifierRule = body('identifier').trim().notEmpty().withMessage('Enter your email or mobile number');

router.post(
  '/signup',
  authLimiter,
  [
    identifierRule,
    body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
    body('studentName').optional().trim().isLength({ min: 1 }),
  ],
  validate,
  ctrl.signup
);

router.post(
  '/login',
  authLimiter,
  [identifierRule, body('password').notEmpty()],
  validate,
  ctrl.login
);

router.post('/google', authLimiter, [body('credential').notEmpty()], validate, ctrl.googleAuth);

router.post('/forgot-password/request-otp', authLimiter, [identifierRule], validate, ctrl.requestOtp);

router.post(
  '/forgot-password/reset',
  authLimiter,
  [
    identifierRule,
    body('otp').isLength({ min: 6, max: 6 }).withMessage('OTP must be 6 digits'),
    body('newPassword').isLength({ min: 6 }),
  ],
  validate,
  ctrl.resetPasswordWithOtp
);

router.get('/me', requireAuth, ctrl.me);
router.put(
  '/me',
  requireAuth,
  [
    body('studentName').optional().trim().isLength({ min: 1 }),
    body('mobileNumber').optional().trim().matches(/^\+?[0-9]{10,15}$/).withMessage('Enter a valid mobile number'),
    body('email').optional().trim().isEmail().withMessage('Enter a valid email address'),
    body('collegeName').optional().trim(),
    body('theme').optional().isIn(['light', 'dark', 'system']).withMessage('Invalid theme'),
    body('defaultStartPage').optional().isIn(['dashboard', 'timetable', 'rooms']).withMessage('Invalid default page'),
    body('confirmBeforeDelete').optional().isBoolean().withMessage('confirmBeforeDelete must be true/false'),
    body('notificationPrefs').optional().isObject().withMessage('notificationPrefs must be an object'),
    body('notificationPrefs.attendanceWarnings').optional().isBoolean(),
    body('notificationPrefs.roomActivity').optional().isBoolean(),
    body('notificationPrefs.timetableUpdates').optional().isBoolean(),
  ],
  validate,
  ctrl.updateMe
);
router.post('/logout', requireAuth, ctrl.logout);

module.exports = router;
