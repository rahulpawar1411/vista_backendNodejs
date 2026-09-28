// ====================================================================
// Customer Controller (backend/controllers/subAdminController.js)
// Implements secure CRUD actions for managing Customer accounts.
// (File name kept for compatibility; table is `customers`.)
// ====================================================================

const db = require('../config/db');
const bcrypt = require('bcryptjs');
const { logActivity } = require('../utils/logger');
const { handleControllerError } = require('../utils/errorHandler');
const { sendSubAdminCredentialsEmail } = require('../utils/emailService');
const {
  loadScopeMaps,
  resolveScopeTokens
} = require('../utils/scopeResolve');

async function queryCustomers(sql, params = []) {
  return db.query(sql, params);
}

// 1. GET ALL CUSTOMERS
exports.getSubAdmins = async (req, res) => {
  try {
    const [rows] = await queryCustomers(
      'SELECT id, email, full_name, phone_no, allowed_clients, allowed_warehouses, created_at FROM customers ORDER BY id DESC'
    );
    const { clientMaps, warehouseMaps } = await loadScopeMaps();
    const out = [];
    for (const row of rows || []) {
      const { clientsStr, warehousesStr } = await resolveScopeTokens({
        clientsCsv: row.allowed_clients,
        warehousesCsv: row.allowed_warehouses,
        clientMaps,
        warehouseMaps
      });
      out.push({
        ...row,
        allowed_clients: clientsStr,
        allowed_warehouses: warehousesStr
      });
    }
    return res.json(out);
  } catch (err) {
    return handleControllerError(res, err, {
      checkpoint: 'getSubAdmins',
      req,
      clientMessage: 'Failed to fetch customers.'
    });
  }
};

// 2. CREATE NEW CUSTOMER
exports.createSubAdmin = async (req, res) => {
  try {
    const { email, password, full_name, phone_no, allowed_clients, allowed_warehouses } = req.body;
    const cleanEmail = (email || '').trim().toLowerCase();
    const cleanFullName = (full_name || '').trim();
    const cleanPhone = (phone_no || '').trim();

    if (!cleanEmail || !password || !cleanFullName || !cleanPhone) {
      return res.status(400).json({ error: 'All fields (Email, Password, Full Name, Phone No.) are required.' });
    }

    // Check if customer email already exists (or used by another role)
    const [existing] = await queryCustomers(
      'SELECT id FROM customers WHERE email = ? LIMIT 1',
      [cleanEmail]
    );
    if (existing.length > 0) {
      return res.status(400).json({ error: 'Customer email already exists.' });
    }
    const [sa] = await db.query('SELECT id FROM super_admin WHERE email = ? LIMIT 1', [cleanEmail]);
    if (sa.length) return res.status(400).json({ error: 'Email already used by Super Admin.' });
    const [appSub] = await db.query('SELECT id FROM sub_admins WHERE email = ? LIMIT 1', [cleanEmail]);
    if (appSub.length) return res.status(400).json({ error: 'Email already used by a Sub-Admin.' });
    const [ops] = await db.query('SELECT id FROM do_operators WHERE email = ? LIMIT 1', [cleanEmail]);
    if (ops.length) return res.status(400).json({ error: 'Email already used by a Data Operator.' });

    // Hash password
    const salt = await bcrypt.genSalt(10);
    const hashed = await bcrypt.hash(password, salt);

    // Store allowed_clients and allowed_warehouses as comma-separated display names
    const { clientsStr, warehousesStr } = await resolveScopeTokens({
      clientsCsv: allowed_clients,
      warehousesCsv: allowed_warehouses
    });

    await queryCustomers(
      'INSERT INTO customers (email, password, full_name, phone_no, allowed_clients, allowed_warehouses) VALUES (?, ?, ?, ?, ?, ?)',
      [cleanEmail, hashed, cleanFullName, cleanPhone, clientsStr, warehousesStr]
    );

    // Log the permission change
    await logActivity(
      req.user?.email || 'super_admin',
      'CREATE',
      'PERMISSION',
      `Registered customer profile: ${cleanEmail} | Access: Clients=[${clientsStr || 'All'}] Warehouses=[${warehousesStr || 'All'}]`
    );

    const emailResult = await sendSubAdminCredentialsEmail({
      email: cleanEmail,
      password,
      full_name: cleanFullName,
      phone_no: cleanPhone,
      allowed_clients: clientsStr,
      allowed_warehouses: warehousesStr
    });

    await logActivity(
      req.user?.email || 'super_admin',
      emailResult.sent ? 'EMAIL_SENT' : 'EMAIL_FAILED',
      'SECURITY',
      emailResult.sent
        ? `Credentials email sent to Customer: ${cleanEmail}`
        : `Credentials email NOT sent to Customer: ${cleanEmail} (${emailResult.error || 'unknown'})`
    );

    return res.status(201).json({
      message: emailResult.sent
        ? 'Customer created successfully. Login credentials emailed.'
        : 'Customer created successfully, but credentials email could not be sent.',
      emailSent: !!emailResult.sent,
      emailSkipped: !!emailResult.skipped,
      emailError: emailResult.sent ? null : (emailResult.error || null)
    });
  } catch (err) {
    const detail = err.code === 'ER_DUP_ENTRY'
      ? 'Customer email already exists.'
      : (err.code === 'ER_BAD_FIELD_ERROR'
        ? 'Database schema is outdated. Restart the backend server to apply migrations.'
        : 'Failed to create customer.');
    return handleControllerError(res, err, {
      checkpoint: 'createSubAdmin',
      req,
      clientMessage: detail,
      statusCode: err.code === 'ER_DUP_ENTRY' ? 409 : 500
    });
  }
};

