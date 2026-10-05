// ====================================================================
// Temperature Controller (controllers/tempController.js)
// Comprehensive CRUD API for Data Operator (DO) Daily Thermal Monitoring.
// ====================================================================

const db = require('../config/db');
const { resolveLogAttribution } = require('../utils/logAttribution');
const { resolveWarehouseFields, resolveClientFields } = require('../utils/masterResolver');

/**
 * Lists DO container/trailer temperature readings.
 * WHY: Super Admin monitors cold-chain compliance; DO only sees their warehouse rows.
 */
exports.getAllTempLogs = async (req, res) => {
  try {
    const { entry_type, status, search } = req.query;
    let sql = 'SELECT * FROM daily_temp_logs WHERE 1=1';
    let params = [];

    if (entry_type && entry_type !== 'All') {
      sql += ' AND entry_type = ?';
      params.push(entry_type);
    }

    if (status && status !== 'All') {
      sql += ' AND status = ?';
      params.push(status);
    }

    if (search) {
      sql += ' AND (container_number LIKE ? OR client_name LIKE ? OR cargo_type LIKE ? OR driver_name LIKE ? OR seal_number LIKE ?)';
      const pattern = `%${search}%`;
      params.push(pattern, pattern, pattern, pattern, pattern);
    }

    if (req.user && req.user.role === 'do_operator' && (req.user.warehouse_name || req.user.warehouse_code)) {
      sql += ' AND (warehouse_name IS NULL OR TRIM(COALESCE(warehouse_name, \'\')) = \'\' OR LOWER(TRIM(COALESCE(warehouse_code, \'\'))) = ? OR LOWER(TRIM(COALESCE(warehouse_name, \'\'))) = ?)';
      params.push(
        String(req.user.warehouse_code || '').trim().toLowerCase(),
        String(req.user.warehouse_name || '').trim().toLowerCase()
      );
    }

    sql += ' ORDER BY recorded_at DESC';

    const [rows] = await db.query(sql, params);

    return res.status(200).json({
      success: true,
      count: rows.length,
      data: rows
    });
  } catch (error) {
    console.error('Error fetching DO temp logs:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch temperature logs from database.',
      error: error.message
    });
  }
};

/**
 * Saves a new daily_temp_logs row and auto-calculates Warning/Critical status from variance.
 * HOW: Compares actual vs target temp and checks genset status from the request body.
 */
exports.createTempLog = async (req, res) => {
  try {
    const { 
      entry_type, 
      container_number, 
      client_name, 
      cargo_type, 
      target_temp, 
      actual_temp, 
      location_dock, 
      driver_name, 
      driver_phone, 
      seal_number, 
      genset_status, 
      fuel_level, 
      operator_name, 
      remarks 
    } = req.body;

    // --- Required fields ---
    if (!entry_type || !container_number || !client_name || target_temp === undefined || actual_temp === undefined) {
      return res.status(400).json({
        success: false,
        message: 'Entry Type, Container Number, Client Name, Target Temp, and Actual Temp are required.'
      });
    }

    const target = parseFloat(target_temp);
    const actual = parseFloat(actual_temp);
    const variance = Math.abs(actual - target);

    // --- Status from variance (business alert rules) ---
    let status = 'Normal';
    if (genset_status === 'Faulty' || variance > 4.0) {
      status = 'Critical';
    } else if (variance > 1.5) {
      status = 'Warning';
    }

    const { warehouse_name: logWarehouse, warehouse_code: logWarehouseCode, operator_email: logOperatorEmail } = resolveLogAttribution(req, req.body);
    const whFields = await resolveWarehouseFields({
      warehouse_code: req.body.warehouse_code || logWarehouseCode,
      warehouse_name: logWarehouse
    });
    const clFields = await resolveClientFields({
      client_code: req.body.client_code,
      client_name,
      warehouse_name: whFields.warehouse_name,
      warehouse_code: whFields.warehouse_code
    });
    const resolvedClientName = clFields.client_name || client_name;

    const sql = `
      INSERT INTO daily_temp_logs 
      (entry_type, container_number, client_name, client_code, cargo_type, target_temp, actual_temp, temp_variance, status, location_dock, driver_name, driver_phone, seal_number, genset_status, fuel_level, operator_name, remarks, warehouse_name, warehouse_code, operator_email)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    const params = [
      entry_type,
      container_number,
      resolvedClientName,
      clFields.client_code,
      cargo_type || 'Cold Cargo',
      target,
      actual,
      variance,
      status,
      location_dock || 'Bay 1',
      driver_name || '',
      driver_phone || '',
      seal_number || '',
      genset_status || 'Running',
      fuel_level || '100%',
      operator_name || 'Data Operator DO',
      remarks || '',
      whFields.warehouse_name,
      whFields.warehouse_code,
      logOperatorEmail
    ];

    const [result] = await db.query(sql, params);

    return res.status(201).json({
      success: true,
      message: 'DO daily temperature log recorded successfully!',
      logId: result.insertId,
      calculatedStatus: status,
      variance
    });
  } catch (error) {
    console.error('Error creating DO temp log:', error);
    return res.status(500).json({
      success: false,
      message: 'Server error while recording DO temperature log.',
      error: error.message
    });
  }
};

/** Removes one daily temp log by id (admin cleanup or mistaken entry). */
exports.deleteTempLog = async (req, res) => {
  try {
    const { id } = req.params;
    const [result] = await db.query('DELETE FROM daily_temp_logs WHERE id = ?', [id]);

    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        message: `Temp log with ID ${id} not found.`
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Daily temperature log deleted successfully.'
    });
  } catch (error) {
    console.error('Error deleting temp log:', error);
    return res.status(500).json({
      success: false,
      message: 'Server error while deleting temperature log.',
      error: error.message
    });
  }
};
