/**
 * Room Engine
 * -----------
 * Pure logic for the "join a room, get the owner's subjects/timetable,
 * stay synced" feature — no DB access, easy to test exhaustively like
 * attendanceEngine.js. services/roomService.js is the I/O layer that reads
 * real Subject/TimetableSlot documents, calls into here to decide what
 * changed, and applies the resulting create/update/delete lists.
 */

'use strict';

// Excludes ambiguous characters (0/O, 1/I) so a code is easy to read aloud/type.
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateRoomCode(length = 6) {
  let code = '';
  for (let i = 0; i < length; i += 1) {
    code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  }
  return code;
}

function normalizeName(name) {
  return (name || '').trim().toLowerCase();
}

/** undefined/null/'' are treated as equivalent "no value" to avoid noisy false-positive updates. */
function valuesDiffer(a, b) {
  const normA = a === undefined || a === null ? '' : a;
  const normB = b === undefined || b === null ? '' : b;
  return normA !== normB;
}

const SUBJECT_FIELDS = ['code', 'facultyName', 'credits', 'weeklyLectureCount'];

/**
 * Diffs the room owner's subjects against a member's currently room-synced
 * subjects (matched by normalized name).
 * @param {Array<{name, code, facultyName, credits, weeklyLectureCount}>} ownerSubjects
 * @param {Array<{_id, name, code, facultyName, credits, weeklyLectureCount}>} memberSubjects
 */
function diffSubjects(ownerSubjects, memberSubjects) {
  const memberByName = new Map(memberSubjects.map((s) => [normalizeName(s.name), s]));
  const ownerNames = new Set(ownerSubjects.map((s) => normalizeName(s.name)));

  const toCreate = [];
  const toUpdate = [];

  for (const ownerSubject of ownerSubjects) {
    const existing = memberByName.get(normalizeName(ownerSubject.name));
    if (!existing) {
      toCreate.push(ownerSubject);
      continue;
    }
    const changes = {};
    for (const field of SUBJECT_FIELDS) {
      if (valuesDiffer(ownerSubject[field], existing[field])) changes[field] = ownerSubject[field];
    }
    if (Object.keys(changes).length) toUpdate.push({ id: existing._id, changes });
  }

  const toDeleteIds = memberSubjects.filter((s) => !ownerNames.has(normalizeName(s.name))).map((s) => s._id);

  return { toCreate, toUpdate, toDeleteIds };
}

function slotKey(slot) {
  return `${slot.day}-${slot.lectureNumber}`;
}

/**
 * Same idea for timetable slots, matched by (day, lectureNumber). Subject
 * identity is carried as `subjectName` (a plain string) rather than an
 * ObjectId, since the owner's and member's Subject documents for "the same"
 * subject have different _ids — the caller resolves subjectName to the
 * member's local subject _id before writing to the DB.
 * @param {Array<{day, lectureNumber, subjectName, startTime, endTime}>} ownerSlots
 * @param {Array<{_id, day, lectureNumber, subjectName, startTime, endTime}>} memberSlots
 */
function diffTimetableSlots(ownerSlots, memberSlots) {
  const memberByKey = new Map(memberSlots.map((s) => [slotKey(s), s]));
  const ownerKeys = new Set(ownerSlots.map(slotKey));

  const toCreate = [];
  const toUpdate = [];

  for (const ownerSlot of ownerSlots) {
    const existing = memberByKey.get(slotKey(ownerSlot));
    if (!existing) {
      toCreate.push(ownerSlot);
      continue;
    }
    const changes = {};
    if (valuesDiffer(ownerSlot.subjectName, existing.subjectName)) changes.subjectName = ownerSlot.subjectName;
    if (valuesDiffer(ownerSlot.startTime, existing.startTime)) changes.startTime = ownerSlot.startTime;
    if (valuesDiffer(ownerSlot.endTime, existing.endTime)) changes.endTime = ownerSlot.endTime;
    if (Object.keys(changes).length) toUpdate.push({ id: existing._id, changes });
  }

  const toDeleteIds = memberSlots.filter((s) => !ownerKeys.has(slotKey(s))).map((s) => s._id);

  return { toCreate, toUpdate, toDeleteIds };
}

module.exports = { generateRoomCode, normalizeName, diffSubjects, diffTimetableSlots };
