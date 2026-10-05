// ====================================================================
// Authentication Middleware (backend/middleware/auth.js)
// --------------------------------------------------------------------
// Flow:
//   1) Read Bearer token (preferred) or HttpOnly cookie
//   2) Verify JWT with getJwtSecret() from .env (no hard-coded fallback)
//   3) Confirm user still exists in MySQL (role-specific table)
//   4) Attach req.user and call next()
//
// Fail-closed rules (important for security):
//   - Missing JWT_SECRET / config error → 503 (do not accept tokens)
//   - DB outage during user lookup → 503 (do NOT allow the request)
//   - User deleted / unknown role → 401
//   - Bad / expired JWT → 401 or 403
//
// Mount order on routes:
//   router.get('/x', verifyToken, requireRole(['super_admin']), handler);
// ====================================================================

const jwt = require('jsonwebtoken');
const db = require('../config/db');
const { getJwtSecret } = require('../utils/jwtSecret');

/**
 * Normalizes JWT role string before DB lookup (no remapping today).
 * WHY: Single place to fix legacy role names without changing every route.
 */
function normalizeRole(role) {
  // Keep sub_admin as mobile full-access role (do NOT map to customer)
  return role;
}

/**
 * Loads customer row for scope checks.
 * WHY: allowed_clients/warehouses must come from DB, not stale JWT claims.
 */
async function loadCustomerByEmail(email) {
  const [rows] = await db.query(
    'SELECT id, allowed_clients, allowed_warehouses, full_name, phone_no FROM customers WHERE email = ? LIMIT 1',
    [email]
  );
  return rows;
}

/** Loads mobile Sub-Admin profile fields to enrich req.user after JWT verify. */
async function loadSubAdminByEmail(email) {
  const [rows] = await db.query(
    'SELECT id, full_name, phone_no FROM sub_admins WHERE email = ? LIMIT 1',
    [email]
  );
  return rows;
}

/**
 * WHAT: Validates JWT and attaches req.user for downstream handlers.
 * WHY: Every protected API must know who is calling and that the account still exists.
 * HOW: Bearer header first, then cookie; verify signature; re-query MySQL by role.
 */
exports.verifyToken = async (req, res, next) => {
  try {
    // Prefer Authorization: Bearer … (mobile + fresh web login). Cookie is fallback for browser sessions.
    let token = null;
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
      token = req.headers.authorization.substring(7);
    }
    if (!token) {
      token = req.cookies.token;
    }

    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'Access Denied: No authentication token provided. Please log in.'
      });
    }

    // Signature check — ConfigError means .env is broken, not that the token is invalid
    let decoded;
    try {
      decoded = jwt.verify(token, getJwtSecret());
    } catch (jwtErr) {
      if (jwtErr.statusCode === 500 || jwtErr.type === 'ConfigError') {
        return res.status(503).json({
          success: false,
          message: 'Authentication is temporarily unavailable (server config).'
        });
      }
      throw jwtErr; // TokenExpiredError / JsonWebTokenError → outer catch
    }

    decoded.role = normalizeRole(decoded.role);

    // Live DB check: JWT alone is not enough (deleted accounts, refreshed customer scope)
    let userExists = false;
    try {
      if (decoded.role === 'super_admin') {
        const [rows] = await db.query('SELECT id FROM super_admin WHERE email = ? LIMIT 1', [
          decoded.email
        ]);
        if (rows.length > 0) userExists = true;
      } else if (decoded.role === 'sub_admin') {
        const rows = await loadSubAdminByEmail(decoded.email);
        if (rows.length > 0) {
          userExists = true;
          decoded.id = rows[0].id;
          if (rows[0].full_name) decoded.full_name = rows[0].full_name;
          if (rows[0].phone_no) decoded.phone_no = rows[0].phone_no;
        }
      } else if (decoded.role === 'customer') {
        const rows = await loadCustomerByEmail(decoded.email);
        if (rows.length > 0) {
          userExists = true;
          // Always prefer DB access lists over stale claims inside the JWT
          decoded.id = rows[0].id;
          decoded.allowed_clients = rows[0].allowed_clients;
          decoded.allowed_warehouses = rows[0].allowed_warehouses;
          if (rows[0].full_name) decoded.full_name = rows[0].full_name;
          if (rows[0].phone_no) decoded.phone_no = rows[0].phone_no;
        }
      } else if (decoded.role === 'do_operator') {
        const [rows] = await db.query(
          'SELECT id, warehouse_name, warehouse_code, chamber_limit, full_name, phone_no FROM do_operators WHERE email = ? LIMIT 1',
          [decoded.email]
        );
        if (rows.length > 0) {
          userExists = true;
          decoded.id = rows[0].id;
          // Always prefer live warehouse / limit over stale JWT claims
          if (rows[0].warehouse_name != null) decoded.warehouse_name = rows[0].warehouse_name;
          if (rows[0].warehouse_code != null) decoded.warehouse_code = rows[0].warehouse_code;
          if (rows[0].chamber_limit != null) decoded.chamber_limit = rows[0].chamber_limit;
          if (rows[0].full_name) decoded.full_name = rows[0].full_name;
          if (rows[0].phone_no) decoded.phone_no = rows[0].phone_no;
        }
      }
    } catch (dbErr) {
      // Fail-closed: never treat a DB error as "user is fine"
      console.error('❌ DB verifyToken check failed (fail-closed):', dbErr.message);
      return res.status(503).json({
        success: false,
        message: 'Unable to verify your session right now. Please try again shortly.'
      });
    }

    if (!userExists) {
      return res.status(401).json({
        success: false,
        message: 'Your account has been deleted or disabled. Please log in again.'
      });
    }

    req.user = decoded;
    return next();
  } catch (error) {
    console.error('❌ JWT Verification Error:', error.message);

    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        message: 'Your session has expired. Please log in again.'
      });
    }

    return res.status(403).json({
      success: false,
      message: 'Invalid signature or corrupt token. Authentication failed.'
    });
  }
};

/**
 * WHAT: Allows the request only if req.user.role is in allowedRoles.
 * WHY: Same login token must not reach Super Admin-only routes (e.g. delete user).
 * HOW: Returns 403 JSON when role is missing from the list; run after verifyToken.
 * @param {string[]} allowedRoles e.g. ['super_admin', 'sub_admin']
 */
exports.requireRole = (allowedRoles = []) => {
  return (req, res, next) => {
    try {
      if (!req.user || !req.user.role) {
        return res.status(401).json({
          success: false,
          message: 'Unauthorized: User authentication context missing.'
        });
      }

      if (!allowedRoles.includes(req.user.role)) {
        return res.status(403).json({
          success: false,
          message: `Access Denied: Role '${req.user.role}' does not have permission to access this resource.`
        });
      }

      return next();
    } catch (error) {
      console.error('❌ Role Authorization Error:', error.message);
      return res.status(500).json({
        success: false,
        message: 'Internal server error during authorization check.'
      });
    }
  };
};

/** Exported for tests or auth controller that reuses the same role normalization. */
exports.normalizeRole = normalizeRole;
