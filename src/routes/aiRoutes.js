'use strict';

const express = require('express');
const { body } = require('express-validator');
const ctrl = require('../controllers/aiController');
const { validate } = require('../middleware/validate');
const { requireAuth } = require('../middleware/auth');
const { aiLimiter } = require('../middleware/rateLimiters');

const router = express.Router();
router.use(requireAuth);
router.use(aiLimiter);

router.post(
  '/chat',
  [body('messages').isArray({ min: 1 }).withMessage('"messages" must be a non-empty array')],
  validate,
  ctrl.chat
);

module.exports = router;
