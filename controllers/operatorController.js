// ====================================================================
// Data Operator Controller (backend/controllers/operatorController.js)
// Implements secure CRUD actions for managing Data Operator accounts.
// ====================================================================

const db = require('../config/db');
const bcrypt = require('bcryptjs');
const { logActivity } = require('../utils/logger');
const { handleControllerError } = require('../utils/errorHandler');
const { sendOperatorCredentialsEmail } = require('../utils/emailService');
const { ensureNumberedChambers } = require('./chamberController');
const { resolveWarehouseFields } = require('../utils/masterResolver');

function normalizeIndiaPhone(phone_no) {
  let digits = String(phone_no || '').replace(/\D/g, '');
  if (digits.startsWith('91') && digits.length === 12) {
    digits = digits.slice(2);
  }
  if (!/^\d{10}$/.test(digits)) return null;
  return `+91${digits}`;
}

/**
 * Keep past + future DO data access aligned with profile warehouse.
 * Updates all logs tagged to this operator email.
 */
async function syncOperatorWarehouseOnPastLogs(operatorEmail, warehouseName, warehouseCode = null) {
  const email = String(operatorEmail || '').trim();
  const warehouse = String(warehouseName || '').trim();
  const code = String(warehouseCode || '').trim();
  if (!email || !warehouse) return { updated: 0 };

  const tables = [
    'daily_chamber_temp_logs',
    'inward_temp_logs',
    'outward_temp_logs'
  ];
  let updated = 0;
  for (const table of tables) {
    try {
      const [result] = await db.query(
        `UPDATE ${table}
         SET warehouse_name = ?, warehouse_code = COALESCE(?, warehouse_code)
         WHERE LOWER(TRIM(operator_email)) = LOWER(?)
           AND (warehouse_name IS NULL OR TRIM(warehouse_name) = '' OR warehouse_name <> ?)`,
        [warehouse, code || null, email, warehouse]
      );
      updated += Number(result?.affectedRows || 0);
    } catch (err) {
      console.warn(`Warehouse sync skipped for ${table}:`, err.message);
    }
  }
  return { updated };
}

/** Lists DO operators with warehouse and chamber limit (Super Admin / Sub-Admin). */
exports.getOperators = async (req, res) => {
  try {
    const [rows] = await db.query(
      'SELECT id, email, full_name, phone_no, warehouse_name, warehouse_code, chamber_limit, created_at FROM do_operators ORDER BY id DESC'
    );

    const pad = (n) => String(n).padStart(2, '0');
    const now = new Date();
    const todayStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const ioByEmail = new Map();
    try {
      const [inTotalRows] = await db.query(
        `SELECT LOWER(TRIM(IFNULL(operator_email,''))) AS email, COUNT(*) AS c
         FROM inward_temp_logs
         WHERE TRIM(IFNULL(operator_email,'')) <> ''
         GROUP BY LOWER(TRIM(IFNULL(operator_email,'')))`
      );
      const [outTotalRows] = await db.query(
        `SELECT LOWER(TRIM(IFNULL(operator_email,''))) AS email, COUNT(*) AS c
         FROM outward_temp_logs
         WHERE TRIM(IFNULL(operator_email,'')) <> ''
         GROUP BY LOWER(TRIM(IFNULL(operator_email,'')))`
      );
      const [inTodayRows] = await db.query(
        `SELECT LOWER(TRIM(IFNULL(operator_email,''))) AS email, COUNT(*) AS c
         FROM inward_temp_logs
         WHERE inward_entry_date = ?
           AND TRIM(IFNULL(operator_email,'')) <> ''
         GROUP BY LOWER(TRIM(IFNULL(operator_email,'')))`,
        [todayStr]
      );
      const [outTodayRows] = await db.query(
        `SELECT LOWER(TRIM(IFNULL(operator_email,''))) AS email, COUNT(*) AS c
         FROM outward_temp_logs
         WHERE outward_entry_date = ?
           AND TRIM(IFNULL(operator_email,'')) <> ''
         GROUP BY LOWER(TRIM(IFNULL(operator_email,'')))`,
        [todayStr]
      );
      const bump = (email, field, n) => {
        const key = String(email || '').trim().toLowerCase();
        if (!key) return;
        if (!ioByEmail.has(key)) {
          ioByEmail.set(key, {
            total_inward: 0,
            total_outward: 0,
            today_inward: 0,
            today_outward: 0
          });
        }
        ioByEmail.get(key)[field] = Number(n) || 0;
      };
      (inTotalRows || []).forEach((r) => bump(r.email, 'total_inward', r.c));
      (outTotalRows || []).forEach((r) => bump(r.email, 'total_outward', r.c));
      (inTodayRows || []).forEach((r) => bump(r.email, 'today_inward', r.c));
      (outTodayRows || []).forEach((r) => bump(r.email, 'today_outward', r.c));
    } catch (ioErr) {
      console.warn('getOperators IO counts skipped:', ioErr.message);
    }

    const withCounts = (rows || []).map((row) => {
      const emailKey = String(row.email || '').trim().toLowerCase();
      const io = ioByEmail.get(emailKey) || {
        total_inward: 0,
        total_outward: 0,
        today_inward: 0,
        today_outward: 0
      };
      return {
        ...row,
        total_inward: io.total_inward,
        total_outward: io.total_outward,
        today_inward: io.today_inward,
        today_outward: io.today_outward
      };
    });

    return res.json(withCounts);
  } catch (err) {
    return handleControllerError(res, err, {
      checkpoint: 'getOperators',
      req,
      clientMessage: 'Failed to fetch data operators.'
    });
  }
};

