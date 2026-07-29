'use strict';

require('dotenv').config();
const { createApp } = require('./app');
const { connectDB } = require('./config/db');
const { startNotificationScheduler } = require('./jobs/scheduler');

const PORT = process.env.PORT || 5000;

async function start() {
  try {
    await connectDB();
    // eslint-disable-next-line no-console
    console.log('[mongodb] connected');

    const app = createApp();
    app.listen(PORT, () => {
      // eslint-disable-next-line no-console
      console.log(`[server] Bunk Manager API listening on port ${PORT}`);
    });

    if (process.env.DISABLE_NOTIFICATION_SCHEDULER !== 'true') {
      startNotificationScheduler();
      // eslint-disable-next-line no-console
      console.log('[notifications] scheduler started');
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[server] Failed to start:', err.message);
    process.exit(1);
  }
}

start();
