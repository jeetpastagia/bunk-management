'use strict';

const express = require('express');
const { body, param, query } = require('express-validator');
const ctrl = require('../controllers/notificationController');
const { validate } = require('../middleware/validate');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

router.get(
  '/',
  [
    query('unreadOnly').optional().isBoolean(),
    query('limit').optional().isInt({ min: 1, max: 100 }),
    query('page').optional().isInt({ min: 1 }),
  ],
  validate,
  ctrl.list
);
router.get('/unread-count', ctrl.unreadCount);
router.post('/register-token', [body('fcmToken').isString().trim().notEmpty()], validate, ctrl.registerToken);
router.delete('/token', [body('fcmToken').isString().trim().notEmpty()], validate, ctrl.removeToken);
router.patch('/read-all', ctrl.markAllRead);
router.patch('/:id/read', [param('id').isMongoId()], validate, ctrl.markRead);

module.exports = router;
