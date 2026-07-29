'use strict';

const mongoose = require('mongoose');

/**
 * Connects to MongoDB using MONGO_URI from the environment.
 * Retries are intentionally NOT automatic here — fail fast on boot so
 * deployment issues are caught immediately rather than serving requests
 * against a dead DB connection.
 */
async function connectDB() {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    throw new Error(
      'MONGO_URI is not set. Copy .env.example to .env and provide a MongoDB connection string ' +
        '(e.g. a free MongoDB Atlas cluster or a local mongod instance).'
    );
  }

  mongoose.set('strictQuery', true);

  await mongoose.connect(uri, {
    autoIndex: process.env.NODE_ENV !== 'production',
  });

  mongoose.connection.on('error', (err) => {
    // eslint-disable-next-line no-console
    console.error('[mongodb] connection error:', err.message);
  });

  return mongoose.connection;
}

module.exports = { connectDB };
