'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const engine = require('../src/services/roomEngine');

test('generateRoomCode: produces a code of the requested length using only unambiguous characters', () => {
  const code = engine.generateRoomCode(6);
  assert.equal(code.length, 6);
  assert.ok(/^[A-Z2-9]+$/.test(code));
  assert.ok(!/[O0I1]/.test(code));
});

test('generateRoomCode: default length is 6', () => {
  assert.equal(engine.generateRoomCode().length, 6);
});

test('diffSubjects: creates subjects the member does not have yet', () => {
  const owner = [{ name: 'DBMS', code: 'DB301', facultyName: 'Dr. Rao', credits: 4, weeklyLectureCount: 4 }];
  const member = [];
  const { toCreate, toUpdate, toDeleteIds } = engine.diffSubjects(owner, member);
  assert.equal(toCreate.length, 1);
  assert.equal(toCreate[0].name, 'DBMS');
  assert.equal(toUpdate.length, 0);
  assert.equal(toDeleteIds.length, 0);
});

test('diffSubjects: matches existing subjects by name case-insensitively, no-op when identical', () => {
  const owner = [{ name: 'DBMS', code: 'DB301', facultyName: 'Dr. Rao', credits: 4, weeklyLectureCount: 4 }];
  const member = [{ _id: 'm1', name: 'dbms', code: 'DB301', facultyName: 'Dr. Rao', credits: 4, weeklyLectureCount: 4 }];
  const { toCreate, toUpdate, toDeleteIds } = engine.diffSubjects(owner, member);
  assert.equal(toCreate.length, 0);
  assert.equal(toUpdate.length, 0);
  assert.equal(toDeleteIds.length, 0);
});

test('diffSubjects: detects a changed field on an existing subject', () => {
  const owner = [{ name: 'DBMS', code: 'DB301', facultyName: 'Dr. Sharma', credits: 4, weeklyLectureCount: 5 }];
  const member = [{ _id: 'm1', name: 'DBMS', code: 'DB301', facultyName: 'Dr. Rao', credits: 4, weeklyLectureCount: 4 }];
  const { toUpdate } = engine.diffSubjects(owner, member);
  assert.equal(toUpdate.length, 1);
  assert.equal(toUpdate[0].id, 'm1');
  assert.deepEqual(toUpdate[0].changes, { facultyName: 'Dr. Sharma', weeklyLectureCount: 5 });
});

test('diffSubjects: removes member subjects no longer present for the owner', () => {
  const owner = [];
  const member = [{ _id: 'm1', name: 'Old Subject' }];
  const { toDeleteIds } = engine.diffSubjects(owner, member);
  assert.deepEqual(toDeleteIds, ['m1']);
});

test('diffTimetableSlots: creates, updates, and deletes correctly by day+lectureNumber', () => {
  const owner = [
    { day: 'monday', lectureNumber: 1, subjectName: 'DBMS', startTime: '09:00', endTime: '10:00' },
    { day: 'monday', lectureNumber: 2, subjectName: 'Java', startTime: '10:00', endTime: '11:00' },
  ];
  const member = [
    { _id: 's1', day: 'monday', lectureNumber: 1, subjectName: 'DBMS', startTime: '09:00', endTime: '10:00' },
    { _id: 's2', day: 'tuesday', lectureNumber: 1, subjectName: 'Physics', startTime: '09:00', endTime: '10:00' },
  ];
  const { toCreate, toUpdate, toDeleteIds } = engine.diffTimetableSlots(owner, member);
  assert.equal(toCreate.length, 1);
  assert.equal(toCreate[0].subjectName, 'Java');
  assert.equal(toUpdate.length, 0); // monday-1 identical
  assert.deepEqual(toDeleteIds, ['s2']); // tuesday-1 no longer in owner's timetable
});

test('diffTimetableSlots: detects a subject swap on the same slot', () => {
  const owner = [{ day: 'monday', lectureNumber: 1, subjectName: 'Java', startTime: '09:00', endTime: '10:00' }];
  const member = [{ _id: 's1', day: 'monday', lectureNumber: 1, subjectName: 'DBMS', startTime: '09:00', endTime: '10:00' }];
  const { toUpdate } = engine.diffTimetableSlots(owner, member);
  assert.equal(toUpdate.length, 1);
  assert.deepEqual(toUpdate[0].changes, { subjectName: 'Java' });
});
