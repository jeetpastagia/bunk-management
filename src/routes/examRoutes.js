'use strict';

const express = require('express');
const { body, param } = require('express-validator');
const ctrl = require('../controllers/examController');
const { validate } = require('../middleware/validate');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const typeRule = body('type').optional().isIn(['internal', 'midterm', 'final', 'other']);

router.get('/', ctrl.list);
router.post('/', [body('date').isISO8601(), body('name').trim().notEmpty(), typeRule], validate, ctrl.create);
router.post(
  '/range',
  [
    body('startDate').isISO8601(),
    body('endDate').isISO8601(),
    body('name').trim().notEmpty(),
    typeRule,
  ],
  validate,
  ctrl.createRange
);
router.patch(
  '/:id',
  [
    param('id').isMongoId(),
    body('date').optional().isISO8601(),
    body('name').optional().trim().notEmpty(),
    typeRule,
  ],
  validate,
  ctrl.update
);
router.delete('/:id', [param('id').isMongoId()], validate, ctrl.remove);

module.exports = router;
