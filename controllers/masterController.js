// ====================================================================
// Master Data Controller (backend/controllers/masterController.js)
// --------------------------------------------------------------------
// Catalog masters (not DO daily tasks):
//   • warehouse_master — sites (WH-CODE + name + city)
//   • client_master    — companies, optionally tied to a warehouse
//
// Who: Super Admin (web) + Sub Admin (mobile Admin → Master).
// DO daily work uses chamber_client_assignments instead (see chamberController).
// Log writes resolve codes via utils/masterResolver.js.
// ====================================================================

const db = require('../config/db');
const { handleControllerError } = require('../utils/errorHandler');
const { generateClientCode } = require('../utils/clientCodeGenerator');
const { generateWarehouseCode } = require('../utils/warehouseCodeGenerator');

/** Normalize WH-/CL- style codes; empty string if invalid. */
function normalizeCode(value, prefix) {
  const v = String(value || '').trim().toUpperCase();
  if (!v) return '';
  if (prefix && !v.startsWith(`${prefix}-`)) return '';
  if (!/^[A-Z0-9-]+$/.test(v)) return '';
  return v;
}

/** GET /api/masters/warehouses — list catalog warehouses (active by default). */
exports.listWarehouses = async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    const activeOnly = String(req.query.active_only || '1') !== '0';
    const params = [];
    let where = 'WHERE 1=1';
    if (activeOnly) where += ' AND is_active = 1';
    if (q) {
      where += ' AND (warehouse_code LIKE ? OR warehouse_name LIKE ? OR city LIKE ?)';
      params.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }
    const [rows] = await db.query(
      `SELECT id, warehouse_code, warehouse_name, city, is_active, created_at, updated_at
       FROM warehouse_master
       ${where}
       ORDER BY is_active DESC, warehouse_name ASC`,
      params
    );
    return res.json({ success: true, data: rows });
  } catch (error) {
    return handleControllerError(res, error, {
      checkpoint: 'masters_list_warehouses',
      req,
      clientMessage: 'Failed to fetch warehouses.',
    });
  }
};

/** POST /api/masters/warehouses — create warehouse_master row (WH- code). */
exports.createWarehouse = async (req, res) => {
  try {
    const warehouse_name = String(req.body.warehouse_name || '').trim();
    const city = String(req.body.city || '').trim() || null;
    if (!warehouse_name) {
      return res.status(400).json({ success: false, message: 'Warehouse name is required.' });
    }

    let warehouse_code = normalizeCode(req.body.warehouse_code, 'WH');
    if (!warehouse_code) {
      const [existing] = await db.query('SELECT warehouse_code FROM warehouse_master');
      warehouse_code = generateWarehouseCode(
        warehouse_name,
        null,
        (existing || []).map((r) => r.warehouse_code)
      );
    }
    if (!warehouse_code) {
      return res.status(400).json({ success: false, message: 'Warehouse code and name are required.' });
    }

    let finalCode = warehouse_code;
    const [dup] = await db.query(
      'SELECT warehouse_code FROM warehouse_master WHERE warehouse_code = ? LIMIT 1',
      [finalCode]
    );
    if (dup.length) {
      const [existing] = await db.query('SELECT warehouse_code FROM warehouse_master');
      const codes = (existing || []).map((r) => r.warehouse_code);
      finalCode = generateWarehouseCode(warehouse_name, null, codes) || finalCode;
      if (codes.map((c) => String(c).toUpperCase()).includes(String(finalCode).toUpperCase())) {
        for (let i = 2; i <= 99; i += 1) {
          const suffix = String(i).padStart(2, '0');
          const candidate = `${warehouse_code}-${suffix}`.slice(0, 48);
          if (!codes.map((c) => String(c).toUpperCase()).includes(candidate)) {
            finalCode = candidate;
            break;
          }
        }
      }
    }
    const [result] = await db.query(
      `INSERT INTO warehouse_master (warehouse_code, warehouse_name, city, is_active)
       VALUES (?, ?, ?, 1)`,
      [finalCode, warehouse_name, city]
    );
    return res.status(201).json({
      success: true,
      message: 'Warehouse created successfully.',
      data: {
        id: result.insertId,
        warehouse_code: finalCode,
        warehouse_name,
        city,
        is_active: 1
      }
    });
  } catch (error) {
    if (String(error.message || '').toLowerCase().includes('duplicate')) {
      return res.status(409).json({ success: false, message: 'Warehouse code already exists.' });
    }
    return handleControllerError(res, error, {
      checkpoint: 'masters_create_warehouse',
      req,
      clientMessage: 'Failed to create warehouse.',
    });
  }
};

