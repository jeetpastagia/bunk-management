'use strict';

const express = require('express');
const { body } = require('express-validator');
const ctrl = require('../controllers/authController');
const { validate } = require('../middleware/validate');
const { requireAuth } = require('../middleware/auth');
const { authLimiter } = require('../middleware/rateLimiters');

const router = express.Router();

const mobileRule = body('mobileNumber')
  .trim()
  .matches(/^\+?[0-9]{10,15}$/)
  .withMessage('Enter a valid mobile number');

router.post(
  '/signup',
  authLimiter,
  [
    mobileRule,
    body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
    body('studentName').optional().trim().isLength({ min: 1 }),
  ],
  validate,
  ctrl.signup
);

router.post(
  '/login',
  authLimiter,
  [mobileRule, body('password').notEmpty()],
  validate,
  ctrl.login
);

router.post('/forgot-password/request-otp', authLimiter, [mobileRule], validate, ctrl.requestOtp);

router.post(
  '/forgot-password/reset',
  authLimiter,
  [
    mobileRule,
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
    body('collegeName').optional().trim(),
  ],
  validate,
  ctrl.updateMe
);
router.post('/logout', requireAuth, ctrl.logout);

module.exports = router;
