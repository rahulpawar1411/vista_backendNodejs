// ====================================================================
// Authentication Controller (backend/controllers/authController.js)
// --------------------------------------------------------------------
// Login / logout / profile. JWT signed with getJwtSecret() from .env only.
// Lockout: 5 failed attempts within 1 hour → 30 min lock (loginSecurity.js).
// Errors: respondAuthServerError / checkpoints — do not leak SQL to clients.
// ====================================================================

const db = require('../config/db');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { getJwtSecret } = require('../utils/jwtSecret');
const { logActivity } = require('../utils/logger');
const { logErrorCheckpoint } = require('../utils/errorHandler');
const {
  checkLoginLock,
  recordFailedLogin,
  clearLoginSecurity,
  MAX_FAILED_ATTEMPTS
} = require('../utils/loginSecurity');

/**
 * Returns 500 for auth routes and logs a checkpoint without exposing SQL to the client.
 */
async function respondAuthServerError(res, error, options = {}) {
  const req = options.req || null;
  await logErrorCheckpoint(error, {
    checkpoint: options.checkpoint || 'auth',
    statusCode: 500,
    method: req?.method || null,
    url: req?.originalUrl || req?.url || null,
    email: req?.user?.email || options.email || 'system'
  });
  res.locals = res.locals || {};
  res.locals.errorCheckpointLogged = true;
  return res.status(500).json({
    success: false,
    message: options.clientMessage || 'A server error occurred. Please contact support.',
    error: error?.message
  });
}

// Expiration time: 24 hours
const TOKEN_EXPIRY_MS = 24 * 60 * 60 * 1000;

/**
 * Helper: Map selected UI Role to its corresponding DB Table Name.
 */
const getTableForRole = (role) => {
  switch (role) {
    case 'super_admin':
      return 'super_admin';
    case 'sub_admin':
      return 'sub_admins';
    case 'customer':
      return 'customers';
    case 'do_operator':
      return 'do_operators';
    default:
      return null;
  }
};

/** SELECT from customers table (scoped portal accounts). */
async function queryCustomers(sqlWithCustomers, params = []) {
  return db.query(sqlWithCustomers, params);
}

function lockedResponse(lockInfo) {
  const mins = lockInfo.minutesLeft || 30;
  return {
    success: false,
    locked: true,
    minutesLeft: mins,
    lockedUntil: lockInfo.lockedUntil || null,
    message: `Too many failed login attempts. This account is locked for ${mins} minute(s). Please try again later.`
  };
}

/**
 * 1. User Login Handler
 * Checks credentials against Bcrypt hash in role-specific DB table.
 * Sends signed JWT token in an HttpOnly secure Cookie.
 */
