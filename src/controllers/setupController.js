'use strict';

const Semester = require('../models/Semester');
const Subject = require('../models/Subject');
const TimetableSlot = require('../models/TimetableSlot');
const LectureRecord = require('../models/LectureRecord');
const Room = require('../models/Room');
const RoomMembership = require('../models/RoomMembership');
const roomService = require('../services/roomService');
const { ApiError, asyncHandler } = require('../middleware/errorHandler');

/** First-time setup: create the user's profile fields + first active semester. */
const completeSetup = asyncHandler(async (req, res) => {
  const { studentName, collegeName, semesterName, semesterStartDate, semesterEndDate, requiredAttendancePercentage } =
    req.body;

  const semester = await Semester.create({
    user: req.user._id,
    name: semesterName,
    startDate: new Date(semesterStartDate),
    endDate: semesterEndDate ? new Date(semesterEndDate) : undefined,
    requiredAttendancePercentage: requiredAttendancePercentage || 75,
  });

  req.user.studentName = studentName;
  req.user.collegeName = collegeName;
  req.user.requiredAttendancePercentage = requiredAttendancePercentage || 75;
  req.user.currentSemester = semester._id;
  req.user.setupCompleted = true;
  await req.user.save();

  res.status(201).json({ user: req.user.toSafeJSON(), semester });
});

/**
 * Ends the current semester (archives it) and starts a new one. Optionally
 * reuses the previous semester's subjects and timetable, per spec:
 * "Archive previous semester. Keep reports. Reset attendance. Reuse
 * timetable if user wants."
 * Attendance records are naturally "reset" because all new LectureRecords
 * are scoped to the new semester's id — nothing needs deleting, and old
 * reports remain queryable against the archived semester.
 */
const startNewSemester = asyncHandler(async (req, res) => {
  const { semesterName, semesterStartDate, semesterEndDate, requiredAttendancePercentage, reuseTimetable } = req.body;

  const oldSemester = await Semester.findById(req.user.currentSemester);
  if (!oldSemester) throw new ApiError(400, 'No active semester to archive');

  oldSemester.status = 'archived';
  oldSemester.archivedAt = new Date();
  await oldSemester.save();

  const newSemester = await Semester.create({
    user: req.user._id,
    name: semesterName,
    startDate: new Date(semesterStartDate),
    endDate: semesterEndDate ? new Date(semesterEndDate) : undefined,
    requiredAttendancePercentage: requiredAttendancePercentage || req.user.requiredAttendancePercentage,
  });

  if (reuseTimetable) {
    const oldSubjects = await Subject.find({ user: req.user._id, semester: oldSemester._id });
    const subjectIdMap = new Map();

    for (const s of oldSubjects) {
      const clone = await Subject.create({
        user: req.user._id,
        semester: newSemester._id,
        name: s.name,
        code: s.code,
        facultyName: s.facultyName,
        credits: s.credits,
        weeklyLectureCount: s.weeklyLectureCount,
      });
      subjectIdMap.set(s._id.toString(), clone._id);
    }

    const oldSlots = await TimetableSlot.find({ user: req.user._id, semester: oldSemester._id });
    const newSlots = oldSlots
      .filter((slot) => subjectIdMap.has(slot.subject.toString()))
      .map((slot) => ({
        user: req.user._id,
        semester: newSemester._id,
        day: slot.day,
        lectureNumber: slot.lectureNumber,
        subject: subjectIdMap.get(slot.subject.toString()),
        startTime: slot.startTime,
        endTime: slot.endTime,
      }));

    if (newSlots.length) await TimetableSlot.insertMany(newSlots);
  }

  req.user.currentSemester = newSemester._id;
  await req.user.save();

  // Rooms are keyed to a semester (Room.semester). Without this, a Room
  // stays pinned to the semester it was created in forever: once its owner
  // starts a new semester, syncOwnedRoomsForSemester (which queries
  // Room.find({ owner, semester: currentSemester })) would never find this
  // room again, and it would silently stop receiving any future
  // subject/timetable updates — the exact "joined room stops reflecting
  // the creator's room" bug. Re-point owned rooms to the new semester and
  // re-sync every member into it (picking up whatever got reused above).
  const ownedRooms = await Room.find({ owner: req.user._id, semester: oldSemester._id });
  if (ownedRooms.length) {
    await Room.updateMany({ owner: req.user._id, semester: oldSemester._id }, { semester: newSemester._id });
    for (const room of ownedRooms) {
      room.semester = newSemester._id;
      // eslint-disable-next-line no-await-in-loop
      await roomService.syncRoomToAllMembers(room);
    }
  }

  // Symmetric case: this user is a MEMBER (not owner) of some room(s) —
  // pull the room's current shared subjects/timetable into their new
  // semester right away instead of leaving them empty until the owner
  // happens to make an edit.
  const memberships = await RoomMembership.find({ user: req.user._id }).populate('room');
  for (const membership of memberships) {
    if (membership.room) {
      // eslint-disable-next-line no-await-in-loop
      await roomService.syncRoomToMember(membership.room, req.user);
    }
  }

  res.status(201).json({ archivedSemester: oldSemester, newSemester });
});

