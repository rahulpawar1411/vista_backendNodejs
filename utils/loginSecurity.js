// ====================================================================
// Login security: failed-attempt window + temporary lockout
// Rule: 5 failures within 1 hour → lock account (email) for 30 minutes.
// Successful login clears the counter (no lock).
// ====================================================================

const db = require('../config/db');

const FAIL_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const MAX_FAILED_ATTEMPTS = 5;
const LOCK_DURATION_MS = 30 * 60 * 1000; // 30 minutes

/** TEMP: lock/wait off unless LOGIN_LOCKOUT=true */
/** Lockout runs only when LOGIN_LOCKOUT=true in production .env. */
function lockoutEnabled() {
  return String(process.env.LOGIN_LOCKOUT || '').toLowerCase() === 'true';
}

function minutesLeft(untilDate) {
  const ms = new Date(untilDate).getTime() - Date.now();
  return Math.max(1, Math.ceil(ms / 60000));
}

function toMysqlDateTime(date) {
  const d = date instanceof Date ? date : new Date(date);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Loads one login_security row for this email (failed count and lock expiry). */
async function getRow(email) {
  const [rows] = await db.query(
    'SELECT * FROM login_security WHERE email = ? LIMIT 1',
    [email]
  );
  return rows[0] || null;
}

/**
 * If account is locked, return lock info. Expired locks are cleared.
 */
async function checkLoginLock(email) {
  if (!lockoutEnabled()) return { locked: false };
  const row = await getRow(email);
  if (!row || !row.locked_until) {
    return { locked: false };
  }

  const until = new Date(row.locked_until);
  if (until.getTime() > Date.now()) {
    return {
      locked: true,
      lockedUntil: until.toISOString(),
      minutesLeft: minutesLeft(until),
      role: row.role || null
    };
  }

  // Lock expired — reset so user can try again
  await db.query(
    `UPDATE login_security
     SET failed_count = 0, window_started_at = NULL, locked_until = NULL
     WHERE email = ?`,
    [email]
  );
  return { locked: false };
}

/**
 * Record a failed login. Locks after 5 fails inside the 1-hour window.
 */
async function recordFailedLogin(email, role = null) {
  if (!lockoutEnabled()) {
    return { failedCount: 0, locked: false, remainingAttempts: 999 };
  }
  const now = new Date();
  const row = await getRow(email);

  if (!row) {
    await db.query(
      `INSERT INTO login_security
        (email, role, failed_count, window_started_at, last_failed_at, locked_until)
       VALUES (?, ?, 1, ?, ?, NULL)`,
      [email, role, toMysqlDateTime(now), toMysqlDateTime(now)]
    );
    return {
      failedCount: 1,
      locked: false,
      remainingAttempts: MAX_FAILED_ATTEMPTS - 1
    };
  }

  let failedCount = Number(row.failed_count) || 0;
  let windowStarted = row.window_started_at ? new Date(row.window_started_at) : null;

  const windowExpired =
    !windowStarted || Number.isNaN(windowStarted.getTime()) || (now - windowStarted) > FAIL_WINDOW_MS;

  if (windowExpired) {
    failedCount = 1;
    windowStarted = now;
  } else {
    failedCount += 1;
  }

  if (failedCount >= MAX_FAILED_ATTEMPTS) {
    const lockedUntil = new Date(now.getTime() + LOCK_DURATION_MS);
    await db.query(
      `UPDATE login_security
       SET role = COALESCE(?, role),
           failed_count = ?,
           window_started_at = ?,
           last_failed_at = ?,
           locked_until = ?
       WHERE email = ?`,
      [
        role,
        failedCount,
        toMysqlDateTime(windowStarted),
        toMysqlDateTime(now),
        toMysqlDateTime(lockedUntil),
        email
      ]
    );
    return {
      failedCount,
      locked: true,
      lockedUntil: lockedUntil.toISOString(),
      minutesLeft: 30,
      remainingAttempts: 0
    };
  }

  await db.query(
    `UPDATE login_security
     SET role = COALESCE(?, role),
         failed_count = ?,
         window_started_at = ?,
         last_failed_at = ?,
         locked_until = NULL
     WHERE email = ?`,
    [role, failedCount, toMysqlDateTime(windowStarted), toMysqlDateTime(now), email]
  );

  return {
    failedCount,
    locked: false,
    remainingAttempts: MAX_FAILED_ATTEMPTS - failedCount
  };
}

/**
 * Clear counters after a successful login.
 */
async function clearLoginSecurity(email) {
  await db.query(
    `UPDATE login_security
     SET failed_count = 0,
         window_started_at = NULL,
         locked_until = NULL,
         last_failed_at = NULL
     WHERE email = ?`,
    [email]
  );
}

module.exports = {
  FAIL_WINDOW_MS,
  MAX_FAILED_ATTEMPTS,
  LOCK_DURATION_MS,
  checkLoginLock,
  recordFailedLogin,
  clearLoginSecurity
};