exports.login = async (req, res) => {
  try {
    const { email, password } = req.body;

    // 1. Validation Checks
    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: 'Please provide email and password.'
      });
    }

    const cleanEmail = email.trim().toLowerCase();

    // 1b. Temporary lockout check (all roles: super_admin / customer / do_operator)
    let lockState = { locked: false };
    try {
      lockState = await checkLoginLock(cleanEmail);
    } catch (lockErr) {
      console.warn('⚠️ checkLoginLock skipped:', lockErr.message);
    }
    if (lockState.locked) {
      logActivity(
        cleanEmail,
        'LOGIN_BLOCKED',
        'SECURITY',
        `Login blocked — account locked for ${lockState.minutesLeft} more minute(s)`
      ).catch(() => {});
      return res.status(429).json(lockedResponse(lockState));
    }

    let user = null;
    let resolvedRole = null;

    // A. Check in super_admin table
    const [superRows] = await db.query('SELECT * FROM super_admin WHERE email = ? LIMIT 1', [cleanEmail]);
    if (superRows.length > 0) {
      user = superRows[0];
      resolvedRole = 'super_admin';
    } else {
      // B. Mobile Sub-Admin (full app access)
      try {
        const [subAdminRows] = await db.query('SELECT * FROM sub_admins WHERE email = ? LIMIT 1', [cleanEmail]);
        if (subAdminRows.length > 0) {
          user = subAdminRows[0];
          resolvedRole = 'sub_admin';
        }
      } catch (subErr) {
        if (subErr.code !== 'ER_NO_SUCH_TABLE') throw subErr;
      }

      if (!user) {
        // C. Customer (scoped portal)
        try {
          const [custRows] = await queryCustomers('SELECT * FROM customers WHERE email = ? LIMIT 1', [cleanEmail]);
          if (custRows.length > 0) {
            user = custRows[0];
            resolvedRole = 'customer';
          }
        } catch (custErr) {
          if (custErr.code !== 'ER_NO_SUCH_TABLE') throw custErr;
        }
      }

      if (!user) {
        // D. Data Operator
        const [doRows] = await db.query('SELECT * FROM do_operators WHERE email = ? LIMIT 1', [cleanEmail]);
        if (doRows.length > 0) {
          user = doRows[0];
          resolvedRole = 'do_operator';
        }
      }
    }

    // 2. If user not found in any table
    if (!user) {
      console.warn(`⚠️ Security Warning: Failed login attempt for unregistered email: ${cleanEmail}`);
      const failInfo = await recordFailedLogin(cleanEmail, null);
      await logActivity(cleanEmail, 'LOGIN_FAILED', 'SECURITY', `Failed login attempt for unregistered email`);

      if (failInfo.locked) {
        await logActivity(
          cleanEmail,
          'LOGIN_LOCKED',
          'SECURITY',
          `Account locked for 30 minutes after ${MAX_FAILED_ATTEMPTS} failed attempts within 1 hour`
        );
        return res.status(429).json(lockedResponse(failInfo));
      }

      return res.status(401).json({
        success: false,
        remainingAttempts: failInfo.remainingAttempts,
        message: `Invalid email or password. Access Denied. (${failInfo.remainingAttempts} attempt(s) left before 30 min lock)`
      });
    }

    // 3. Verify Password Hash using Bcrypt
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      console.warn(`⚠️ Security Warning: Incorrect password entered for: ${cleanEmail} (Resolved Role: ${resolvedRole})`);
      const failInfo = await recordFailedLogin(cleanEmail, resolvedRole);
      await logActivity(
        cleanEmail,
        'LOGIN_FAILED',
        'SECURITY',
        `Incorrect password attempt for role: ${resolvedRole}`
      );

      if (failInfo.locked) {
        await logActivity(
          cleanEmail,
          'LOGIN_LOCKED',
          'SECURITY',
          `Role ${resolvedRole} account locked for 30 minutes after ${MAX_FAILED_ATTEMPTS} failed attempts within 1 hour`
        );
        return res.status(429).json(lockedResponse(failInfo));
      }

      return res.status(401).json({
        success: false,
        remainingAttempts: failInfo.remainingAttempts,
        message: `Invalid email or password. Access Denied. (${failInfo.remainingAttempts} attempt(s) left before 30 min lock)`
      });
    }

    // 4. Success — clear failed attempts (no lock if under 5 fails)
    try {
      await clearLoginSecurity(cleanEmail);
    } catch (secErr) {
      console.warn('⚠️ clearLoginSecurity skipped:', secErr.message);
    }

    // 5. Generate JSON Web Token (JWT)
    const tokenPayload = {
      id: user.id,
      email: user.email,
      role: resolvedRole,
      full_name: user.full_name || user.fullName || user.username || user.name || null,
      phone_no: user.phone_no || user.phone || null,
      warehouse_name: user.warehouse_name || user.warehouse || null,
      warehouse_code: user.warehouse_code || null,
      allowed_clients: user.allowed_clients || null,
      allowed_warehouses: user.allowed_warehouses || null,
      chamber_limit: user.chamber_limit || 4
    };

    const token = jwt.sign(
      tokenPayload,
      getJwtSecret(),
      { expiresIn: '24h' }
    );

    // 6. Send token in an HTTP-Only Secure Cookie
    const isProduction = process.env.NODE_ENV === 'production';
    res.cookie('token', token, {
      httpOnly: true,
      secure: isProduction,
      sameSite: isProduction ? 'none' : 'lax',
      maxAge: TOKEN_EXPIRY_MS
    });

    console.log(`🔐 Success: User ${cleanEmail} authenticated successfully. Role: ${resolvedRole}`);
    const loginName = tokenPayload.full_name ? String(tokenPayload.full_name).trim() : '';
    const loginWho =
      resolvedRole === 'do_operator' && loginName
        ? `DO Operator ${loginName} (${cleanEmail})`
        : `${resolvedRole} (${cleanEmail})`;
    // Do not block login response if activity log is slow / pool busy
    logActivity(cleanEmail, 'LOGIN', 'SECURITY', `Authenticated successfully as ${loginWho}`).catch(() => {});

    return res.status(200).json({
      success: true,
      message: 'Logged in successfully.',
      token,
      user: tokenPayload
    });
  } catch (error) {
    return respondAuthServerError(res, error, {
      checkpoint: 'login',
      req,
      clientMessage: 'A server error occurred during login. Please contact support.'
    });
  }
};

