// ====================================================================
// Activity audit logger (utils/logger.js)
// Writes human-readable rows to do_operator_activities for admin history.
// ====================================================================

const db = require('../config/db');

/**
 * Who performed the action — used in activity audit descriptions.
 * For DO operators, includes full name when available (JWT or DB lookup).
 */
exports.getActorLabel = async (user) => {
  if (!user || !user.email) return 'Unknown';

  let name = String(user.full_name || '').trim();
  if (!name && user.role === 'do_operator') {
    try {
      const [rows] = await db.query(
        'SELECT full_name FROM do_operators WHERE email = ? LIMIT 1',
        [user.email]
      );
      name = String(rows[0]?.full_name || '').trim();
    } catch (_) {
      /* ignore lookup failures */
    }
  }
  if (!name && user.role === 'sub_admin') {
    try {
      const [rows] = await db.query(
        'SELECT full_name FROM sub_admins WHERE email = ? LIMIT 1',
        [user.email]
      );
      name = String(rows[0]?.full_name || '').trim();
    } catch (_) {
      /* ignore */
    }
  }

  if (user.role === 'super_admin') {
    return name ? `Super Admin ${name} (${user.email})` : `Super Admin (${user.email})`;
  }
  if (user.role === 'sub_admin') {
    return name ? `Sub-Admin ${name} (${user.email})` : `Sub-Admin (${user.email})`;
  }
  if (user.role === 'customer') {
    return name ? `Customer ${name} (${user.email})` : `Customer (${user.email})`;
  }
  if (user.role === 'do_operator') {
    return name
      ? `DO Operator ${name} (${user.email})`
      : `DO Operator (${user.email})`;
  }
  return name ? `${name} (${user.email})` : user.email;
};

/**
 * Inserts one activity row (login, edit, permission, system events).
 * HOW: Best-effort — failures are logged but do not block the main API response.
 */
exports.logActivity = async (email, action, logType, description, permissionReqId = null, remark = null) => {
  try {
    await db.query(
      'INSERT INTO do_operator_activities (operator_email, action, log_type, description, permission_req, remark) VALUES (?, ?, ?, ?, ?, ?)',
      [
        email || 'system',
        action,
        logType,
        description,
        permissionReqId,
        remark != null && String(remark).trim() !== '' ? String(remark).trim() : null
      ]
    );
  } catch (err) {
    // Fallback if remark column not yet migrated
    if (err && /Unknown column 'remark'/i.test(String(err.message || ''))) {
      try {
        await db.query(
          'INSERT INTO do_operator_activities (operator_email, action, log_type, description, permission_req) VALUES (?, ?, ?, ?, ?)',
          [email || 'system', action, logType, description, permissionReqId]
        );
        return;
      } catch (err2) {
        console.error('Failed to write operator activity log:', err2);
        return;
      }
    }
    console.error('Failed to write operator activity log:', err);
  }
};

/** Pull trailing "Remark: …" from free-text descriptions. */
exports.extractRemark = (text) => {
  const m = String(text || '').match(/(?:Remark|Remarks?)\s*:\s*(.+)$/im);
  return m ? String(m[1] || '').trim() : '';
};
