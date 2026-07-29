'use strict';

const express = require('express');
const { body, param } = require('express-validator');
const ctrl = require('../controllers/subjectController');
const { validate } = require('../middleware/validate');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const subjectBodyRules = [
  body('name').trim().notEmpty().withMessage('Subject name is required'),
  body('code').optional().trim(),
  body('facultyName').optional().trim(),
  body('credits').optional().isFloat({ min: 0 }),
  body('weeklyLectureCount').optional().isInt({ min: 0 }),
];

router.get('/', ctrl.list);
router.post('/', subjectBodyRules, validate, ctrl.create);
router.post('/bulk', [body('subjects').isArray({ min: 1 })], validate, ctrl.bulkCreate);
router.put('/:id', [param('id').isMongoId(), ...subjectBodyRules], validate, ctrl.update);
router.delete('/:id', [param('id').isMongoId()], validate, ctrl.remove);

module.exports = router;