/**
 * 2. User Logout Handler
 * Clears the verification JWT token cookie.
 */
exports.logout = (req, res) => {
  try {
    const isProduction = process.env.NODE_ENV === 'production';
    res.clearCookie('token', {
      httpOnly: true,
      sameSite: isProduction ? 'none' : 'lax',
      secure: isProduction
    });

    console.log('🔐 Success: User session cleared successfully.');
    return res.status(200).json({
      success: true,
      message: 'Logged out successfully.'
    });
  } catch (error) {
    return respondAuthServerError(res, error, {
      checkpoint: 'logout',
      req,
      clientMessage: 'Server error while clearing session.'
    });
  }
};

/**
 * 3. Super Admin Profile Access Verification
 * Verifies ID (email) + password before showing profile reset form.
 */
exports.verifySuperAdminProfileAccess = async (req, res) => {
  try {
    const sessionEmail = req.user?.email;
    if (!sessionEmail || req.user?.role !== 'super_admin') {
      return res.status(403).json({
        success: false,
        message: 'Only Super Admin can access this section.'
      });
    }

    const { email, password } = req.body || {};
    const cleanEmail = String(email || '').trim().toLowerCase();
    if (!cleanEmail || !password) {
      return res.status(400).json({
        success: false,
        message: 'Please enter your ID and password.'
      });
    }
    if (cleanEmail !== String(sessionEmail).toLowerCase()) {
      return res.status(403).json({
        success: false,
        message: 'Please use your currently logged-in Super Admin ID.'
      });
    }

    const [rows] = await db.query('SELECT * FROM super_admin WHERE email = ? LIMIT 1', [cleanEmail]);
    if (!rows.length) {
      return res.status(404).json({
        success: false,
        message: 'Super Admin account not found.'
      });
    }

    const admin = rows[0];
    const ok = await bcrypt.compare(password, admin.password);
    if (!ok) {
      await logActivity(cleanEmail, 'PROFILE_ACCESS_FAILED', 'SECURITY', 'Profile access denied due to incorrect password.');
      return res.status(401).json({
        success: false,
        message: 'Invalid ID or password.'
      });
    }

    await logActivity(cleanEmail, 'PROFILE_ACCESS_VERIFIED', 'SECURITY', 'Profile access verified successfully.');
    return res.status(200).json({
      success: true,
      message: 'Identity verified.',
      profile: {
        email: admin.email,
        full_name: admin.full_name || null
      }
    });
  } catch (error) {
    return respondAuthServerError(res, error, {
      checkpoint: 'verifySuperAdminProfileAccess',
      req,
      clientMessage: 'Server error while verifying profile access.'
    });
  }
};

/**
 * 4. Super Admin Profile Update (email and/or password)
 * Requires active login + current password confirmation.
 */