/**
 * PATCH-style update for one warehouse_master row (name, city, active flag).
 * WHY: Soft-deleted warehouses stay in DB; is_active hides them from pickers.
 */
exports.updateWarehouse = async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ success: false, message: 'Invalid warehouse id.' });
    const warehouse_name = req.body.warehouse_name != null ? String(req.body.warehouse_name).trim() : null;
    const city = req.body.city != null ? String(req.body.city).trim() : null;
    const is_active = req.body.is_active;
    const sets = [];
    const params = [];
    if (warehouse_name != null) {
      if (!warehouse_name) return res.status(400).json({ success: false, message: 'Warehouse name cannot be empty.' });
      sets.push('warehouse_name = ?');
      params.push(warehouse_name);
    }
    if (city != null) {
      sets.push('city = ?');
      params.push(city || null);
    }
    if (is_active !== undefined) {
      sets.push('is_active = ?');
      params.push(is_active ? 1 : 0);
    }
    if (!sets.length) return res.status(400).json({ success: false, message: 'No fields to update.' });
    sets.push('updated_at = NOW()');
    params.push(id);
    const [result] = await db.query(`UPDATE warehouse_master SET ${sets.join(', ')} WHERE id = ?`, params);
    if (!result.affectedRows) {
      return res.status(404).json({ success: false, message: 'Warehouse not found.' });
    }
    return res.json({ success: true, message: 'Warehouse updated successfully.' });
  } catch (error) {
    return handleControllerError(res, error, {
      checkpoint: 'masters_update_warehouse',
      req,
      clientMessage: 'Failed to update warehouse.',
    });
  }
};

/** DELETE /api/masters/warehouses/:id — deactivate catalog warehouse (logs stay). */
exports.deleteWarehouse = async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ success: false, message: 'Invalid warehouse id.' });
    const [rows] = await db.query('SELECT id FROM warehouse_master WHERE id = ? LIMIT 1', [id]);
    if (!rows.length) {
      return res.status(404).json({ success: false, message: 'Warehouse not found.' });
    }
    await db.query(
      'UPDATE warehouse_master SET is_active = 0, updated_at = NOW() WHERE id = ?',
      [id]
    );
    return res.json({ success: true, message: 'Warehouse deactivated.' });
  } catch (error) {
    return handleControllerError(res, error, {
      checkpoint: 'masters_delete_warehouse',
      req,
      clientMessage: 'Failed to delete warehouse.',
    });
  }
};

/** GET /api/masters/clients — catalog clients (optional warehouse / active filter). */
exports.listClients = async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    const activeOnly = String(req.query.active_only || '1') !== '0';
    const warehouseCode = String(req.query.warehouse_code || '').trim();
    const params = [];
    let where = 'WHERE 1=1';
    if (activeOnly) where += ' AND cm.is_active = 1';
    if (warehouseCode) {
      where += ' AND wm.warehouse_code = ?';
      params.push(warehouseCode);
    }
    if (q) {
      where += ' AND (cm.client_code LIKE ? OR cm.client_name LIKE ? OR COALESCE(cm.warehouse_name, \'\') LIKE ?)';
      params.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }
    const [rows] = await db.query(
      `SELECT cm.id, cm.client_code, cm.client_name, cm.warehouse_name, cm.is_active, cm.created_at, cm.updated_at,
              wm.warehouse_code
       FROM client_master cm
       LEFT JOIN warehouse_master wm
         ON LOWER(TRIM(wm.warehouse_name)) = LOWER(TRIM(COALESCE(cm.warehouse_name, '')))
       ${where}
       ORDER BY cm.is_active DESC, cm.client_name ASC`,
      params
    );
    return res.json({ success: true, data: rows });
  } catch (error) {
    return handleControllerError(res, error, {
      checkpoint: 'masters_list_clients',
      req,
      clientMessage: 'Failed to fetch clients.',
    });
  }
};

