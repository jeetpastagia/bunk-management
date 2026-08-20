/**
 * Notification Jobs
 * ------------------
 * The I/O layer that connects notificationEngine.js's pure decisions to
 * real data: queries Mongo for the same records attendanceEngine.js
 * already reduces for the dashboard, asks notificationEngine.js whether a
 * given condition should fire, and if so writes a Notification (which
 * doubles as the per-user dedup ledger via its unique dedupeKey index)
 * and sends the push through fcmService.
 *
 * These functions are exported individually so src/jobs/scheduler.js can
 * wire each one to its own cron cadence, and so each can be invoked
 * directly (e.g. right after an attendance mark) without waiting for the
 * next tick.
 */

'use strict';

const User = require('../models/User');
const Semester = require('../models/Semester');
const LectureRecord = require('../models/LectureRecord');
const TimetableSlot = require('../models/TimetableSlot');
const Notification = require('../models/Notification');
const engine = require('./attendanceEngine');
const notificationEngine = require('./notificationEngine');
const fcmService = require('./fcmService');
// ensureLecturesForDate/startOfDay are the exact idempotent-generation and
// date-normalization helpers the dashboard overview endpoint uses — reused
// here (via the controller's documented `_internal` export) so "today's
// lectures" can never disagree between the API and the notification jobs.
const { ensureLecturesForDate, startOfDay } = require('../controllers/attendanceController')._internal;

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

// Maps each notification type to the Settings toggle that gates it. Types
// with no entry here are never gated (none currently — every type belongs
// to one of the three Settings categories).
const PREF_BY_TYPE = {
  lecture_reminder: 'attendanceWarnings',
  attendance_reminder: 'attendanceWarnings',
  below_75_warning: 'attendanceWarnings',
  close_to_75_warning: 'attendanceWarnings',
  missed_attendance: 'attendanceWarnings',
  daily_summary: 'attendanceWarnings',
  room_activity: 'roomActivity',
  timetable_update: 'timetableUpdates',
};

function dateKey(date) {
  return startOfDay(date).toISOString().slice(0, 10);
}

async function activeUsers() {
  return User.find({ isActive: true, setupCompleted: true, currentSemester: { $ne: null } });
}

async function semesterRecords(user, semesterId) {
  return LectureRecord.find({ user: user._id, semester: semesterId }).lean();
}

/**
 * Writes the Notification (which enforces "at most once per dedupeKey" via
 * its unique index) and, only if that succeeded, sends the push. Returns
 * null (not an error) when the condition already fired today.
 */
async function notifyUser(user, { type, title, body, data, dedupeKey }) {
  const prefKey = PREF_BY_TYPE[type];
  if (prefKey && user.notificationPrefs && user.notificationPrefs[prefKey] === false) {
    return null; // user turned this notification category off in Settings
  }

  let doc;
  try {
    doc = await Notification.create({ user: user._id, type, title, body, data, dedupeKey });
  } catch (err) {
    if (err.code === 11000) return null; // already sent for this dedupeKey
    throw err;
  }

  if (user.fcmTokens && user.fcmTokens.length) {
    const { invalidTokens } = await fcmService.sendPushToTokens(user.fcmTokens, { title, body, data });
    if (invalidTokens.length) {
      user.fcmTokens = user.fcmTokens.filter((t) => !invalidTokens.includes(t));
      await user.save();
    }
  }

  return doc;
}

/** Joins today's LectureRecords with their timetable slot's startTime. */
async function todayLecturesWithTimes(user, now) {
  const records = await ensureLecturesForDate(user, now);
  const day = startOfDay(now);
  const dayName = DAY_NAMES[day.getDay()];
  const slots = await TimetableSlot.find({ user: user._id, semester: user.currentSemester, day: dayName }).lean();
  const startTimeByLectureNumber = new Map(slots.map((s) => [s.lectureNumber, s.startTime]));

  return records.map((r) => ({
    lectureNumber: r.lectureNumber,
    status: r.status,
    subjectName: r.subject && r.subject.name,
    startTime: startTimeByLectureNumber.get(r.lectureNumber) || null,
  }));
}

/** Below-75% / close-to-75% warnings, checked against both overall and this-month attendance. */
async function checkAttendanceThresholds(now = new Date()) {
  const users = await activeUsers();
  const out = [];

  for (const user of users) {
    const semester = await Semester.findById(user.currentSemester);
    if (!semester) continue;

    const records = await semesterRecords(user, semester._id);
    const requiredPct = semester.requiredAttendancePercentage;
    const dk = dateKey(now);

    const scopes = [
      { scope: 'overall', stats: engine.summarize(records), keySuffix: null },
      {
        scope: 'monthly',
        stats: engine.summarize(
          records.filter((r) => {
            const d = new Date(r.date);
            return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
          })
        ),
        keySuffix: 'monthly',
      },
    ];

    for (const { scope, stats, keySuffix } of scopes) {
      if (stats.conducted === 0) continue; // nothing conducted yet, nothing to warn about
      if (notificationEngine.shouldFireBelowThreshold(stats.percentage, requiredPct)) {
        const msg = notificationEngine.buildBelowThresholdMessage({ percentage: stats.percentage, requiredPct, scope });
        // eslint-disable-next-line no-await-in-loop
        out.push(
          await notifyUser(user, {
            type: 'below_75_warning',
            ...msg,
            data: { percentage: stats.percentage, requiredPct, scope },
            dedupeKey: notificationEngine.dedupeKey('below_75_warning', dk, keySuffix),
          })
        );
      } else if (notificationEngine.shouldFireCloseToThreshold(stats.percentage, requiredPct)) {
        const msg = notificationEngine.buildCloseThresholdMessage({ percentage: stats.percentage, requiredPct, scope });
        // eslint-disable-next-line no-await-in-loop
        out.push(
          await notifyUser(user, {
            type: 'close_to_75_warning',
            ...msg,
            data: { percentage: stats.percentage, requiredPct, scope },
            dedupeKey: notificationEngine.dedupeKey('close_to_75_warning', dk, keySuffix),
          })
        );
      }
    }
  }

  return out.filter(Boolean);
}

