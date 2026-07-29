'use strict';

const express = require('express');
const { body } = require('express-validator');
const ctrl = require('../controllers/timetableController');
const { validate } = require('../middleware/validate');
const { requireAuth } = require('../middleware/auth');
const { DAYS } = require('../models/TimetableSlot');

const router = express.Router();
router.use(requireAuth);

router.get('/', ctrl.getTimetable);
router.get('/weekly-analysis', ctrl.weeklyAnalysis);

router.post(
  '/',
  [
    body('slots').isArray(),
    body('slots.*.day').isIn(DAYS),
    body('slots.*.lectureNumber').isInt({ min: 1 }),
    body('slots.*.subject').isMongoId(),
  ],
  validate,
  ctrl.setTimetable
);

module.exports = router;
