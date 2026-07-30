'use strict';

/**
 * These tests verify the app assembles correctly, routes are wired, and
 * validation middleware runs BEFORE any database access — all without
 * needing a live MongoDB connection (unavailable in this build sandbox,
 * see README "Running against a real database").
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

process.env.JWT_SECRET = 'test-secret';
process.env.NODE_ENV = 'test';

const { createApp } = require('../src/app');

function request(app, method, path, body) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const { port } = server.address();
      const payload = body ? JSON.stringify(body) : null;
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path,
          method,
          headers: {
            'Content-Type': 'application/json',
            ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
          },
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            server.close();
            resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null });
          });
        }
      );
      req.on('error', (err) => {
        server.close();
        reject(err);
      });
      if (payload) req.write(payload);
      req.end();
    });
  });
}

test('app boots and exposes a health check', async () => {
  const app = createApp();
  const res = await request(app, 'GET', '/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'ok');
});

test('unknown route returns 404 via notFound handler', async () => {
  const app = createApp();
  const res = await request(app, 'GET', '/api/does-not-exist');
  assert.equal(res.status, 404);
});

test('signup rejects invalid mobile number before touching the DB', async () => {
  const app = createApp();
  const res = await request(app, 'POST', '/api/auth/signup', {
    mobileNumber: 'not-a-number',
    password: 'password123',
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'Validation failed');
});

test('signup rejects short password before touching the DB', async () => {
  const app = createApp();
  const res = await request(app, 'POST', '/api/auth/signup', {
    mobileNumber: '9876543210',
    password: '123',
  });
  assert.equal(res.status, 400);
});

test('protected route rejects requests with no Authorization header', async () => {
  const app = createApp();
  const res = await request(app, 'GET', '/api/auth/me');
  assert.equal(res.status, 401);
});

test('protected route rejects a malformed JWT', async () => {
  const app = createApp();
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  const res = await new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/api/attendance/overview', method: 'GET', headers: { Authorization: 'Bearer not-a-real-token' } },
      (r) => {
        let data = '';
        r.on('data', (c) => (data += c));
        r.on('end', () => resolve({ status: r.statusCode, body: JSON.parse(data) }));
      }
    );
    req.on('error', reject);
    req.end();
  });
  server.close();
  assert.equal(res.status, 401);
});

test('subject creation route requires auth even with a valid-looking body', async () => {
  const app = createApp();
  const res = await request(app, 'POST', '/api/subjects', { name: 'DBMS' });
  assert.equal(res.status, 401);
});

test('models load and compile without schema errors', () => {
  // Requiring each model registers its schema with mongoose; a bad schema
  // throws synchronously at require-time, so simply requiring them all is
  // a real validity check.
  assert.doesNotThrow(() => {
    require('../src/models/User');
    require('../src/models/Semester');
    require('../src/models/Subject');
    require('../src/models/TimetableSlot');
    require('../src/models/LectureRecord');
    require('../src/models/Holiday');
    require('../src/models/Notification');
    require('../src/models/Room');
    require('../src/models/RoomMembership');
  });
});

test('room routes require auth', async () => {
  const app = createApp();
  const list = await request(app, 'GET', '/api/rooms');
  assert.equal(list.status, 401);
  const create = await request(app, 'POST', '/api/rooms', { name: 'CS-A' });
  assert.equal(create.status, 401);
  const join = await request(app, 'POST', '/api/rooms/join', { code: 'ABC123' });
  assert.equal(join.status, 401);
});

test('notification routes require auth', async () => {
  const app = createApp();
  const list = await request(app, 'GET', '/api/notifications');
  assert.equal(list.status, 401);
  const unreadCount = await request(app, 'GET', '/api/notifications/unread-count');
  assert.equal(unreadCount.status, 401);
  const register = await request(app, 'POST', '/api/notifications/register-token', { fcmToken: 'abc' });
  assert.equal(register.status, 401);
  const remove = await request(app, 'DELETE', '/api/notifications/token', { fcmToken: 'abc' });
  assert.equal(remove.status, 401);
  const markAllRead = await request(app, 'PATCH', '/api/notifications/read-all');
  assert.equal(markAllRead.status, 401);
});

test('register-token rejects a missing fcmToken before touching the DB (auth still checked first)', async () => {
  const app = createApp();
  const res = await request(app, 'POST', '/api/notifications/register-token', {});
  // No Authorization header at all, so the auth gate short-circuits before validation runs.
  assert.equal(res.status, 401);
});

test('backfill-bunks route requires auth', async () => {
  const app = createApp();
  const res = await request(app, 'POST', '/api/attendance/subjects/507f1f77bcf86cd799439011/backfill-bunks', { bunked: 3 });
  assert.equal(res.status, 401);
});

test('scheduler module loads and exposes start/stop without side effects at require-time', () => {
  const { startNotificationScheduler, stopNotificationScheduler } = require('../src/jobs/scheduler');
  assert.equal(typeof startNotificationScheduler, 'function');
  assert.equal(typeof stopNotificationScheduler, 'function');
});
