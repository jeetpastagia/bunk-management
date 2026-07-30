/**
 * A single login/signup input box accepts either an email or a mobile
 * number. This pure function decides which one it is (or neither), so the
 * auth controller can look the user up by the right field and route the
 * OTP through the right channel. No DB, no side effects — easy to test
 * exhaustively on its own.
 */

'use strict';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_PATTERN = /^\+?[0-9]{10,15}$/;

/**
 * @param {string} raw
 * @returns {{type: 'email'|'phone'|null, value: string}} value is
 *   trimmed, and lowercased for emails (case-insensitive by convention).
 */
function classifyIdentifier(raw) {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (EMAIL_PATTERN.test(trimmed)) return { type: 'email', value: trimmed.toLowerCase() };
  if (PHONE_PATTERN.test(trimmed)) return { type: 'phone', value: trimmed };
  return { type: null, value: trimmed };
}

module.exports = { classifyIdentifier, EMAIL_PATTERN, PHONE_PATTERN };