// 3. UPDATE CUSTOMER
exports.updateSubAdmin = async (req, res) => {
  try {
    const { id } = req.params;
    const { email, password, full_name, phone_no, allowed_clients, allowed_warehouses } = req.body;
    const cleanEmail = (email || '').trim().toLowerCase();
    const cleanFullName = (full_name || '').trim();
    const cleanPhone = (phone_no || '').trim();

    if (!cleanEmail || !cleanFullName || !cleanPhone) {
      return res.status(400).json({ error: 'All fields (Email, Full Name, Phone No.) are required.' });
    }

    // Check if email belongs to another customer
    const [existing] = await queryCustomers(
      'SELECT id FROM customers WHERE email = ? AND id != ? LIMIT 1',
      [cleanEmail, id]
    );
    if (existing.length > 0) {
      return res.status(400).json({ error: 'Email is already taken by another customer.' });
    }

    // Store allowed_clients and allowed_warehouses as comma-separated display names
    const { clientsStr, warehousesStr } = await resolveScopeTokens({
      clientsCsv: allowed_clients,
      warehousesCsv: allowed_warehouses
    });

    if (password && password.trim() !== '') {
      // Hash new password
      const salt = await bcrypt.genSalt(10);
      const hashed = await bcrypt.hash(password, salt);
      await queryCustomers(
        'UPDATE customers SET email = ?, password = ?, full_name = ?, phone_no = ?, allowed_clients = ?, allowed_warehouses = ? WHERE id = ?',
        [cleanEmail, hashed, cleanFullName, cleanPhone, clientsStr, warehousesStr, id]
      );
    } else {
      await queryCustomers(
        'UPDATE customers SET email = ?, full_name = ?, phone_no = ?, allowed_clients = ?, allowed_warehouses = ? WHERE id = ?',
        [cleanEmail, cleanFullName, cleanPhone, clientsStr, warehousesStr, id]
      );
    }

    // Log the permission change
    await logActivity(
      req.user?.email || 'super_admin',
      'UPDATE',
      'PERMISSION',
      `Updated customer profile: ${cleanEmail} | Access: Clients=[${clientsStr || 'All'}] Warehouses=[${warehousesStr || 'All'}]`
    );

    return res.json({ message: 'Customer updated successfully.' });
  } catch (err) {
    return handleControllerError(res, err, {
      checkpoint: 'updateSubAdmin',
      req,
      clientMessage: 'Failed to update customer.'
    });
  }
};

// 4. DELETE CUSTOMER
exports.deleteSubAdmin = async (req, res) => {
  try {
    const { id } = req.params;
    
    // Fetch details before deletion for audit logging
    const [opRows] = await queryCustomers('SELECT email FROM customers WHERE id = ? LIMIT 1', [id]);
    const opEmail = opRows.length > 0 ? opRows[0].email : `ID ${id}`;

    await queryCustomers('DELETE FROM customers WHERE id = ?', [id]);

    // Log the permission revocation
    await logActivity(
      req.user?.email || 'super_admin',
      'DELETE',
      'PERMISSION',
      `Revoked workspace access for customer: ${opEmail}`
    );

    return res.json({ message: 'Customer deleted successfully.' });
  } catch (err) {
    return handleControllerError(res, err, {
      checkpoint: 'deleteSubAdmin',
      req,
      clientMessage: 'Failed to delete customer.'
    });
  }
};
