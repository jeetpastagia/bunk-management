'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const engine = require('../src/services/notificationEngine');

test('toMinutes: parses HH:mm into minutes since midnight', () => {
  assert.equal(engine.toMinutes('00:00'), 0);
  assert.equal(engine.toMinutes('09:30'), 570);
  assert.equal(engine.toMinutes('23:59'), 1439);
});

test('toMinutes: returns null for unparseable or out-of-range input', () => {
  assert.equal(engine.toMinutes(''), null);
  assert.equal(engine.toMinutes(undefined), null);
  assert.equal(engine.toMinutes('not-a-time'), null);
  assert.equal(engine.toMinutes('24:00'), null);
  assert.equal(engine.toMinutes('10:60'), null);
});

test('shouldFireBelowThreshold: matches attendanceEngine danger classification', () => {
  assert.equal(engine.shouldFireBelowThreshold(70, 75), true);
  assert.equal(engine.shouldFireBelowThreshold(75, 75), false); // exactly at threshold is "risky", not "danger"
  assert.equal(engine.shouldFireBelowThreshold(90, 75), false);
});

test('shouldFireCloseToThreshold: fires only inside the risky cushion band', () => {
  assert.equal(engine.shouldFireCloseToThreshold(75, 75), true); // exactly at threshold
  assert.equal(engine.shouldFireCloseToThreshold(77, 75), true); // within 5pt cushion
  assert.equal(engine.shouldFireCloseToThreshold(70, 75), false); // already below -> below-threshold, not close
  assert.equal(engine.shouldFireCloseToThreshold(85, 75), false); // safely clear of the cushion
});

test('shouldFireAttendanceReminder: fires when a pending lecture has already started', () => {
  const lectures = [
    { status: 'pending', startTime: '09:00' },
    { status: 'attended', startTime: '10:00' },
  ];
  assert.equal(engine.shouldFireAttendanceReminder({ lectures, nowMinutes: engine.toMinutes('09:05') }), true);
});

test('shouldFireAttendanceReminder: does not fire for a pending lecture that has not started yet', () => {
  const lectures = [{ status: 'pending', startTime: '15:00' }];
  assert.equal(engine.shouldFireAttendanceReminder({ lectures, nowMinutes: engine.toMinutes('09:00') }), false);
});

test('shouldFireAttendanceReminder: treats a pending lecture with no startTime as already due', () => {
  const lectures = [{ status: 'pending', startTime: null }];
  assert.equal(engine.shouldFireAttendanceReminder({ lectures, nowMinutes: 0 }), true);
});

test('shouldFireAttendanceReminder: does not fire when every lecture is already marked', () => {
  const lectures = [
    { status: 'attended', startTime: '09:00' },
    { status: 'holiday', startTime: '10:00' },
  ];
  assert.equal(engine.shouldFireAttendanceReminder({ lectures, nowMinutes: 1000 }), false);
});

test('shouldFireMissedAttendanceReminder: fires if any lecture from the day is still pending', () => {
  assert.equal(engine.shouldFireMissedAttendanceReminder([{ status: 'attended' }, { status: 'pending' }]), true);
  assert.equal(engine.shouldFireMissedAttendanceReminder([{ status: 'attended' }, { status: 'bunked' }]), false);
  assert.equal(engine.shouldFireMissedAttendanceReminder([]), false);
});

test('getDueLectureReminders: includes lectures starting within the lead window', () => {
  const lectures = [
    { lectureNumber: 1, status: 'pending', startTime: '09:05' }, // 5 min away
    { lectureNumber: 2, status: 'pending', startTime: '09:20' }, // 20 min away, outside 10-min window
    { lectureNumber: 3, status: 'pending', startTime: '08:55' }, // already started
    { lectureNumber: 4, status: 'attended', startTime: '09:08' }, // already marked
  ];
  const due = engine.getDueLectureReminders({ lectures, nowMinutes: engine.toMinutes('09:00'), leadMinutes: 10 });
  assert.deepEqual(due.map((l) => l.lectureNumber), [1]);
});

test('getDueLectureReminders: a lecture starting exactly now is due (boundary inclusive)', () => {
  const lectures = [{ lectureNumber: 1, status: 'pending', startTime: '09:00' }];
  const due = engine.getDueLectureReminders({ lectures, nowMinutes: engine.toMinutes('09:00'), leadMinutes: 10 });
  assert.equal(due.length, 1);
});

test('getDueLectureReminders: excludes lectures with no startTime', () => {
  const lectures = [{ lectureNumber: 1, status: 'pending', startTime: null }];
  const due = engine.getDueLectureReminders({ lectures, nowMinutes: 0, leadMinutes: 10 });
  assert.equal(due.length, 0);
});

test('dedupeKey: stable, includes date and optional extra discriminator', () => {
  assert.equal(engine.dedupeKey('below_75_warning', '2026-07-29'), 'below_75_warning:2026-07-29');
  assert.equal(engine.dedupeKey('lecture_reminder', '2026-07-29', 'L3'), 'lecture_reminder:2026-07-29:L3');
});

test('buildBelowThresholdMessage: mentions the percentage and requirement', () => {
  const msg = engine.buildBelowThresholdMessage({ percentage: 70, requiredPct: 75, scope: 'overall' });
  assert.ok(msg.body.includes('70%'));
  assert.ok(msg.body.includes('75%'));
});

test('buildCloseThresholdMessage: distinguishes overall vs monthly scope', () => {
  const overall = engine.buildCloseThresholdMessage({ percentage: 77, requiredPct: 75, scope: 'overall' });
  const monthly = engine.buildCloseThresholdMessage({ percentage: 77, requiredPct: 75, scope: 'monthly' });
  assert.notEqual(overall.body, monthly.body);
});

test('buildAttendanceReminderMessage: pluralizes correctly', () => {
  assert.ok(engine.buildAttendanceReminderMessage({ pendingCount: 1 }).body.includes('1 lecture'));
  assert.ok(engine.buildAttendanceReminderMessage({ pendingCount: 3 }).body.includes('3 lectures'));
});

test('buildMissedAttendanceMessage: pluralizes correctly', () => {
  assert.ok(engine.buildMissedAttendanceMessage({ pendingCount: 1 }).body.includes('1 lecture'));
  assert.ok(engine.buildMissedAttendanceMessage({ pendingCount: 2 }).body.includes('2 lectures'));
});

test('buildLectureReminderMessage: includes subject name and start time', () => {
  const msg = engine.buildLectureReminderMessage({ subjectName: 'DBMS', startTime: '10:00', leadMinutes: 10 });
  assert.ok(msg.title.includes('DBMS'));
  assert.ok(msg.body.includes('10:00'));
});

test('buildDailySummaryMessage: handles zero lectures and infinite safe bunks', () => {
  const msg = engine.buildDailySummaryMessage({ todayLectureCount: 0, overallPercentage: 100, safeBunksRemaining: Infinity });
  assert.ok(msg.body.includes('No lectures scheduled today'));
  assert.ok(msg.body.includes('bunk freely'));
});

test('buildDailySummaryMessage: reports lecture count and safe bunks', () => {
  const msg = engine.buildDailySummaryMessage({ todayLectureCount: 4, overallPercentage: 82, safeBunksRemaining: 3 });
  assert.ok(msg.body.includes('4 lectures'));
  assert.ok(msg.body.includes('82%'));
  assert.ok(msg.body.includes('3 more'));
});
