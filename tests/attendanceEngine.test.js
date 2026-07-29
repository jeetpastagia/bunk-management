'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const engine = require('../src/services/attendanceEngine');

test('summarize: basic conducted/attended/percentage', () => {
  const records = [
    { status: 'attended' },
    { status: 'attended' },
    { status: 'bunked' },
    { status: 'holiday' },
    { status: 'cancelled' },
    { status: 'extra' },
  ];
  const s = engine.summarize(records);
  // conducted = attended(2) + bunked(1) + extra(1) = 4
  // attended = attended(2) + extra(1) = 3
  assert.equal(s.conducted, 4);
  assert.equal(s.attended, 3);
  assert.equal(s.bunked, 1);
  assert.equal(s.percentage, 75);
});

test('summarize: empty records gives 0%, not NaN', () => {
  const s = engine.summarize([]);
  assert.equal(s.conducted, 0);
  assert.equal(s.attended, 0);
  assert.equal(s.percentage, 0);
});

test('example from spec: conducted 120, attended 96 => 80%', () => {
  assert.equal(engine.percentage(96, 120), 80);
});

test('groupSummarize: subject-wise breakdown', () => {
  const records = [
    { status: 'attended', subject: 'DBMS' },
    { status: 'bunked', subject: 'DBMS' },
    { status: 'attended', subject: 'Java' },
    { status: 'attended', subject: 'Java' },
  ];
  const bySubject = engine.groupSummarize(records, (r) => r.subject);
  assert.equal(bySubject.DBMS.percentage, 50);
  assert.equal(bySubject.Java.percentage, 100);
});

test('lecturesNeededForTarget: already above target needs 0', () => {
  assert.equal(engine.lecturesNeededForTarget(90, 100, 75), 0);
});

test('lecturesNeededForTarget: classic case matches manual algebra', () => {
  // attended 30, conducted 50 => 60%. Need n such that (30+n)/(50+n) >= 0.75
  // n >= (0.75*50 - 30)/(1-0.75) = (37.5-30)/0.25 = 30
  const n = engine.lecturesNeededForTarget(30, 50, 75);
  assert.equal(n, 30);
  // verify it actually clears the bar
  assert.ok(engine.percentage(30 + n, 50 + n) >= 75);
  // and n-1 does not
  assert.ok(engine.percentage(30 + n - 1, 50 + n - 1) < 75);
});

test('lecturesNeededForTarget: target 100% unreachable unless already perfect', () => {
  assert.equal(engine.lecturesNeededForTarget(9, 10, 100), Infinity);
  assert.equal(engine.lecturesNeededForTarget(10, 10, 100), 0);
});

test('safeBunksRemaining: matches spec example shape (82%, 140 conducted, target 75)', () => {
  const attended = Math.round(0.82 * 140); // 115 (82% of 140 rounds to 114.8 -> 115)
  const conducted = 140;
  const n = engine.safeBunksRemaining(attended, conducted, 75);
  // After bunking n more, percentage must stay >= 75
  assert.ok(engine.percentage(attended, conducted + n) >= 75);
  // One more bunk should drop below 75
  assert.ok(engine.percentage(attended, conducted + n + 1) < 75);
});

test('safeBunksRemaining: at exactly target with 0 conducted buffer', () => {
  // 75/100 = 75% exactly. Bunking even one more drops it.
  const n = engine.safeBunksRemaining(75, 100, 75);
  assert.equal(n, 0);
});

test('projectNextLecture: bunk decreases %, attend increases or holds %', () => {
  const proj = engine.projectNextLecture(75, 100); // currently 75%
  assert.ok(proj.ifBunked < 75);
  assert.ok(proj.ifAttended > 75);
  assert.equal(proj.ifBunked, engine.percentage(75, 101));
  assert.equal(proj.ifAttended, engine.percentage(76, 101));
});

test('lecturesNeededForTargets: returns a value per target', () => {
  const out = engine.lecturesNeededForTargets(30, 50, [75, 80, 85, 90]);
  assert.deepEqual(Object.keys(out).map(Number), [75, 80, 85, 90]);
  // higher targets should need >= lectures than lower targets
  assert.ok(out[80] >= out[75]);
  assert.ok(out[90] >= out[85]);
});

test('simulateFuture: bunking everything can only hurt or hold, attending everything can only help or hold', () => {
  const current = engine.percentage(60, 80); // 75%
  const sim = engine.simulateFuture(60, 80, 10, 75);
  assert.ok(sim.bunkAllScenario.resultingPercentage <= current);
  assert.ok(sim.attendAllScenario.resultingPercentage >= current);
  assert.equal(sim.bunkAllScenario.status, 'danger'); // 60/90 = 66.7% < 75
  assert.equal(sim.attendAllScenario.status, 'risky'); // 70/90 = 77.8%, within the 75-80 cushion band
});

test('classify: safe/risky/danger bands', () => {
  assert.equal(engine.classify(90, 75), 'safe');
  assert.equal(engine.classify(77, 75), 'risky'); // within 5pt cushion
  assert.equal(engine.classify(70, 75), 'danger');
  assert.equal(engine.classify(75, 75), 'risky'); // exactly at threshold, still fragile
  assert.equal(engine.classify(80, 75), 'safe'); // exactly at cushion edge
});

test('dayOfWeekBunkPattern: identifies the worst weekday', () => {
  // Use fixed known dates: Monday 2026-01-05, Tuesday 2026-01-06
  const records = [
    { status: 'bunked', date: '2026-01-05' }, // Monday
    { status: 'bunked', date: '2026-01-05' },
    { status: 'attended', date: '2026-01-06' }, // Tuesday
    { status: 'attended', date: '2026-01-06' },
  ];
  const result = engine.dayOfWeekBunkPattern(records);
  assert.equal(result.worstDay, 1); // Monday = getDay() 1
  assert.equal(result.worstBunkRate, 100);
});

test('holiday and cancelled never affect conducted/attended', () => {
  const records = [
    { status: 'holiday' },
    { status: 'cancelled' },
    { status: 'holiday' },
  ];
  const s = engine.summarize(records);
  assert.equal(s.conducted, 0);
  assert.equal(s.attended, 0);
  assert.equal(s.percentage, 0);
});

test('pending lectures are excluded from calculations', () => {
  const records = [{ status: 'pending' }, { status: 'attended' }];
  const s = engine.summarize(records);
  assert.equal(s.conducted, 1);
  assert.equal(s.attended, 1);
});
