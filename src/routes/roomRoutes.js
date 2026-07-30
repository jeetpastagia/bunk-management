'use strict';

const express = require('express');
const { body, param } = require('express-validator');
const ctrl = require('../controllers/roomController');
const { validate } = require('../middleware/validate');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

router.get('/', ctrl.list);
router.post('/', [body('name').trim().notEmpty().withMessage('Room name is required')], validate, ctrl.create);
router.post('/join', [body('code').trim().notEmpty().withMessage('Room code is required')], validate, ctrl.join);
router.post('/:id/leave', [param('id').isMongoId()], validate, ctrl.leave);
router.delete('/:id', [param('id').isMongoId()], validate, ctrl.remove);

module.exports = router;
