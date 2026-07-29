'use strict';

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const compression = require('compression');

const { apiLimiter } = require('./middleware/rateLimiters');
const { errorHandler, notFound } = require('./middleware/errorHandler');

const authRoutes = require('./routes/authRoutes');
const setupRoutes = require('./routes/setupRoutes');
const subjectRoutes = require('./routes/subjectRoutes');
const timetableRoutes = require('./routes/timetableRoutes');
const attendanceRoutes = require('./routes/attendanceRoutes');
const holidayRoutes = require('./routes/holidayRoutes');
const notificationRoutes = require('./routes/notificationRoutes');

function createApp() {
  const app = express();

  app.use(helmet());
  app.use(cors());
  app.use(compression());
  app.use(express.json({ limit: '2mb' }));
  if (process.env.NODE_ENV !== 'test') {
    app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
  }
  app.use('/api', apiLimiter);

  app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

  app.use('/api/auth', authRoutes);
  app.use('/api/setup', setupRoutes);
  app.use('/api/subjects', subjectRoutes);
  app.use('/api/timetable', timetableRoutes);
  app.use('/api/attendance', attendanceRoutes);
  app.use('/api/holidays', holidayRoutes);
  app.use('/api/notifications', notificationRoutes);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
