/**
 * Cron wiring for the notification jobs. Each job is a thin cadence
 * decision — all the actual logic (what to check, whether to fire, what
 * to send) lives in services/notificationJobs.js so it can be unit tested
 * and invoked on demand without going through cron.
 */

'use strict';

const cron = require('node-cron');
const jobs = require('../services/notificationJobs');

function safeRun(name, fn) {
  return async () => {
    try {
      await fn();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[notifications] ${name} job failed:`, err.message);
    }
  };
}

let tasks = [];

/** Idempotent: calling this more than once (e.g. across test setup) is a no-op after the first call. */
function startNotificationScheduler() {
  if (tasks.length) return tasks;

  tasks = [
    // Lecture-starting-soon reminders: fine-grained, checks every 5 min.
    cron.schedule('*/5 * * * *', safeRun('lecture-reminders', () => jobs.checkLectureReminders(new Date()))),
    // Below-75% / close-to-75% warnings: recomputed periodically through the day.
    cron.schedule('*/15 7-22 * * *', safeRun('attendance-thresholds', () => jobs.checkAttendanceThresholds(new Date()))),
    // Nudge for today's already-started-but-unmarked lectures.
    cron.schedule('*/15 9-21 * * *', safeRun('today-attendance-reminder', () => jobs.checkTodayAttendanceReminder(new Date()))),
    // Once a day, well after the last lecture, check for yesterday's leftovers.
    cron.schedule('30 20 * * *', safeRun('missed-attendance', () => jobs.checkMissedAttendance(new Date()))),
    // Morning summary.
    cron.schedule('0 7 * * *', safeRun('daily-summary', () => jobs.sendDailySummary(new Date()))),
  ];

  return tasks;
}

function stopNotificationScheduler() {
  tasks.forEach((t) => t.stop());
  tasks = [];
}

module.exports = { startNotificationScheduler, stopNotificationScheduler };
