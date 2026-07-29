/**
 * Notification Engine
 * --------------------
 * Pure, side-effect-free "should this notification fire" logic, following
 * the same contract as attendanceEngine.js: no DB, no FCM, no Date.now()
 * reliance (callers pass in `now`/`nowMinutes` so this stays deterministic
 * and unit-testable). It deliberately does NOT recompute attendance math —
 * threshold checks delegate to attendanceEngine.classify() so "below 75%"
 * and "close to 75%" can never drift from the numbers shown on the
 * dashboard.
 *
 * The stateful parts of "did we already send this today" (dedup, actually
 * calling FCM, querying Mongo) live in services/notificationJobs.js, which
 * calls into this module for every decision.
 */

'use strict';

const engine = require('./attendanceEngine');

/** Parse "HH:mm" into minutes-since-midnight. Returns null if unparseable. */
function toMinutes(hhmm) {
  if (typeof hhmm !== 'string') return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/** Overall/monthly attendance has dropped below the required percentage. */
function shouldFireBelowThreshold(currentPct, requiredPct) {
  return engine.classify(currentPct, requiredPct) === 'danger';
}

/** Overall/monthly attendance is still above the required %, but inside the risky cushion band. */
function shouldFireCloseToThreshold(currentPct, requiredPct) {
  return engine.classify(currentPct, requiredPct) === 'risky';
}

/**
 * Nudge to mark attendance: true if any of today's lectures is still
 * 'pending' and its scheduled start time has already passed (no point
 * nudging for a lecture that hasn't happened yet — that's a lecture
 * reminder, not an attendance reminder). Lectures with no recorded
 * startTime are treated as already due, since we can't gate on time we
 * don't have.
 */
function shouldFireAttendanceReminder({ lectures, nowMinutes }) {
  return (lectures || []).some((l) => {
    if (l.status !== 'pending') return false;
    const start = toMinutes(l.startTime);
    if (start === null) return true;
    return nowMinutes >= start;
  });
}

/** Yesterday is fully over — any lecture still 'pending' was simply never marked. */
function shouldFireMissedAttendanceReminder(lectures) {
  return (lectures || []).some((l) => l.status === 'pending');
}

/**
 * Which of today's still-pending lectures start within `leadMinutes` from
 * now (and haven't started yet). Each one that qualifies gets its own
 * lecture_reminder push, deduplicated per lecture number by the caller.
 */
function getDueLectureReminders({ lectures, nowMinutes, leadMinutes = 10 }) {
  return (lectures || []).filter((l) => {
    if (l.status !== 'pending') return false;
    const start = toMinutes(l.startTime);
    if (start === null) return false;
    const diff = start - nowMinutes;
    return diff >= 0 && diff <= leadMinutes;
  });
}

/** Builds a stable per-user dedup key so a condition fires at most once per key. */
function dedupeKey(type, dateStr, extra) {
  return extra ? `${type}:${dateStr}:${extra}` : `${type}:${dateStr}`;
}

function pluralize(count, noun) {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function buildBelowThresholdMessage({ percentage, requiredPct, scope = 'overall' }) {
  const scopeLabel = scope === 'monthly' ? 'this month’s' : 'your overall';
  return {
    title: 'Attendance below requirement',
    body: `${scopeLabel} attendance is ${percentage}%, below the required ${requiredPct}%. Attend your next lectures to recover.`,
  };
}

function buildCloseThresholdMessage({ percentage, requiredPct, scope = 'overall' }) {
  const scopeLabel = scope === 'monthly' ? 'This month’s' : 'Your overall';
  return {
    title: 'Attendance getting risky',
    body: `${scopeLabel} attendance is ${percentage}%, close to the ${requiredPct}% requirement. One more bunk could put you below it.`,
  };
}

function buildAttendanceReminderMessage({ pendingCount }) {
  return {
    title: 'Mark today’s attendance',
    body: `${pluralize(pendingCount, 'lecture')} today still need${pendingCount === 1 ? 's' : ''} to be marked.`,
  };
}

function buildMissedAttendanceMessage({ pendingCount }) {
  return {
    title: 'Yesterday’s attendance is unmarked',
    body: `${pluralize(pendingCount, 'lecture')} from yesterday ${pendingCount === 1 ? 'is' : 'are'} still unmarked.`,
  };
}

function buildLectureReminderMessage({ subjectName, startTime, leadMinutes }) {
  return {
    title: `${subjectName || 'Class'} starts soon`,
    body: `${subjectName || 'Your next lecture'} starts at ${startTime} (in ${leadMinutes} min or less).`,
  };
}

function buildDailySummaryMessage({ todayLectureCount, overallPercentage, safeBunksRemaining }) {
  const lecturePart =
    todayLectureCount === 0 ? 'No lectures scheduled today.' : `${pluralize(todayLectureCount, 'lecture')} today.`;
  const safePart =
    safeBunksRemaining === Infinity
      ? 'You can bunk freely and stay above your target.'
      : `You can safely bunk ${safeBunksRemaining} more to stay on target.`;
  return {
    title: 'Your morning attendance summary',
    body: `${lecturePart} Current attendance: ${overallPercentage}%. ${safePart}`,
  };
}

module.exports = {
  toMinutes,
  shouldFireBelowThreshold,
  shouldFireCloseToThreshold,
  shouldFireAttendanceReminder,
  shouldFireMissedAttendanceReminder,
  getDueLectureReminders,
  dedupeKey,
  buildBelowThresholdMessage,
  buildCloseThresholdMessage,
  buildAttendanceReminderMessage,
  buildMissedAttendanceMessage,
  buildLectureReminderMessage,
  buildDailySummaryMessage,
};