exports.changeSuperAdminPassword = async (req, res) => {
  try {
    const sessionEmail = req.user?.email;
    if (!sessionEmail || req.user?.role !== 'super_admin') {
      return res.status(403).json({
        success: false,
        message: 'Only Super Admin can update this profile.'
      });
    }

    const { currentPassword, newPassword, email: nextEmailRaw } = req.body || {};
    if (!currentPassword) {
      return res.status(400).json({
        success: false,
        message: 'Current password is required to save profile changes.'
      });
    }

    const nextEmail = typeof nextEmailRaw === 'string' ? nextEmailRaw.trim().toLowerCase() : '';
    const wantsEmailChange = Boolean(nextEmail) && nextEmail !== String(sessionEmail).toLowerCase();
    const wantsPasswordChange = Boolean(newPassword);

    if (!wantsEmailChange && !wantsPasswordChange) {
      return res.status(400).json({
        success: false,
        message: 'Update email and/or password to save changes.'
      });
    }

    if (wantsPasswordChange && String(newPassword).length < 8) {
      return res.status(400).json({
        success: false,
        message: 'New password must be at least 8 characters long.'
      });
    }

    if (wantsEmailChange) {
      const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(nextEmail);
      if (!emailOk) {
        return res.status(400).json({
          success: false,
          message: 'Please enter a valid email address.'
        });
      }
    }

    const [rows] = await db.query(
      'SELECT * FROM super_admin WHERE email = ? LIMIT 1',
      [sessionEmail]
    );
    if (!rows.length) {
      return res.status(404).json({
        success: false,
        message: 'Super Admin account not found.'
      });
    }

    const admin = rows[0];
    const isCurrentMatch = await bcrypt.compare(currentPassword, admin.password);
    if (!isCurrentMatch) {
      await logActivity(sessionEmail, 'PROFILE_UPDATE_FAILED', 'SECURITY', 'Incorrect current password entered.');
      return res.status(401).json({
        success: false,
        message: 'Current password is incorrect.'
      });
    }

    if (wantsEmailChange) {
      const [superDup] = await db.query(
        'SELECT id FROM super_admin WHERE email = ? AND id <> ? LIMIT 1',
        [nextEmail, admin.id]
      );
      if (superDup.length) {
        return res.status(409).json({
          success: false,
          message: 'This email is already used by another Super Admin account.'
        });
      }

      const [subDup] = await queryCustomers('SELECT id FROM customers WHERE email = ? LIMIT 1', [nextEmail]);
      if (subDup.length) {
        return res.status(409).json({
          success: false,
          message: 'This email is already used by a Customer account.'
        });
      }

      const [opDup] = await db.query('SELECT id FROM do_operators WHERE email = ? LIMIT 1', [nextEmail]);
      if (opDup.length) {
        return res.status(409).json({
          success: false,
          message: 'This email is already used by a Data Operator account.'
        });
      }
    }

    let hashed = null;
    if (wantsPasswordChange) {
      const isSamePassword = await bcrypt.compare(newPassword, admin.password);
      if (isSamePassword) {
        return res.status(400).json({
          success: false,
          message: 'New password must be different from current password.'
        });
      }
      const salt = await bcrypt.genSalt(10);
      hashed = await bcrypt.hash(newPassword, salt);
    }

    const finalEmail = wantsEmailChange ? nextEmail : admin.email;
    if (wantsEmailChange && wantsPasswordChange) {
      await db.query('UPDATE super_admin SET email = ?, password = ? WHERE id = ?', [finalEmail, hashed, admin.id]);
    } else if (wantsEmailChange) {
      await db.query('UPDATE super_admin SET email = ? WHERE id = ?', [finalEmail, admin.id]);
    } else {
      await db.query('UPDATE super_admin SET password = ? WHERE id = ?', [hashed, admin.id]);
    }

    const tokenPayload = {
      id: admin.id,
      email: finalEmail,
      role: 'super_admin',
      full_name: admin.full_name || req.user?.full_name || null,
      phone_no: admin.phone_no || req.user?.phone_no || null,
      warehouse_name: req.user?.warehouse_name || null,
      allowed_clients: req.user?.allowed_clients || null,
      allowed_warehouses: req.user?.allowed_warehouses || null
    };

    const token = jwt.sign(
      tokenPayload,
      getJwtSecret(),
      { expiresIn: '24h' }
    );

    const isProduction = process.env.NODE_ENV === 'production';
    res.cookie('token', token, {
      httpOnly: true,
      secure: isProduction,
      sameSite: isProduction ? 'none' : 'lax',
      maxAge: TOKEN_EXPIRY_MS
    });

    const changedParts = [];
    if (wantsEmailChange) changedParts.push('email');
    if (wantsPasswordChange) changedParts.push('password');
    await logActivity(
      finalEmail,
      'PROFILE_UPDATED',
      'SECURITY',
      `Super Admin updated ${changedParts.join(' and ')} from profile window${wantsEmailChange ? ` (from ${sessionEmail})` : ''}.`
    );

    return res.status(200).json({
      success: true,
      message: wantsEmailChange && wantsPasswordChange
        ? 'Email and password updated successfully.'
        : wantsEmailChange
          ? 'Email updated successfully.'
          : 'Password updated successfully.',
      user: tokenPayload
    });
  } catch (error) {
    return respondAuthServerError(res, error, {
      checkpoint: 'updateSuperAdminProfile',
      req,
      clientMessage: 'Server error while updating profile.'
    });
  }
};

/**
 * 5. Token Profile Verification Handler (Get Logged In User Info)
 * Decodes active token cookie and returns session data.
 */
