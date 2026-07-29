'use strict';

const jwt = require('jsonwebtoken');
const User = require('../models/User');

/**
 * Verifies the Bearer JWT, loads the user, and attaches it to req.user.
 * Rejects if the user was deactivated after the token was issued.
 */
async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const [scheme, token] = header.split(' ');

    if (scheme !== 'Bearer' || !token) {
      return res.status(401).json({ error: 'Missing or malformed Authorization header' });
    }

    let payload;
    try {
      payload = jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    const user = await User.findById(payload.sub);
    if (!user || !user.isActive) {
      return res.status(401).json({ error: 'User no longer exists or is inactive' });
    }

    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

function signToken(user) {
  return jwt.sign({ sub: user._id.toString(), role: user.role }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '30d',
  });
}

module.exports = { requireAuth, requireAdmin, signToken };
