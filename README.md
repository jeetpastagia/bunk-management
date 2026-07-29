# Bunk Manager — Backend API (Phase 1)

The core engine of the Bunk Manager platform: auth, subjects, timetable,
lecture-wise attendance tracking, and every analytics/calculator endpoint
(dashboard, subject/faculty analytics, calendar, smart calculator, bunk
predictor, future simulator, AI insights, holidays, semester archive).

This is **Phase 1** of the full spec (website + Flutter app + admin panel +
OCR + push notifications). It's the layer everything else depends on, so
it's built and tested first, and it's real, runnable code — not scaffolding.

## What's actually implemented and verified

- **Auth**: signup, login (mobile + password), JWT, bcrypt hashing, OTP-based
  forgot-password flow (OTP delivery is stubbed to a console log — see
  `deliverOtp()` in `authController.js` — wire in Twilio/MSG91/etc. for
  production SMS).
- **First-time setup**: student/college/semester profile, mandatory semester
  start date.
- **Subjects**: create, bulk create, list, search, update, delete (cascades
  to dependent timetable slots and attendance records).
- **Timetable**: manual weekly template (day + lecture number → subject).
  *(OCR timetable upload from an image is Phase 2 — it needs its own
  pipeline and human-confirmation UI and doesn't belong bolted onto the
  core API.)*
- **Lecture-wise attendance**: the atomic unit is one lecture record per
  subject per date per lecture-number — never day-wise, per spec. Statuses:
  attended / bunked / holiday / cancelled / extra / pending. Records are
  generated on-demand from the timetable template the first time a date is
  opened (idempotent).
- **Attendance engine** (`src/services/attendanceEngine.js`): all the math
  — percentage, safe-bunks-remaining, lectures-needed-for-target (75/80/85/90),
  next-lecture projection, future-date simulator (bunk-all vs attend-all,
  classified Safe/Risky/Danger), day-of-week bunk pattern. Pure functions,
  **16 unit tests**, no DB dependency — every other layer calls into this
  rather than re-deriving numbers.
- **Analytics endpoints**: dashboard overview, subject-wise, faculty-wise
  (ranked, most-attended/most-bunked), monthly breakdown, calendar (color-coded
  per spec), rule-based AI insights generated from real data.
- **Holidays**: manual/college/national entries; automatically neutralizes
  same-day pending lecture records.
- **Semester archive**: archive current semester, start a new one, optionally
  clone subjects + timetable. Old attendance stays queryable — nothing is
  deleted.
- **Push notifications**: FCM-backed, real delivery (not a stub) —
  lecture-starting-soon reminders, a nudge if today's already-started
  lectures are unmarked, below-75%/close-to-75% attendance warnings
  (overall and monthly), a reminder for yesterday's leftover unmarked
  lectures, and a daily morning summary. See "Push notifications" below.
- **Security**: helmet, CORS, rate limiting (tighter on auth routes),
  input validation on every mutating route, indexed duplicate-attendance
  prevention at the DB level, bcrypt (cost 12), scoped JWT auth middleware,
  admin-role guard scaffolded for the future admin panel.

## Push notifications

Every trigger condition reads off the exact same `attendanceEngine.js`
functions the dashboard uses — no separate math. The "should this fire"
decisions are pure functions in `src/services/notificationEngine.js`
(unit tested the same way as `attendanceEngine.js`, no DB/FCM involved),
so they're deterministic and fast to test. `src/services/notificationJobs.js`
is the I/O layer: it queries Mongo (reusing `attendanceController`'s
`ensureLecturesForDate` helper so "today's lectures" never disagrees with
the dashboard), asks `notificationEngine.js` whether to fire, and if so
writes a `Notification` document and sends the push via
`src/services/fcmService.js` (a thin `firebase-admin` wrapper).

Delivery is deduplicated per condition per user per day via a unique index
on `Notification.dedupeKey` (e.g. `below_75_warning:2026-07-29`) — a cron
tick that runs twice, or two triggers firing back-to-back, can't double-send.
Dead/unregistered FCM tokens reported by FCM are automatically pruned from
the user's `fcmTokens`.

