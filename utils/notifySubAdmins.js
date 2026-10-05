// ====================================================================
// Mobile push notifications (utils/notifySubAdmins.js)
// WHAT: Sends Expo push when permissions are requested or decided.
// WHY: Sub-Admins and DOs get alerts even when the app is closed.
// HOW: Reads expo_push_token from DB; dead tokens cleared via expoPush.js.
// ====================================================================

const db = require('../config/db');
const {
  sendExpoPush,
  isExpoPushToken,
  SUB_ADMIN_PUSH_CLEANUP,
  DO_PUSH_CLEANUP
} = require('./expoPush');

/**
 * Notify every Sub Admin that has a live expo_push_token.
 * Fire-and-forget from createPermissionRequest — must not block the API.
 */
async function notifySubAdminsPermissionRequest({ operatorEmail, recordType, action } = {}) {
  try {
    const [rows] = await db.query(
      `SELECT id, email, expo_push_token FROM sub_admins
       WHERE expo_push_token IS NOT NULL AND TRIM(expo_push_token) <> ''`
    );
    const tokens = (rows || [])
      .map((r) => r.expo_push_token)
      .filter((t) => isExpoPushToken(t));
    if (!tokens.length) return;

    const who = String(operatorEmail || 'A DO').trim() || 'A DO';
    const typeLabel = String(recordType || 'record').trim() || 'record';
    const act = String(action || 'Edit').trim() || 'Edit';

    await sendExpoPush(
      tokens,
      {
        title: 'New permission request',
        body: `${who} requested ${act} on ${typeLabel} — open Admin to review`,
        data: { screen: 'Admin', section: 'permissions', type: 'permission_request' },
        channelId: 'permission-alerts'
      },
      { db, cleanupTargets: SUB_ADMIN_PUSH_CLEANUP }
    );
  } catch (err) {
    console.warn('notifySubAdminsPermissionRequest:', err?.message || err);
  }
}

/**
 * Push to a DO when their permission request is Approved or Denied (works if app is closed).
 */
async function notifyDoOperatorPermissionDecision({
  operatorEmail,
  status,
  recordType,
  adminRemark
} = {}) {
  try {
    const email = String(operatorEmail || '').trim();
    if (!email) return;

    const [rows] = await db.query(
      `SELECT expo_push_token FROM do_operators
       WHERE email = ? AND expo_push_token IS NOT NULL AND TRIM(expo_push_token) <> ''
       LIMIT 1`,
      [email]
    );
    const token = rows?.[0]?.expo_push_token;
    if (!isExpoPushToken(token)) return;

    const decided = String(status || '').toLowerCase() === 'denied' ? 'Denied' : 'Approved';
    const typeLabel = String(recordType || 'request').trim() || 'request';
    const remark = String(adminRemark || '').trim();
    const body =
      decided === 'Denied'
        ? remark
          ? `Your ${typeLabel} request was denied. Admin remark: ${remark}`
          : `Your ${typeLabel} request was denied. Open the app for details.`
        : `Your ${typeLabel} request was approved. Open the app to continue.`;

    await sendExpoPush(
      [token],
      {
        title: decided === 'Denied' ? 'Permission denied' : 'Permission approved',
        body,
        data: {
          screen: 'Notifications',
          type: 'permission_decision',
          status: decided
        },
        channelId: 'permission-alerts'
      },
      { db, cleanupTargets: DO_PUSH_CLEANUP }
    );
  } catch (err) {
    console.warn('notifyDoOperatorPermissionDecision:', err?.message || err);
  }
}

module.exports = {
  notifySubAdminsPermissionRequest,
  notifyDoOperatorPermissionDecision
};
