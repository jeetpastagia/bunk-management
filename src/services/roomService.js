/**
 * Room Service
 * ------------
 * The I/O layer for the Rooms feature: reads the room owner's real
 * Subject/TimetableSlot documents, asks roomEngine.js (pure) what a given
 * member's room-synced copies need to become, and applies exactly that.
 * A member's OWN attendance (LectureRecord) is never touched or shared —
 * only the subjects/timetable template is kept in sync.
 */

'use strict';

const Room = require('../models/Room');
const RoomMembership = require('../models/RoomMembership');
const Subject = require('../models/Subject');
const TimetableSlot = require('../models/TimetableSlot');
const LectureRecord = require('../models/LectureRecord');
const { ApiError } = require('../middleware/errorHandler');
const engine = require('./roomEngine');

const MAX_CODE_ATTEMPTS = 10;

async function generateUniqueCode() {
  for (let i = 0; i < MAX_CODE_ATTEMPTS; i += 1) {
    const code = engine.generateRoomCode();
    // eslint-disable-next-line no-await-in-loop
    const existing = await Room.findOne({ code });
    if (!existing) return code;
  }
  throw new Error('Could not generate a unique room code — try again');
}

async function createRoom(owner, name) {
  if (!owner.currentSemester) throw new ApiError(400, 'Complete setup (pick a semester) before creating a room');
  const code = await generateUniqueCode();
  return Room.create({ code, name, owner: owner._id, semester: owner.currentSemester });
}

/**
 * Rebuilds one member's room-synced Subject/TimetableSlot documents to
 * match the room owner's current state. Safe to call repeatedly (e.g.
 * after every owner edit) — it's a full re-derivation, not an incremental
 * patch, so it can never drift out of sync.
 */
async function syncRoomToMember(room, member) {
  if (!member.currentSemester) return; // hasn't completed setup yet, nothing to sync into

  const [ownerSubjects, memberSubjects] = await Promise.all([
    Subject.find({ user: room.owner, semester: room.semester }).lean(),
    Subject.find({ user: member._id, semester: member.currentSemester, syncedFromRoom: room._id }).lean(),
  ]);

  const subjectDiff = engine.diffSubjects(ownerSubjects, memberSubjects);

  if (subjectDiff.toDeleteIds.length) {
    await Promise.all([
      Subject.deleteMany({ _id: { $in: subjectDiff.toDeleteIds } }),
      TimetableSlot.deleteMany({ user: member._id, subject: { $in: subjectDiff.toDeleteIds } }),
      LectureRecord.deleteMany({ user: member._id, subject: { $in: subjectDiff.toDeleteIds } }),
    ]);
  }
  await Promise.all(
    subjectDiff.toUpdate.map(({ id, changes }) => Subject.updateOne({ _id: id }, changes))
  );
  if (subjectDiff.toCreate.length) {
    await Subject.insertMany(
      subjectDiff.toCreate.map((s) => ({
        name: s.name,
        code: s.code,
        facultyName: s.facultyName,
        credits: s.credits,
        weeklyLectureCount: s.weeklyLectureCount,
        user: member._id,
        semester: member.currentSemester,
        syncedFromRoom: room._id,
      })),
      { ordered: false }
    );
  }

  // Build name -> member subject _id map (survivors + newly created) to resolve timetable slots.
  const memberSubjectsNow = await Subject.find({ user: member._id, semester: member.currentSemester }).lean();
  const subjectIdByName = new Map(memberSubjectsNow.map((s) => [engine.normalizeName(s.name), s._id]));

  const [ownerSlotsRaw, memberSlotsRaw] = await Promise.all([
    TimetableSlot.find({ user: room.owner, semester: room.semester }).populate('subject', 'name').lean(),
    TimetableSlot.find({ user: member._id, semester: member.currentSemester, syncedFromRoom: room._id })
      .populate('subject', 'name')
      .lean(),
  ]);

  const ownerSlots = ownerSlotsRaw
    .filter((s) => s.subject)
    .map((s) => ({ day: s.day, lectureNumber: s.lectureNumber, subjectName: s.subject.name, startTime: s.startTime, endTime: s.endTime }));
  const memberSlots = memberSlotsRaw.map((s) => ({
    _id: s._id,
    day: s.day,
    lectureNumber: s.lectureNumber,
    subjectName: s.subject ? s.subject.name : null,
    startTime: s.startTime,
    endTime: s.endTime,
  }));

  const slotDiff = engine.diffTimetableSlots(ownerSlots, memberSlots);

  if (slotDiff.toDeleteIds.length) {
    await TimetableSlot.deleteMany({ _id: { $in: slotDiff.toDeleteIds } });
  }
  await Promise.all(
    slotDiff.toUpdate.map(({ id, changes }) => {
      const update = { ...changes };
      if (changes.subjectName) {
        update.subject = subjectIdByName.get(engine.normalizeName(changes.subjectName));
        delete update.subjectName;
      }
      return TimetableSlot.updateOne({ _id: id }, update);
    })
  );
  const toCreateSlots = slotDiff.toCreate
    .map((s) => ({
      user: member._id,
      semester: member.currentSemester,
      day: s.day,
      lectureNumber: s.lectureNumber,
      subject: subjectIdByName.get(engine.normalizeName(s.subjectName)),
      startTime: s.startTime,
      endTime: s.endTime,
      syncedFromRoom: room._id,
    }))
    .filter((s) => s.subject); // skip if the subject somehow failed to sync
  if (toCreateSlots.length) {
    await TimetableSlot.insertMany(toCreateSlots, { ordered: false }).catch((err) => {
      if (err.code !== 11000) throw err; // duplicate day+lectureNumber race, safe to ignore
    });
  }

  const subjectsChanged = Boolean(
    subjectDiff.toCreate.length || subjectDiff.toUpdate.length || subjectDiff.toDeleteIds.length
  );
  const slotsChanged = Boolean(slotDiff.toCreate.length || slotDiff.toUpdate.length || slotDiff.toDeleteIds.length);
  return { subjectsChanged, slotsChanged };
}