/** Nudge if today's already-started lectures are still unmarked. */
async function checkTodayAttendanceReminder(now = new Date()) {
  const users = await activeUsers();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const dk = dateKey(now);
  const out = [];

  for (const user of users) {
    // eslint-disable-next-line no-await-in-loop
    const lectures = await todayLecturesWithTimes(user, now);
    if (notificationEngine.shouldFireAttendanceReminder({ lectures, nowMinutes })) {
      const pendingCount = lectures.filter((l) => l.status === 'pending').length;
      const msg = notificationEngine.buildAttendanceReminderMessage({ pendingCount });
      // eslint-disable-next-line no-await-in-loop
      out.push(
        await notifyUser(user, {
          type: 'attendance_reminder',
          ...msg,
          data: { pendingCount, date: dk },
          dedupeKey: notificationEngine.dedupeKey('attendance_reminder', dk),
        })
      );
    }
  }

  return out.filter(Boolean);
}

/** Reminder for yesterday's lectures that never got marked. */
async function checkMissedAttendance(now = new Date()) {
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const day = startOfDay(yesterday);
  const dk = dateKey(day);

  const users = await activeUsers();
  const out = [];

  for (const user of users) {
    // eslint-disable-next-line no-await-in-loop
    const records = await LectureRecord.find({ user: user._id, date: day }).lean();
    if (!records.length) continue; // nothing was ever generated for that date

    if (notificationEngine.shouldFireMissedAttendanceReminder(records)) {
      const pendingCount = records.filter((r) => r.status === 'pending').length;
      const msg = notificationEngine.buildMissedAttendanceMessage({ pendingCount });
      // eslint-disable-next-line no-await-in-loop
      out.push(
        await notifyUser(user, {
          type: 'missed_attendance',
          ...msg,
          data: { pendingCount, date: dk },
          dedupeKey: notificationEngine.dedupeKey('missed_attendance', dk),
        })
      );
    }
  }

  return out.filter(Boolean);
}

/** Per-lecture "starts in N minutes" reminders. */
async function checkLectureReminders(now = new Date(), leadMinutes = 10) {
  const users = await activeUsers();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const dk = dateKey(now);
  const out = [];

  for (const user of users) {
    // eslint-disable-next-line no-await-in-loop
    const lectures = await todayLecturesWithTimes(user, now);
    const due = notificationEngine.getDueLectureReminders({ lectures, nowMinutes, leadMinutes });

    for (const lecture of due) {
      const msg = notificationEngine.buildLectureReminderMessage({
        subjectName: lecture.subjectName,
        startTime: lecture.startTime,
        leadMinutes,
      });
      // eslint-disable-next-line no-await-in-loop
      out.push(
        await notifyUser(user, {
          type: 'lecture_reminder',
          ...msg,
          data: { lectureNumber: lecture.lectureNumber, subjectName: lecture.subjectName, startTime: lecture.startTime, date: dk },
          dedupeKey: notificationEngine.dedupeKey('lecture_reminder', dk, `L${lecture.lectureNumber}`),
        })
      );
    }
  }

  return out.filter(Boolean);
}

/** Daily morning summary: today's lecture count, current %, safe bunks remaining. */
async function sendDailySummary(now = new Date()) {
  const users = await activeUsers();
  const dk = dateKey(now);
  const out = [];

  for (const user of users) {
    const semester = await Semester.findById(user.currentSemester);
    if (!semester) continue;

    const records = await semesterRecords(user, semester._id);
    const overall = engine.summarize(records);
    const requiredPct = semester.requiredAttendancePercentage;
    const safeBunks = engine.safeBunksRemaining(overall.attended, overall.conducted, requiredPct);
    // eslint-disable-next-line no-await-in-loop
    const todayRecords = await ensureLecturesForDate(user, now);
    const todayLectureCount = todayRecords.filter((r) => r.status !== 'holiday' && r.status !== 'cancelled').length;

    const msg = notificationEngine.buildDailySummaryMessage({
      todayLectureCount,
      overallPercentage: overall.percentage,
      safeBunksRemaining: safeBunks,
    });

    // eslint-disable-next-line no-await-in-loop
    out.push(
      await notifyUser(user, {
        type: 'daily_summary',
        ...msg,
        data: {
          todayLectureCount,
          overallPercentage: overall.percentage,
          safeBunksRemaining: safeBunks === Infinity ? null : safeBunks,
        },
        dedupeKey: notificationEngine.dedupeKey('daily_summary', dk),
      })
    );
  }

  return out.filter(Boolean);
}

module.exports = {
  notifyUser,
  checkAttendanceThresholds,
  checkTodayAttendanceReminder,
  checkMissedAttendance,
  checkLectureReminders,
  sendDailySummary,
  _internal: { activeUsers, semesterRecords, todayLecturesWithTimes, dateKey },
};