/** Updates the ACTIVE semester's attendance-warning threshold in place (no archiving). */
const updateAttendanceThreshold = asyncHandler(async (req, res) => {
  const { requiredAttendancePercentage } = req.body;

  const semester = await Semester.findOne({ _id: req.user.currentSemester, user: req.user._id });
  if (!semester) throw new ApiError(400, 'No active semester to update');

  semester.requiredAttendancePercentage = requiredAttendancePercentage;
  await semester.save();

  // Keep the user's profile value (the seed used for the *next* semester) in sync too.
  req.user.requiredAttendancePercentage = requiredAttendancePercentage;
  await req.user.save();

  res.json({ semester, user: req.user.toSafeJSON() });
});

const listSemesters = asyncHandler(async (req, res) => {
  const semesters = await Semester.find({ user: req.user._id }).sort({ startDate: -1 });
  res.json({ semesters });
});

/**
 * Edits a semester's own fields (name/dates/threshold) — works for the
 * active semester or any archived one. If it's the active semester and the
 * threshold changes, mirrors updateAttendanceThreshold's side effect of
 * keeping the user's profile seed value in sync.
 */
const updateSemester = asyncHandler(async (req, res) => {
  const semester = await Semester.findOne({ _id: req.params.id, user: req.user._id });
  if (!semester) throw new ApiError(404, 'Semester not found');

  const { name, startDate, endDate, requiredAttendancePercentage } = req.body;
  if (name !== undefined) semester.name = name;
  if (startDate !== undefined) semester.startDate = new Date(startDate);
  if (endDate !== undefined) semester.endDate = endDate ? new Date(endDate) : undefined;
  if (requiredAttendancePercentage !== undefined) semester.requiredAttendancePercentage = requiredAttendancePercentage;
  await semester.save();

  if (requiredAttendancePercentage !== undefined && semester._id.toString() === req.user.currentSemester?.toString()) {
    req.user.requiredAttendancePercentage = requiredAttendancePercentage;
    await req.user.save();
  }

  res.json({ semester });
});

/**
 * Deletes an ARCHIVED semester and everything scoped to it (subjects,
 * timetable slots, lecture records) — deliberately refuses to delete the
 * currently active semester (that would orphan user.currentSemester) or
 * one a Room still points to (that would break sync for anyone in it;
 * per the startNewSemester fix, an owned Room always gets re-pointed to
 * the new semester, so this should only ever trip on a genuinely stale
 * reference worth surfacing rather than silently working around).
 */
const deleteSemester = asyncHandler(async (req, res) => {
  const semester = await Semester.findOne({ _id: req.params.id, user: req.user._id });
  if (!semester) throw new ApiError(404, 'Semester not found');

  if (semester._id.toString() === req.user.currentSemester?.toString()) {
    throw new ApiError(400, 'Cannot delete your active semester — start a new semester first');
  }

  const referencingRoom = await Room.findOne({ owner: req.user._id, semester: semester._id });
  if (referencingRoom) {
    throw new ApiError(400, `Room "${referencingRoom.name}" still uses this semester — resolve that room first`);
  }

  await Promise.all([
    Subject.deleteMany({ user: req.user._id, semester: semester._id }),
    TimetableSlot.deleteMany({ user: req.user._id, semester: semester._id }),
    LectureRecord.deleteMany({ user: req.user._id, semester: semester._id }),
  ]);
  await semester.deleteOne();

  res.json({ message: 'Semester and its subjects/timetable/attendance records deleted' });
});

module.exports = {
  completeSetup,
  startNewSemester,
  listSemesters,
  updateSemester,
  deleteSemester,
  updateAttendanceThreshold,
};