/**
 * Notifies a member that the room's shared subjects/timetable changed,
 * at most once per room per day (Settings > Notifications > "Timetable
 * update notifications"). Deliberately NOT called from inside
 * syncRoomToMember itself — that function also runs on join and on a
 * member's own new-semester catch-up, neither of which is really an
 * "update" the member needs pinging about.
 */
async function notifyTimetableUpdated(room, member) {
  const notificationJobs = require('./notificationJobs'); // eslint-disable-line global-require
  const today = new Date().toISOString().slice(0, 10);
  await notificationJobs.notifyUser(member, {
    type: 'timetable_update',
    title: `"${room.name}" timetable updated`,
    body: `The shared subjects/timetable for "${room.name}" changed — check what's new.`,
    data: { roomId: room._id },
    dedupeKey: `timetable_update:${room._id}:${member._id}:${today}`,
  });
}

async function syncRoomToAllMembers(room) {
  const User = require('../models/User'); // eslint-disable-line global-require
  const memberships = await RoomMembership.find({ room: room._id });
  const members = await User.find({ _id: { $in: memberships.map((m) => m.user) } });
  await Promise.all(
    members.map(async (member) => {
      const result = await syncRoomToMember(room, member);
      if (result && (result.subjectsChanged || result.slotsChanged)) {
        await notifyTimetableUpdated(room, member);
      }
    })
  );
}

/** Called after the owner's subjects/timetable change, to propagate to every member. */
async function syncOwnedRoomsForSemester(userId, semesterId) {
  const rooms = await Room.find({ owner: userId, semester: semesterId });
  await Promise.all(rooms.map((room) => syncRoomToAllMembers(room)));
}

async function joinRoom(user, code) {
  const room = await Room.findOne({ code: code.toUpperCase() });
  if (!room) throw new ApiError(404, 'No room found with that code');
  if (room.owner.toString() === user._id.toString()) throw new ApiError(400, "You already own this room");

  const existing = await RoomMembership.findOne({ room: room._id, user: user._id });
  if (existing) throw new ApiError(409, 'You are already in this room');

  await RoomMembership.create({ room: room._id, user: user._id });
  await syncRoomToMember(room, user);

  const User = require('../models/User'); // eslint-disable-line global-require
  const notificationJobs = require('./notificationJobs'); // eslint-disable-line global-require
  const owner = await User.findById(room.owner);
  if (owner) {
    await notificationJobs.notifyUser(owner, {
      type: 'room_activity',
      title: 'New member joined your room',
      body: `${user.studentName || 'A student'} joined "${room.name}" using code ${room.code}.`,
      data: { roomId: room._id, memberId: user._id },
      dedupeKey: `room_activity:${room._id}:member:${user._id}`,
    });
  }

  return room;
}

async function leaveRoom(user, roomId) {
  const room = await Room.findById(roomId);
  if (!room) throw new ApiError(404, 'Room not found');
  if (room.owner.toString() === user._id.toString()) {
    throw new ApiError(400, 'The room owner cannot leave — delete the room instead');
  }

  await RoomMembership.deleteOne({ room: room._id, user: user._id });
  // Room-synced subjects/timetable stay behind on leave (the student keeps
  // what they already have) — they just stop receiving future updates.
  await Subject.updateMany({ user: user._id, syncedFromRoom: room._id }, { $unset: { syncedFromRoom: 1 } });
  await TimetableSlot.updateMany({ user: user._id, syncedFromRoom: room._id }, { $unset: { syncedFromRoom: 1 } });
}

async function deleteRoom(user, roomId) {
  const room = await Room.findOne({ _id: roomId, owner: user._id });
  if (!room) throw new ApiError(404, 'Room not found');
  await RoomMembership.deleteMany({ room: room._id });
  await Subject.updateMany({ syncedFromRoom: room._id }, { $unset: { syncedFromRoom: 1 } });
  await TimetableSlot.updateMany({ syncedFromRoom: room._id }, { $unset: { syncedFromRoom: 1 } });
  await room.deleteOne();
}

async function listMyRooms(user) {
  const [owned, memberships] = await Promise.all([
    Room.find({ owner: user._id }),
    RoomMembership.find({ user: user._id }).populate('room'),
  ]);

  const ownedWithCounts = await Promise.all(
    owned.map(async (room) => ({
      room,
      role: 'owner',
      memberCount: await RoomMembership.countDocuments({ room: room._id }),
    }))
  );
  const joined = memberships.filter((m) => m.room).map((m) => ({ room: m.room, role: 'member', memberCount: null }));

  return [...ownedWithCounts, ...joined];
}

module.exports = {
  createRoom,
  joinRoom,
  leaveRoom,
  deleteRoom,
  listMyRooms,
  syncRoomToMember,
  syncRoomToAllMembers,
  syncOwnedRoomsForSemester,
};