`src/jobs/scheduler.js` wires each job to its own `node-cron` cadence
(lecture reminders every 5 min; threshold/attendance-reminder checks every
15 min during the day; missed-attendance and the daily summary once a day)
and is started from `server.js` after MongoDB connects — set
`DISABLE_NOTIFICATION_SCHEDULER=true` to turn it off (e.g. running multiple
instances). **Firebase is optional in dev**: without `FIREBASE_PROJECT_ID` /
`FIREBASE_CLIENT_EMAIL` / `FIREBASE_PRIVATE_KEY` set, `fcmService.js` logs
what it would have sent instead of throwing, so the whole pipeline (in-app
notification log, dedup, jobs) still runs and is testable without a real
Firebase project.

## What's intentionally NOT in this phase

- React website / Flutter app / Admin panel UI (Phase 2+ — this API is
  designed so all three can consume it identically).
- OCR timetable image parsing, PDF report generation, home-screen widgets.
  Each needs its own dedicated build; the spec explicitly asked for no
  dummy logic, so rather than stub these out as fake endpoints, they're
  left for a focused follow-up.

## Running it

```bash
npm install
cp .env.example .env   # set MONGO_URI and JWT_SECRET
npm start               # or: npm run dev (auto-restart)
```

You need a real MongoDB to connect to — a free
[MongoDB Atlas](https://www.mongodb.com/atlas) cluster works, or run one
locally: `docker run -d -p 27017:27017 mongo:7`. This build sandbox has no
outbound access to MongoDB's download servers, so the API was verified with:
unit tests against the attendance engine, and HTTP-level smoke tests against
the real Express app (routing, auth gate, validation-before-DB-access) —
run both with `npm test`. It has not been exercised against a live database
connection; do that as your first step after providing a `MONGO_URI`.

## API surface (all under `/api`, JSON, Bearer JWT except where noted)

```
POST   /auth/signup
POST   /auth/login
POST   /auth/forgot-password/request-otp
POST   /auth/forgot-password/reset
GET    /auth/me
POST   /auth/logout

POST   /setup                      first-time profile + semester
POST   /setup/new-semester         archive + start new (optional timetable reuse)
GET    /setup/semesters

GET    /subjects?search=
POST   /subjects
POST   /subjects/bulk              { subjects: [...] }
PUT    /subjects/:id
DELETE /subjects/:id

GET    /timetable
POST   /timetable                  { slots: [{day, lectureNumber, subject, startTime, endTime}] }
GET    /timetable/weekly-analysis

GET    /attendance/day/:date       generates + returns that day's lectures
POST   /attendance/extra           add an extra (off-timetable) lecture
PATCH  /attendance/:id             mark a lecture's status
POST   /attendance/mark-day        bulk-mark every lecture on a date
GET    /attendance/overview        dashboard: overall/monthly %, safe bunks, today
GET    /attendance/subjects        per-subject analytics
GET    /attendance/faculty         per-faculty analytics + ranking
GET    /attendance/reports/monthly
GET    /attendance/calendar?month=&year=
GET    /attendance/calculator      smart calculator (next-lecture projection, targets)
GET    /attendance/simulate?date=  future lecture simulator
GET    /attendance/insights        AI-style rule-based insights

GET    /holidays
POST   /holidays
DELETE /holidays/:id

GET    /notifications?unreadOnly=&limit=&page=   in-app notification history
GET    /notifications/unread-count
POST   /notifications/register-token             { fcmToken }
DELETE /notifications/token                       { fcmToken }
PATCH  /notifications/:id/read
PATCH  /notifications/read-all
```

## Project structure

```
src/
  config/db.js              MongoDB connection
  models/                   Mongoose schemas (User, Semester, Subject,
                             TimetableSlot, LectureRecord, Holiday,
                             Notification)
  services/attendanceEngine.js    pure attendance math (tested independently)
  services/notificationEngine.js  pure "should this fire" logic (tested independently)
  services/notificationJobs.js    DB + engine + FCM orchestration for each trigger
  services/fcmService.js          firebase-admin wrapper (no-ops without credentials)
  jobs/scheduler.js          node-cron wiring for each notification job
  controllers/               request handlers, one per resource
  routes/                    validation + wiring per resource
  middleware/                auth, error handling, rate limiting, validation
  app.js / server.js
tests/
  attendanceEngine.test.js    16 tests on the core attendance math
  notificationEngine.test.js  tests on the notification trigger logic
  app.smoke.test.js           routing/auth/validation wiring (models + new routes included)
```

## Suggested next phase

Tell me to build the React web app next (dashboard, subject/timetable
management, calendar, reports) against this exact API — or the admin panel,
or the Flutter app. Building them against a proven, tested backend means the
UI work won't be chasing a moving target.