exports.getMe = async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'No active session found.'
      });
    }

    const user = { ...req.user };
    if (user.role === 'customer') {
      try {
        const { resolveScopeTokens } = require('../utils/scopeResolve');
        const { clientsStr, warehousesStr } = await resolveScopeTokens({
          clientsCsv: user.allowed_clients,
          warehousesCsv: user.allowed_warehouses
        });
        user.allowed_clients = clientsStr;
        user.allowed_warehouses = warehousesStr;
      } catch (_) {
        /* keep raw scope */
      }
    }

    return res.status(200).json({
      success: true,
      user
    });
  } catch (error) {
    return respondAuthServerError(res, error, {
      checkpoint: 'getMe',
      req,
      clientMessage: 'Server error retrieving user profile.'
    });
  }
};

/**
 * 6. Register Expo push token (Sub-Admin + DO — alerts when app is closed).
 */
exports.registerPushToken = async (req, res) => {
  try {
    const role = req.user?.role;
    if (role !== 'sub_admin' && role !== 'do_operator') {
      return res.status(403).json({
        success: false,
        message: 'Only Sub-Admin or DO accounts can register a push token.'
      });
    }

    const token = String(req.body?.expo_push_token || req.body?.token || '').trim();
    if (!token) {
      return res.status(400).json({
        success: false,
        message: 'expo_push_token is required.'
      });
    }
    if (!token.startsWith('ExponentPushToken[') && !token.startsWith('ExpoPushToken[')) {
      return res.status(400).json({
        success: false,
        message: 'Invalid Expo push token format.'
      });
    }

    const email = req.user.email;
    const table = role === 'sub_admin' ? 'sub_admins' : 'do_operators';

    // Device moved accounts: same physical token should only belong to this user
    try {
      await db.query(
        `UPDATE sub_admins SET expo_push_token = NULL, updated_at = NOW()
         WHERE expo_push_token = ? AND email <> ?`,
        [token, email]
      );
    } catch (_) {
      /* ignore */
    }
    try {
      await db.query(
        `UPDATE do_operators SET expo_push_token = NULL
         WHERE expo_push_token = ? AND email <> ?`,
        [token, email]
      );
    } catch (_) {
      /* ignore */
    }

    if (table === 'sub_admins') {
      await db.query(
        'UPDATE sub_admins SET expo_push_token = ?, updated_at = NOW() WHERE email = ? LIMIT 1',
        [token, email]
      );
    } else {
      try {
        await db.query(
          'UPDATE do_operators SET expo_push_token = ?, updated_at = NOW() WHERE email = ? LIMIT 1',
          [token, email]
        );
      } catch (err) {
        if (/Unknown column 'updated_at'/i.test(String(err.message || ''))) {
          await db.query(
            'UPDATE do_operators SET expo_push_token = ? WHERE email = ? LIMIT 1',
            [token, email]
          );
        } else {
          throw err;
        }
      }
    }

    return res.status(200).json({ success: true, message: 'Push token saved.', role });
  } catch (error) {
    return respondAuthServerError(res, error, {
      checkpoint: 'registerPushToken',
      req,
      clientMessage: 'Failed to save push token.'
    });
  }
};

/**
 * Clear push token on logout (stops alerts on this device).
 */
exports.clearPushToken = async (req, res) => {
  try {
    const role = req.user?.role;
    if (role !== 'sub_admin' && role !== 'do_operator') {
      return res.status(200).json({ success: true });
    }
    const email = req.user.email;
    if (role === 'sub_admin') {
      await db.query(
        'UPDATE sub_admins SET expo_push_token = NULL, updated_at = NOW() WHERE email = ? LIMIT 1',
        [email]
      );
    } else {
      try {
        await db.query(
          'UPDATE do_operators SET expo_push_token = NULL, updated_at = NOW() WHERE email = ? LIMIT 1',
          [email]
        );
      } catch (err) {
        if (/Unknown column 'updated_at'/i.test(String(err.message || ''))) {
          await db.query(
            'UPDATE do_operators SET expo_push_token = NULL WHERE email = ? LIMIT 1',
            [email]
          );
        } else {
          throw err;
        }
      }
    }
    return res.status(200).json({ success: true });
  } catch (error) {
    return respondAuthServerError(res, error, {
      checkpoint: 'clearPushToken',
      req,
      clientMessage: 'Failed to clear push token.'
    });
  }
};

// Keep helper export for tests / future role-specific routes
exports.getTableForRole = getTableForRole;
