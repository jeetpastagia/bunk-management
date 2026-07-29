'use strict';

const express = require('express');
const { body, param, query } = require('express-validator');
const ctrl = require('../controllers/attendanceController');
const { validate } = require('../middleware/validate');
const { requireAuth } = require('../middleware/auth');
const { STATUSES } = require('../models/LectureRecord');

const router = express.Router();
router.use(requireAuth);

router.get('/day/:date', [param('date').isISO8601()], validate, ctrl.getDayLectures);

router.post(
  '/extra',
  [
    body('date').isISO8601(),
    body('subject').isMongoId(),
    body('lectureNumber').isInt({ min: 1 }),
    body('status').optional().isIn(STATUSES),
  ],
  validate,
  ctrl.addExtraLecture
);

router.patch('/:id', [param('id').isMongoId(), body('status').isIn(STATUSES)], validate, ctrl.markLecture);

router.post(
  '/mark-day',
  [body('date').isISO8601(), body('status').isIn(STATUSES)],
  validate,
  ctrl.markDay
);

router.get('/overview', ctrl.overview);
router.get('/subjects', ctrl.subjectAnalytics);
router.get('/faculty', ctrl.facultyAnalytics);
router.get('/reports/monthly', ctrl.monthlyReport);
router.get('/calendar', [query('month').isInt({ min: 1, max: 12 }), query('year').isInt()], validate, ctrl.calendar);

router.get('/calculator', ctrl.smartCalculator);
router.get('/simulate', [query('date').isISO8601()], validate, ctrl.futureSimulator);
router.get('/insights', ctrl.insights);

module.exports = router;
