'use strict';

const express = require('express');
const { body, param } = require('express-validator');
const ctrl = require('../controllers/setupController');
const { validate } = require('../middleware/validate');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const semesterRules = [
  body('semesterName').trim().notEmpty().withMessage('Semester name is required'),
  body('semesterStartDate').isISO8601().withMessage('Semester start date is required (mandatory for attendance calc)'),
  body('semesterEndDate').optional().isISO8601(),
  body('requiredAttendancePercentage').optional().isFloat({ min: 0, max: 100 }),
];

router.post(
  '/',
  [
    body('studentName').trim().notEmpty(),
    body('collegeName').trim().notEmpty(),
    ...semesterRules,
  ],
  validate,
  ctrl.completeSetup
);

router.post('/new-semester', [...semesterRules, body('reuseTimetable').optional().isBoolean()], validate, ctrl.startNewSemester);

router.get('/semesters', ctrl.listSemesters);

router.patch(
  '/semesters/:id',
  [
    param('id').isMongoId(),
    body('name').optional().trim().notEmpty(),
    body('startDate').optional().isISO8601(),
    body('endDate').optional({ nullable: true, checkFalsy: true }).isISO8601(),
    body('requiredAttendancePercentage').optional().isFloat({ min: 0, max: 100 }),
  ],
  validate,
  ctrl.updateSemester
);

router.delete('/semesters/:id', [param('id').isMongoId()], validate, ctrl.deleteSemester);

router.patch(
  '/attendance-threshold',
  [body('requiredAttendancePercentage').isFloat({ min: 0, max: 100 }).withMessage('Must be between 0 and 100')],
  validate,
  ctrl.updateAttendanceThreshold
);

module.exports = router;
