'use strict';

const express = require('express');
const { body, param } = require('express-validator');
const ctrl = require('../controllers/holidayController');
const { validate } = require('../middleware/validate');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

router.get('/', ctrl.list);
router.post(
  '/',
  [body('date').isISO8601(), body('name').trim().notEmpty(), body('type').optional().isIn(['manual', 'college', 'national'])],
  validate,
  ctrl.create
);
router.delete('/:id', [param('id').isMongoId()], validate, ctrl.remove);

module.exports = router;