/** Creates a DO operator account tied to one warehouse. */
exports.createOperator = async (req, res) => {
  try {
    const { email, password, full_name, phone_no, warehouse_name, warehouse_code, chamber_limit } = req.body;
    if (!email || !password || !full_name || !phone_no || !warehouse_name) {
      return res.status(400).json({ error: 'All fields (Email, Password, Full Name, Phone No., Warehouse / Data Access) are required.' });
    }
    const limitVal = chamber_limit ? parseInt(chamber_limit, 10) : 4;
    const emailTrim = String(email).trim().toLowerCase();
    const phoneTrim = normalizeIndiaPhone(phone_no);
    if (!phoneTrim) {
      return res.status(400).json({ error: 'Phone No. must be a 10-digit Indian mobile number.' });
    }
    const whFields = await resolveWarehouseFields({ warehouse_code, warehouse_name });
    const warehouseTrim = whFields.warehouse_name || String(warehouse_name).trim();
    const warehouseCode = whFields.warehouse_code || null;

    // Check if operator already exists
    const [existing] = await db.query(
      'SELECT id FROM do_operators WHERE email = ? LIMIT 1',
      [emailTrim]
    );
    if (existing.length > 0) {
      return res.status(400).json({ error: 'Operator email already exists.' });
    }

    // Hash password
    const salt = await bcrypt.genSalt(10);
    const hashed = await bcrypt.hash(password, salt);

    await db.query(
      'INSERT INTO do_operators (email, password, full_name, phone_no, warehouse_name, warehouse_code, chamber_limit) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [emailTrim, hashed, full_name, phoneTrim, warehouseTrim, warehouseCode, limitVal]
    );

    // Pre-create Chamber 1 .. N so DO sees assigned chambers immediately
    try {
      await ensureNumberedChambers(limitVal);
    } catch (_) {}

    // Log the permission change
    await logActivity(
      req.user?.email || 'super_admin',
      'CREATE',
      'PERMISSION',
      `Registered operator profile: ${emailTrim} (Warehouse / Data Access: ${warehouseTrim}, Chambers: 1-${limitVal})`
    );

    // Await email (Resend HTTPS is fast; SMTP has 12s timeout — stays under Render ~30s limit)
    const emailResult = await sendOperatorCredentialsEmail({
      email: emailTrim,
      password,
      full_name,
      phone_no: phoneTrim,
      warehouse_name: warehouseTrim,
      chamber_limit: limitVal
    });

    await logActivity(
      req.user?.email || 'super_admin',
      emailResult.sent ? 'EMAIL_SENT' : 'EMAIL_FAILED',
      'SECURITY',
      emailResult.sent
        ? `Credentials email sent to DO: ${email}`
        : `Credentials email NOT sent to DO: ${email} (${emailResult.error || 'unknown'})`
    );

    return res.status(201).json({
      message: emailResult.sent
        ? 'Data operator created successfully. Login credentials emailed.'
        : 'Data operator created successfully, but credentials email could not be sent.',
      emailSent: !!emailResult.sent,
      emailSkipped: !!emailResult.skipped,
      emailError: emailResult.sent ? null : (emailResult.error || null)
    });
  } catch (err) {
    return handleControllerError(res, err, {
      checkpoint: 'createOperator',
      req,
      clientMessage: 'Failed to create data operator.'
    });
  }
};

