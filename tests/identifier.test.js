'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyIdentifier } = require('../src/utils/identifier');

test('classifyIdentifier: recognizes a plain email', () => {
  assert.deepEqual(classifyIdentifier('Student@Example.com'), { type: 'email', value: 'student@example.com' });
});

test('classifyIdentifier: recognizes a 10-digit mobile number', () => {
  assert.deepEqual(classifyIdentifier('9876543210'), { type: 'phone', value: '9876543210' });
});

test('classifyIdentifier: recognizes a mobile number with country code', () => {
  assert.deepEqual(classifyIdentifier('+919876543210'), { type: 'phone', value: '+919876543210' });
});

test('classifyIdentifier: trims surrounding whitespace before classifying', () => {
  assert.deepEqual(classifyIdentifier('  9876543210  '), { type: 'phone', value: '9876543210' });
});

test('classifyIdentifier: neither email nor phone format returns null type', () => {
  assert.equal(classifyIdentifier('not-an-identifier').type, null);
  assert.equal(classifyIdentifier('12345').type, null); // too short for a phone number
  assert.equal(classifyIdentifier('').type, null);
  assert.equal(classifyIdentifier(undefined).type, null);
});
