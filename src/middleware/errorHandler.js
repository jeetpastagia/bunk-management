'use strict';

/** Wrap an async route handler so rejected promises reach the error handler. */
function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

class ApiError extends Error {
  constructor(statusCode, message, details) {
    super(message);
    this.statusCode = statusCode;
    this.details = details;
  }
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (err.name === 'ValidationError') {
    return res.status(400).json({ error: 'Validation failed', details: err.errors });
  }
  if (err.code === 11000) {
    // Global safety net: no matter which route hit this (even one that
    // doesn't specifically translate it, or a future one that forgets
    // to), a real person should never see the raw "Duplicate resource"
    // wording again — it read as a broken app rather than what it
    // actually means.
    const field = err.keyValue && Object.keys(err.keyValue)[0];
    const label = field === 'email' ? 'email' : field === 'mobileNumber' ? 'mobile number' : field === 'googleId' ? 'Google account' : 'information';
    return res.status(409).json({ error: `An account with this ${label} already exists`, details: err.keyValue });
  }
  if (err instanceof ApiError) {
    return res.status(err.statusCode).json({ error: err.message, details: err.details });
  }

  // eslint-disable-next-line no-console
  console.error(err);
  const statusCode = err.statusCode || 500;
  res.status(statusCode).json({
    error: statusCode === 500 ? 'Internal server error' : err.message,
  });
}

function notFound(req, res) {
  res.status(404).json({ error: `Route not found: ${req.method} ${req.originalUrl}` });
}

module.exports = { asyncHandler, ApiError, errorHandler, notFound };