/** Updates operator profile, warehouse assignment, or chamber limit. */
exports.updateOperator = async (req, res) => {
  try {
    const { id } = req.params;
    const { email, password, full_name, phone_no, warehouse_name, warehouse_code, chamber_limit } = req.body;

    if (!email || !full_name || !phone_no || !warehouse_name) {
      return res.status(400).json({ error: 'All fields (Email, Full Name, Phone No., Warehouse / Data Access) are required.' });
    }
    const limitVal = chamber_limit ? parseInt(chamber_limit, 10) : 4;
    const emailTrim = String(email).trim().toLowerCase();
    const phoneTrim = normalizeIndiaPhone(phone_no);
    if (!phoneTrim) {
      return res.status(400).json({ error: 'Phone No. must be a 10-digit Indian mobile number.' });
    }
    const whFields = await resolveWarehouseFields({ warehouse_code, warehouse_name });
    const warehouseTrim = whFields.warehouse_name || String(warehouse_name).trim();
    const warehouseCode = whFields.warehouse_code || null;

    const [beforeRows] = await db.query(
      'SELECT email, warehouse_name FROM do_operators WHERE id = ? LIMIT 1',
      [id]
    );
    if (beforeRows.length === 0) {
      return res.status(404).json({ error: 'Operator not found.' });
    }
    const prevEmail = beforeRows[0].email;
    const prevWarehouse = beforeRows[0].warehouse_name || '';

    // Check if email belongs to another operator
    const [existing] = await db.query(
      'SELECT id FROM do_operators WHERE email = ? AND id != ? LIMIT 1',
      [emailTrim, id]
    );
    if (existing.length > 0) {
      return res.status(400).json({ error: 'Email is already taken by another operator.' });
    }

    if (password && password.trim() !== '') {
      // Hash new password
      const salt = await bcrypt.genSalt(10);
      const hashed = await bcrypt.hash(password, salt);
      await db.query(
        'UPDATE do_operators SET email = ?, password = ?, full_name = ?, phone_no = ?, warehouse_name = ?, warehouse_code = ?, chamber_limit = ? WHERE id = ?',
        [emailTrim, hashed, full_name, phoneTrim, warehouseTrim, warehouseCode, limitVal, id]
      );
    } else {
      await db.query(
        'UPDATE do_operators SET email = ?, full_name = ?, phone_no = ?, warehouse_name = ?, warehouse_code = ?, chamber_limit = ? WHERE id = ?',
        [emailTrim, full_name, phoneTrim, warehouseTrim, warehouseCode, limitVal, id]
      );
    }

    // Ensure Chamber 1 .. N exist for updated chamber_limit
    try {
      await ensureNumberedChambers(limitVal);
    } catch (_) {}

    // Past logs: keep Warehouse / Data Access in sync for this operator (old + new email)
    const syncEmails = Array.from(
      new Set([String(prevEmail || '').trim(), emailTrim].filter(Boolean))
    );
    let pastLogsUpdated = 0;
    for (const syncEmail of syncEmails) {
      const syncResult = await syncOperatorWarehouseOnPastLogs(syncEmail, warehouseTrim, warehouseCode);
      pastLogsUpdated += Number(syncResult.updated || 0);
    }

    // If email changed, retag past logs to the new email so Data Access filters stay correct
    if (prevEmail && String(prevEmail).trim().toLowerCase() !== emailTrim) {
      const logTables = ['daily_chamber_temp_logs', 'inward_temp_logs', 'outward_temp_logs'];
      for (const table of logTables) {
        try {
          await db.query(
            `UPDATE ${table} SET operator_email = ? WHERE LOWER(TRIM(operator_email)) = LOWER(?)`,
            [emailTrim, prevEmail]
          );
        } catch (err) {
          console.warn(`Email retag skipped for ${table}:`, err.message);
        }
      }
    }

    // Log the permission change
    await logActivity(
      req.user?.email || 'super_admin',
      'UPDATE',
      'PERMISSION',
      `Updated operator profile: ${emailTrim} (Warehouse / Data Access: ${warehouseTrim}` +
        (prevWarehouse && prevWarehouse !== warehouseTrim ? ` ← was "${prevWarehouse}"` : '') +
        `, Chambers: 1-${limitVal}` +
        (pastLogsUpdated ? `, past logs synced: ${pastLogsUpdated}` : '') +
        `)`
    );

    return res.json({
      message: 'Data operator updated successfully.',
      warehouse_name: warehouseTrim,
      chamber_limit: limitVal,
      past_logs_synced: pastLogsUpdated
    });
  } catch (err) {
    return handleControllerError(res, err, {
      checkpoint: 'updateOperator',
      req,
      clientMessage: 'Failed to update data operator.'
    });
  }
};

/** Removes a DO operator account. */
exports.deleteOperator = async (req, res) => {
  try {
    const { id } = req.params;
    
    // Fetch operator details before deletion for audit logging
    const [opRows] = await db.query('SELECT email, warehouse_name FROM do_operators WHERE id = ? LIMIT 1', [id]);
    const opEmail = opRows.length > 0 ? opRows[0].email : `ID ${id}`;
    const opWarehouse = opRows.length > 0 ? opRows[0].warehouse_name : 'Unknown';

    await db.query('DELETE FROM do_operators WHERE id = ?', [id]);

    // Log the permission revocation
    await logActivity(
      req.user?.email || 'super_admin',
      'DELETE',
      'PERMISSION',
      `Revoked workspace access for operator: ${opEmail} (Warehouse: ${opWarehouse})`
    );

    return res.json({ message: 'Data operator deleted successfully.' });
  } catch (err) {
    return handleControllerError(res, err, {
      checkpoint: 'deleteOperator',
      req,
      clientMessage: 'Failed to delete data operator.'
    });
  }
};
