// ====================================================================
// App Sub-Admin Controller — full-access mobile Sub-Admins
// Table: sub_admins (separate from customers)
// ====================================================================

const db = require('../config/db');
const bcrypt = require('bcryptjs');
const { logActivity } = require('../utils/logger');
const { handleControllerError } = require('../utils/errorHandler');

let tableReady = false;

/**
 * Creates sub_admins table on first use if migrations have not run yet.
 * WHY: Super Admin can add mobile Sub-Admins even on a fresh database file.
 */
async function ensureSubAdminsTable() {
  if (tableReady) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS sub_admins (
      id INT AUTO_INCREMENT PRIMARY KEY,
      email VARCHAR(150) NOT NULL UNIQUE,
      password VARCHAR(255) NOT NULL,
      full_name VARCHAR(150) DEFAULT NULL,
      phone_no VARCHAR(20) DEFAULT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NULL DEFAULT NULL
    )
  `);
  tableReady = true;
}

/**
 * Returns which account table already uses this email (or null if free).
 * HOW: Checks super_admin, customers, do_operators, then sub_admins.
 */
async function emailTakenElsewhere(cleanEmail, excludeSubAdminId = null) {
  const [sa] = await db.query('SELECT id FROM super_admin WHERE email = ? LIMIT 1', [cleanEmail]);
  if (sa.length) return 'super_admin';

  try {
    const [cust] = await db.query('SELECT id FROM customers WHERE email = ? LIMIT 1', [cleanEmail]);
    if (cust.length) return 'customer';
  } catch (err) {
    if (err.code !== 'ER_NO_SUCH_TABLE') throw err;
  }

  const [ops] = await db.query('SELECT id FROM do_operators WHERE email = ? LIMIT 1', [cleanEmail]);
  if (ops.length) return 'do_operator';

  await ensureSubAdminsTable();
  const [subs] = await db.query('SELECT id FROM sub_admins WHERE email = ? LIMIT 1', [cleanEmail]);
  if (subs.length && String(subs[0].id) !== String(excludeSubAdminId || '')) return 'sub_admin';
  return null;
}

/**
 * Lists mobile Sub-Admins (full app access, not scoped customers).
 * Mounted at GET /api/sub-admins for Super Admin only.
 */
exports.listSubAdmins = async (req, res) => {
  try {
    await ensureSubAdminsTable();
    const [rows] = await db.query(
      'SELECT id, email, full_name, phone_no, created_at FROM sub_admins ORDER BY id DESC'
    );
    return res.json(rows);
  } catch (err) {
    return handleControllerError(res, err, {
      checkpoint: 'listSubAdmins',
      req,
      clientMessage: 'Failed to fetch Sub-Admins.'
    });
  }
};

/** Creates a sub_admins login with hashed password and audit log entry. */
exports.createSubAdmin = async (req, res) => {
  try {
    await ensureSubAdminsTable();
    const { email, password, full_name, phone_no } = req.body;
    const cleanEmail = (email || '').trim().toLowerCase();
    const cleanFullName = (full_name || '').trim();
    const cleanPhone = (phone_no || '').trim();

    if (!cleanEmail || !password || !cleanFullName || !cleanPhone) {
      return res.status(400).json({
        error: 'All fields (Name, Phone, Email, Password) are required.'
      });
    }

    const taken = await emailTakenElsewhere(cleanEmail);
    if (taken) {
      return res.status(400).json({
        error: `Email already used by another ${taken.replace('_', ' ')} account.`
      });
    }

    const hashed = await bcrypt.hash(String(password), 10);
    const [result] = await db.query(
      'INSERT INTO sub_admins (email, password, full_name, phone_no) VALUES (?, ?, ?, ?)',
      [cleanEmail, hashed, cleanFullName, cleanPhone]
    );

    await logActivity(
      req.user?.email || 'super_admin',
      'SUB_ADMIN_CREATE',
      'USER_MGMT',
      `Registered mobile Sub-Admin: ${cleanFullName} <${cleanEmail}> (full app access)`
    );

    return res.status(201).json({
      message: 'Sub-Admin created successfully.',
      id: result.insertId,
      email: cleanEmail,
      full_name: cleanFullName,
      phone_no: cleanPhone
    });
  } catch (err) {
    return handleControllerError(res, err, {
      checkpoint: 'createSubAdmin',
      req,
      clientMessage: 'Failed to create Sub-Admin.'
    });
  }
};

/** Updates Sub-Admin profile; re-hashes password only when a new one is sent. */
exports.updateSubAdmin = async (req, res) => {
  try {
    await ensureSubAdminsTable();
    const { id } = req.params;
    const { email, password, full_name, phone_no } = req.body;
    const cleanEmail = (email || '').trim().toLowerCase();
    const cleanFullName = (full_name || '').trim();
    const cleanPhone = (phone_no || '').trim();

    if (!cleanEmail || !cleanFullName || !cleanPhone) {
      return res.status(400).json({
        error: 'Name, Phone and Email are required.'
      });
    }

    const taken = await emailTakenElsewhere(cleanEmail, id);
    if (taken) {
      return res.status(400).json({
        error: `Email already used by another ${taken.replace('_', ' ')} account.`
      });
    }

    if (password && String(password).trim()) {
      const hashed = await bcrypt.hash(String(password), 10);
      await db.query(
        'UPDATE sub_admins SET email = ?, password = ?, full_name = ?, phone_no = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        [cleanEmail, hashed, cleanFullName, cleanPhone, id]
      );
    } else {
      await db.query(
        'UPDATE sub_admins SET email = ?, full_name = ?, phone_no = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        [cleanEmail, cleanFullName, cleanPhone, id]
      );
    }

    await logActivity(
      req.user?.email || 'super_admin',
      'SUB_ADMIN_UPDATE',
      'USER_MGMT',
      `Updated mobile Sub-Admin: ${cleanFullName} <${cleanEmail}>`
    );

    return res.json({ message: 'Sub-Admin updated successfully.' });
  } catch (err) {
    return handleControllerError(res, err, {
      checkpoint: 'updateSubAdmin',
      req,
      clientMessage: 'Failed to update Sub-Admin.'
    });
  }
};

/** Deletes one mobile Sub-Admin account by id. */
exports.deleteSubAdmin = async (req, res) => {
  try {
    await ensureSubAdminsTable();
    const { id } = req.params;
    const [rows] = await db.query('SELECT email, full_name FROM sub_admins WHERE id = ? LIMIT 1', [id]);
    const label = rows[0] ? `${rows[0].full_name || ''} <${rows[0].email}>` : `ID ${id}`;

    await db.query('DELETE FROM sub_admins WHERE id = ?', [id]);

    await logActivity(
      req.user?.email || 'super_admin',
      'SUB_ADMIN_DELETE',
      'USER_MGMT',
      `Deleted mobile Sub-Admin: ${label}`
    );

    return res.json({ message: 'Sub-Admin deleted successfully.' });
  } catch (err) {
    return handleControllerError(res, err, {
      checkpoint: 'deleteSubAdmin',
      req,
      clientMessage: 'Failed to delete Sub-Admin.'
    });
  }
};
