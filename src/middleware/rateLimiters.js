'use strict';

const rateLimit = require('express-rate-limit');

// Generous general API limiter.
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});

// Tight limiter for auth endpoints to slow down brute-force / OTP abuse.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts, please try again later.' },
});

// Bunk AI calls a paid LLM API per request (unlike the rest of the app,
// which only costs a DB query) — a tighter per-IP cap than the general
// limiter bounds worst-case spend from a runaway client or abuse.
const aiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Bunk AI is getting a lot of questions right now — try again in a few minutes.' },
});

module.exports = { apiLimiter, authLimiter, aiLimiter };
