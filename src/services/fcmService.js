/**
 * Thin wrapper around firebase-admin's FCM sender. Credentials are read
 * lazily from env vars so requiring this file never crashes when Firebase
 * isn't configured (local dev, tests, CI) — sendPushToTokens simply logs
 * and no-ops instead of throwing, so the rest of the notification
 * pipeline (in-app log, dedup) keeps working without a real project.
 */

'use strict';

let adminInstance = null;
let warned = false;

function getAdmin() {
  if (adminInstance) return adminInstance;

  const { FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY } = process.env;
  if (!FIREBASE_PROJECT_ID || !FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY) {
    if (!warned) {
      // eslint-disable-next-line no-console
      console.warn(
        '[fcm] Firebase credentials not configured — pushes will be logged, not sent. ' +
          'Set FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY to enable delivery.'
      );
      warned = true;
    }
    return null;
  }

  // eslint-disable-next-line global-require
  const admin = require('firebase-admin');
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: FIREBASE_PROJECT_ID,
        clientEmail: FIREBASE_CLIENT_EMAIL,
        privateKey: FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      }),
    });
  }
  adminInstance = admin;
  return adminInstance;
}

const INVALID_TOKEN_ERROR_CODES = new Set([
  'messaging/invalid-registration-token',
  'messaging/registration-token-not-registered',
]);

/**
 * Sends one push to every given device token.
 * @returns {Promise<{sent:number, invalidTokens:string[]}>} invalidTokens
 *   are tokens FCM reports as dead/unregistered — the caller should strip
 *   these from the user's fcmTokens so retries don't keep hitting them.
 */
async function sendPushToTokens(tokens, { title, body, data = {} }) {
  const validTokens = (tokens || []).filter(Boolean);
  if (!validTokens.length) return { sent: 0, invalidTokens: [] };

  const admin = getAdmin();
  if (!admin) {
    // eslint-disable-next-line no-console
    console.log(`[fcm:dry-run] ${title} — ${body} (${validTokens.length} token(s))`);
    return { sent: 0, invalidTokens: [] };
  }

  const stringData = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)]));

  const response = await admin.messaging().sendEachForMulticast({
    tokens: validTokens,
    notification: { title, body },
    data: stringData,
  });

  const invalidTokens = [];
  response.responses.forEach((r, i) => {
    if (!r.success && r.error && INVALID_TOKEN_ERROR_CODES.has(r.error.code)) {
      invalidTokens.push(validTokens[i]);
    }
  });

  return { sent: response.successCount, invalidTokens };
}

module.exports = { sendPushToTokens };