/** POST /api/masters/clients — create client_master row (CL- code). */
exports.createClient = async (req, res) => {
  try {
    const client_name = String(req.body.client_name || '').trim();
    const warehouse_name = String(req.body.warehouse_name || '').trim() || null;
    let warehouse_code = String(req.body.warehouse_code || '').trim() || null;
    if (warehouse_name && !warehouse_code) {
      const [whRows] = await db.query(
        'SELECT warehouse_code FROM warehouse_master WHERE LOWER(TRIM(warehouse_name)) = LOWER(TRIM(?)) LIMIT 1',
        [warehouse_name]
      );
      warehouse_code = whRows[0]?.warehouse_code || null;
    }
    let client_code = normalizeCode(req.body.client_code, 'CL');
    if (!client_code && client_name) {
      client_code = normalizeCode(
        generateClientCode(client_name, warehouse_name, warehouse_code),
        'CL'
      );
    }
    if (!client_code || !client_name) {
      return res.status(400).json({ success: false, message: 'Client code and name are required.' });
    }
    // Ensure uniqueness — append -02, -03… if code already taken
    let finalCode = client_code;
    const [dup] = await db.query(
      'SELECT client_code FROM client_master WHERE client_code = ? LIMIT 1',
      [finalCode]
    );
    if (dup.length) {
      for (let i = 2; i <= 99; i += 1) {
        const suffix = String(i).padStart(2, '0');
        const candidate = `${client_code}-${suffix}`.slice(0, 48);
        const [hit] = await db.query(
          'SELECT client_code FROM client_master WHERE client_code = ? LIMIT 1',
          [candidate]
        );
        if (!hit.length) {
          finalCode = candidate;
          break;
        }
      }
    }
    const [result] = await db.query(
      `INSERT INTO client_master (client_code, client_name, warehouse_name, is_active)
       VALUES (?, ?, ?, 1)`,
      [finalCode, client_name, warehouse_name]
    );
    return res.status(201).json({
      success: true,
      message: 'Client created successfully.',
      client_code: finalCode,
      data: {
        id: result.insertId,
        client_code: finalCode,
        client_name,
        warehouse_name,
        is_active: 1
      }
    });
  } catch (error) {
    if (String(error.message || '').toLowerCase().includes('duplicate')) {
      return res.status(409).json({ success: false, message: 'Client code already exists.' });
    }
    return handleControllerError(res, error, {
      checkpoint: 'masters_create_client',
      req,
      clientMessage: 'Failed to create client.',
    });
  }
};

/**
 * Updates client_master name, warehouse link, or active flag without touching old logs.
 */
exports.updateClient = async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ success: false, message: 'Invalid client id.' });
    const client_name = req.body.client_name != null ? String(req.body.client_name).trim() : null;
    const warehouse_name = req.body.warehouse_name != null ? String(req.body.warehouse_name).trim() : null;
    const is_active = req.body.is_active;
    const sets = [];
    const params = [];
    if (client_name != null) {
      if (!client_name) return res.status(400).json({ success: false, message: 'Client name cannot be empty.' });
      sets.push('client_name = ?');
      params.push(client_name);
    }
    if (warehouse_name != null) {
      sets.push('warehouse_name = ?');
      params.push(warehouse_name || null);
    }
    if (is_active !== undefined) {
      sets.push('is_active = ?');
      params.push(is_active ? 1 : 0);
    }
    if (!sets.length) return res.status(400).json({ success: false, message: 'No fields to update.' });
    sets.push('updated_at = NOW()');
    params.push(id);
    await db.query(`UPDATE client_master SET ${sets.join(', ')} WHERE id = ?`, params);
    return res.json({ success: true, message: 'Client updated successfully.' });
  } catch (error) {
    return handleControllerError(res, error, {
      checkpoint: 'masters_update_client',
      req,
      clientMessage: 'Failed to update client.',
    });
  }
};

/** DELETE /api/masters/clients/:id — deactivate catalog client (logs stay). */
exports.deleteClient = async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ success: false, message: 'Invalid client id.' });
    const [rows] = await db.query('SELECT id FROM client_master WHERE id = ? LIMIT 1', [id]);
    if (!rows.length) {
      return res.status(404).json({ success: false, message: 'Client not found.' });
    }
    await db.query(
      'UPDATE client_master SET is_active = 0, updated_at = NOW() WHERE id = ?',
      [id]
    );
    return res.json({ success: true, message: 'Client deactivated.' });
  } catch (error) {
    return handleControllerError(res, error, {
      checkpoint: 'masters_delete_client',
      req,
      clientMessage: 'Failed to delete client.',
    });
  }
};
