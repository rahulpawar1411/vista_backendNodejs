// ====================================================================
// Outward Controller (controllers/outwardController.js)
// Implements CRUD APIs and file saving for the DO Outward Temp Monitor.
// ====================================================================

const db = require('../config/db');
const fs = require('fs');
const path = require('path');
const { getSavedFilePath } = require('../config/multer');
const { logActivity, getActorLabel } = require('../utils/logger');
const { buildDiffString } = require('../utils/diffBuilder');
const { parsePagination, sendPaginated, appendWarehouseFilter, appendSubAdminAccessScope, appendDoWarehouseScope } = require('../utils/pagination');
const { handleControllerError } = require('../utils/errorHandler');
const { resolveLogAttribution } = require('../utils/logAttribution');
const { parsePhotoCaptureMetadata, serializePhotoCaptureMetadata } = require('../utils/photoCaptureMeta');
const { resolveWarehouseFields, resolveClientFields } = require('../utils/masterResolver');
const { findRecentOutwardDuplicate, pickSubmission } = require('../utils/logDedup');
const { stripCustomerEditAudit } = require('../utils/stripCustomerEditAudit');

// Helper to format date
function formatDateTime(date) {
  if (!date || isNaN(date.getTime())) return '';
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${min}:${ss}`;
}

// 1. GET ALL OUTWARD LOGS (With optional search query)
exports.getOutwardLogs = async (req, res) => {
  const { search } = req.query;
  const { page, limit, offset } = parsePagination(req.query);

  try {
    let conditions = [];
    let params = [];

    if (req.user && req.user.role === 'do_operator') {
      appendDoWarehouseScope(conditions, params, req.user);
    }

    // Customer scoped filtering by allowed clients & warehouses
    appendSubAdminAccessScope(conditions, params, req.user, {
      clientColumn: 'outward_client_name',
      clientCodeColumn: 'outward_client_code',
      warehouseColumn: 'warehouse_name',
      warehouseCodeColumn: 'warehouse_code'
    });

    if (search) {
      conditions.push('(reference_no LIKE ? OR outward_vehicle_no LIKE ? OR outward_client_name LIKE ? OR outward_transporter_name LIKE ? OR outward_driver_name LIKE ? OR operator_email LIKE ?)');
      const pattern = `%${search}%`;
      params.push(pattern, pattern, pattern, pattern, pattern, pattern);
    }

    const { fromDate, toDate } = req.query;
    if (fromDate) {
      conditions.push('outward_entry_date >= ?');
      params.push(fromDate);
    }
    if (toDate) {
      conditions.push('outward_entry_date <= ?');
      params.push(toDate);
    }

    appendWarehouseFilter(conditions, params, req.query, req.user);

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const [countRows] = await db.query(
      `SELECT COUNT(*) AS total FROM outward_temp_logs ${whereClause}`,
      params
    );
    const total = countRows[0]?.total ?? 0;

    const query = `
      SELECT outward_id, reference_no, DATE_FORMAT(outward_entry_date, '%Y-%m-%d') as outward_entry_date, outward_vehicle_no, outward_seal_no,
             outward_invoice_no, outward_mens_power,
             outward_vehicle_temp, outward_pre_vehicle_temp, outward_material_temp, outward_transporter_name, outward_driver_name, outward_driver_no, 
             outward_client_name, outward_dock_no, outward_vehicle_reporting_time, outward_loading_start_time,
             outward_loading_duration_hours, outward_loading_duration_mins, outward_loading_end_time, 
             outward_pallets_in_qty, outward_invoice_qty, outward_received_qty, outward_received_boxes_qty, 
             outward_short_received_boxes_qty, outward_excess_received_boxes_qty, outward_damage_received_boxes_qty, 
             outward_material_type, outward_loading_supervisor_name, outward_remarks, outward_invoice_photos, outward_pod_photo,
             outward_vehicle_seal_photo, outward_vehicle_temp_photo, outward_pre_vehicle_temp_photo, outward_material_temp_photo, outward_vehicle_back_side_photo, 
             outward_vehicle_back_side_photo_with_material, outward_count_sheet_photo, outward_damage_boxes_photo, photo_capture_metadata, update_details, update_count, outward_created_at, outward_updated_at, warehouse_name, warehouse_code, outward_client_code, operator_email
      FROM outward_temp_logs 
      ${whereClause}
      ORDER BY outward_entry_date DESC, outward_id DESC
      LIMIT ? OFFSET ?
    `;

    const [rows] = await db.query(query, [...params, limit, offset]);
    return sendPaginated(res, stripCustomerEditAudit(rows, req.user), total, page, limit);
  } catch (err) {
    return handleControllerError(res, err, {
      checkpoint: 'getOutwardLogs',
      req,
      clientMessage: 'Failed to fetch outward logs.'
    });
  }
};

// 2. CREATE A NEW OUTWARD LOG
exports.addOutwardLog = async (req, res) => {
  try {
    const data = req.body;
    const files = req.files || {};

    let damage_photos_list = [];
    if (files.outward_damage_boxes_photo) {
      damage_photos_list = files.outward_damage_boxes_photo.map(f => getSavedFilePath(f, 'outward_images'));
    }
    const outward_damage_boxes_photo = damage_photos_list.length > 0 ? damage_photos_list.join(',') : null;

    let invoice_photos_list = [];
    if (files.outward_invoice_photos) {
      invoice_photos_list = files.outward_invoice_photos.map(f => getSavedFilePath(f, 'outward_images'));
    }
    const outward_invoice_photos = invoice_photos_list.length > 0 ? invoice_photos_list.join(',') : null;

    let count_sheet_list = [];
    if (files.outward_count_sheet_photo) {
      count_sheet_list = files.outward_count_sheet_photo.map(f => getSavedFilePath(f, 'outward_images'));
    }
    const outward_count_sheet_photo = count_sheet_list.length > 0 ? count_sheet_list.join(',') : null;

    // Single photos mapping
    const getPhotoPath = (fieldName) => {
      return files[fieldName] ? getSavedFilePath(files[fieldName][0], 'outward_images') : null;
    };

    const outward_pod_photo = getPhotoPath('outward_pod_photo');
    const outward_vehicle_seal_photo = getPhotoPath('outward_vehicle_seal_photo');
    const outward_pre_vehicle_temp_photo = getPhotoPath('outward_pre_vehicle_temp_photo') || getPhotoPath('outward_vehicle_temp_photo');
    const outward_vehicle_temp_photo = outward_pre_vehicle_temp_photo;
    const outward_material_temp_photo = getPhotoPath('outward_material_temp_photo');
    const outward_vehicle_back_side_photo = getPhotoPath('outward_vehicle_back_side_photo');
    const outward_vehicle_back_side_photo_with_material = getPhotoPath('outward_vehicle_back_side_photo_with_material');

    // Required fields check
    if (!data.outward_entry_date || !data.outward_vehicle_no || (!data.outward_client_name && !data.outward_client_code && !data.client_code)) {
      return res.status(400).json({ error: 'Date, Vehicle No, and Client Name are required.' });
    }

    const localTimestamp = formatDateTime(new Date());
    const { warehouse_name: logWarehouse, warehouse_code: logWarehouseCode, operator_email: logOperatorEmail } = resolveLogAttribution(req, data);
    const whFields = await resolveWarehouseFields({
      warehouse_code: data.warehouse_code || logWarehouseCode,
      warehouse_name: logWarehouse
    });
    const clFields = await resolveClientFields({
      client_code: data.outward_client_code || data.client_code,
      client_name: data.outward_client_name,
      warehouse_name: whFields.warehouse_name,
      warehouse_code: whFields.warehouse_code
    });
    const resolvedClientName = clFields.client_name || data.outward_client_name;
    const photo_capture_metadata = serializePhotoCaptureMetadata(
      parsePhotoCaptureMetadata(data.photo_capture_metadata)
    );

    const { submissionId, submittedAt } = pickSubmission(data);
    const existing = await findRecentOutwardDuplicate(db, {
      date: data.outward_entry_date,
      vehicle: data.outward_vehicle_no,
      operator: logOperatorEmail,
      client: resolvedClientName || data.outward_client_name,
      boxes: data.outward_received_boxes_qty,
      submissionId,
      submittedAt
    });
    if (existing) {
      return res.status(200).json({
        success: true,
        duplicate: true,
        id: existing.id,
        reference_no: existing.reference_no,
        message: 'Outward log already saved.'
      });
    }

    let startWithDate = data.outward_loading_start_time || null;
    const startTimeOnly = (() => {
      const raw = String(data.outward_loading_start_time || '').trim();
      if (!raw) return '';
      return raw.includes(' ') ? raw.split(/\s+/).pop() : raw;
    })();
    const endTimeOnly = (() => {
      const raw = String(data.outward_loading_end_time || '').trim();
      if (!raw) return '';
      return raw.includes(' ') ? raw.split(/\s+/).pop() : raw;
    })();

    if (data.outward_entry_date && startTimeOnly) {
      const dateParts = String(data.outward_entry_date).split('-');
      if (dateParts.length === 3) {
        const [yyyy, mm, dd] = dateParts;
        // Already a dated string (e.g. DD-MM-YYYY HH:mm) — keep it
        if (String(data.outward_loading_start_time || '').includes('-') && String(data.outward_loading_start_time || '').includes(' ')) {
          startWithDate = data.outward_loading_start_time;
        } else {
          startWithDate = `${dd}-${mm}-${yyyy} ${startTimeOnly}`;
        }
      }
    }

    let endWithDate = data.outward_loading_end_time || null;
    if (data.outward_entry_date && endTimeOnly) {
      const dateParts = String(data.outward_entry_date).split('-');
      if (dateParts.length === 3) {
        const [yyyy, mm, dd] = dateParts;
        if (String(data.outward_loading_end_time || '').includes('-') && String(data.outward_loading_end_time || '').includes(' ')) {
          endWithDate = data.outward_loading_end_time;
        } else {
          let targetDay = parseInt(dd, 10);
          let targetMonth = parseInt(mm, 10);
          let targetYear = parseInt(yyyy, 10);

          if (startTimeOnly) {
            const [startH, startM] = startTimeOnly.split(':').map(Number);
            const [endH, endM] = endTimeOnly.split(':').map(Number);
            if (
              Number.isFinite(startH) &&
              Number.isFinite(startM) &&
              Number.isFinite(endH) &&
              Number.isFinite(endM) &&
              endH * 60 + endM < startH * 60 + startM
            ) {
              const dt = new Date(targetYear, targetMonth - 1, targetDay + 1);
              targetDay = dt.getDate();
              targetMonth = dt.getMonth() + 1;
              targetYear = dt.getFullYear();
            }
          }

          const ddStr = String(targetDay).padStart(2, '0');
          const mmStr = String(targetMonth).padStart(2, '0');
          endWithDate = `${ddStr}-${mmStr}-${targetYear} ${endTimeOnly}`;
        }
      }
    }

    const preTemp = data.outward_pre_vehicle_temp !== undefined && data.outward_pre_vehicle_temp !== '' 
      ? parseFloat(data.outward_pre_vehicle_temp) 
      : (data.outward_vehicle_temp !== undefined && data.outward_vehicle_temp !== '' ? parseFloat(data.outward_vehicle_temp) : null);

    const query = `
      INSERT INTO outward_temp_logs (
        outward_entry_date, outward_vehicle_no, outward_seal_no, outward_invoice_no, outward_mens_power,
        outward_vehicle_temp, outward_pre_vehicle_temp, outward_material_temp, outward_transporter_name, 
        outward_driver_name, outward_driver_no, outward_client_name, outward_dock_no, outward_vehicle_reporting_time, 
        outward_loading_start_time, outward_loading_duration_hours, outward_loading_duration_mins, outward_loading_end_time, outward_pallets_in_qty, outward_invoice_qty, 
        outward_received_qty, outward_received_boxes_qty, outward_short_received_boxes_qty, outward_excess_received_boxes_qty, 
        outward_damage_received_boxes_qty, outward_material_type, outward_loading_supervisor_name, outward_remarks, 
        outward_invoice_photos, outward_pod_photo, outward_vehicle_seal_photo, outward_vehicle_temp_photo, outward_pre_vehicle_temp_photo, 
        outward_material_temp_photo, outward_vehicle_back_side_photo, outward_vehicle_back_side_photo_with_material, outward_count_sheet_photo, outward_damage_boxes_photo,
        outward_created_at, outward_updated_at, warehouse_name, warehouse_code, outward_client_code, operator_email, photo_capture_metadata,
        client_submission_id, client_submitted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    const values = [
      data.outward_entry_date,
      data.outward_vehicle_no,
      data.outward_seal_no || null,
      data.outward_invoice_no || null,
      data.outward_mens_power !== undefined && data.outward_mens_power !== '' ? parseInt(data.outward_mens_power, 10) : null,
      preTemp,
      preTemp,
      data.outward_material_temp !== undefined && data.outward_material_temp !== '' ? parseFloat(data.outward_material_temp) : null,
      data.outward_transporter_name || null,
      data.outward_driver_name || null,
      data.outward_driver_no || null,
      resolvedClientName,
      data.outward_dock_no || null,
      data.outward_vehicle_reporting_time || null,
      startWithDate,
      data.outward_loading_duration_hours || null,
      data.outward_loading_duration_mins || null,
      endWithDate,
      data.outward_pallets_in_qty !== undefined && data.outward_pallets_in_qty !== '' ? parseInt(data.outward_pallets_in_qty) : 0,
      data.outward_invoice_qty !== undefined && data.outward_invoice_qty !== '' ? parseInt(data.outward_invoice_qty) : 0,
      data.outward_received_boxes_qty !== undefined && data.outward_received_boxes_qty !== '' ? parseInt(data.outward_received_boxes_qty) : (data.outward_received_qty !== undefined && data.outward_received_qty !== '' ? parseInt(data.outward_received_qty) : 0),
      data.outward_received_boxes_qty !== undefined && data.outward_received_boxes_qty !== '' ? parseInt(data.outward_received_boxes_qty) : (data.outward_received_qty !== undefined && data.outward_received_qty !== '' ? parseInt(data.outward_received_qty) : 0),
      data.outward_short_received_boxes_qty !== undefined && data.outward_short_received_boxes_qty !== '' ? parseInt(data.outward_short_received_boxes_qty) : 0,
      data.outward_excess_received_boxes_qty !== undefined && data.outward_excess_received_boxes_qty !== '' ? parseInt(data.outward_excess_received_boxes_qty) : 0,
      data.outward_damage_received_boxes_qty !== undefined && data.outward_damage_received_boxes_qty !== '' ? parseInt(data.outward_damage_received_boxes_qty) : 0,
      data.outward_material_type || null,
      data.outward_loading_supervisor_name || null,
      data.outward_remarks || null,
      outward_invoice_photos,
      outward_pod_photo,
      outward_vehicle_seal_photo,
      outward_vehicle_temp_photo,
      outward_pre_vehicle_temp_photo,
      outward_material_temp_photo,
      outward_vehicle_back_side_photo,
      outward_vehicle_back_side_photo_with_material,
      outward_count_sheet_photo,
      outward_damage_boxes_photo,
      localTimestamp,
      localTimestamp,
      whFields.warehouse_name,
      whFields.warehouse_code,
      clFields.client_code,
      logOperatorEmail,
      photo_capture_metadata,
      submissionId || null,
      submittedAt || null
    ];

    let result;
    try {
      [result] = await db.query(query, values);
    } catch (insertErr) {
      if (insertErr.code === 'ER_DUP_ENTRY' && submissionId) {
        const dup = await findRecentOutwardDuplicate(db, {
          submissionId,
          submittedAt,
          date: data.outward_entry_date,
          vehicle: data.outward_vehicle_no,
          operator: logOperatorEmail,
          client: resolvedClientName || data.outward_client_name,
          boxes: data.outward_received_boxes_qty
        });
        if (dup) {
          return res.status(200).json({
            success: true,
            duplicate: true,
            id: dup.id,
            reference_no: dup.reference_no,
            message: 'Outward log already saved.'
          });
        }
      }
      throw insertErr;
    }
    const insertId = result.insertId;
    const reference_no = `RF-OUT-26-${String(insertId).padStart(4, '0')}`;
    try {
      await db.query('UPDATE outward_temp_logs SET reference_no = ? WHERE outward_id = ?', [reference_no, insertId]);
    } catch (refErr) {
      console.warn('⚠️ Failed to update reference_no for new outward log:', refErr.message);
    }
    
    // Log Operator Activity
    await logActivity(
      req.user ? req.user.email : 'unknown',
      'CREATE',
      'Outward Log',
      `${await getActorLabel(req.user)} created Outward record (Ref: ${reference_no}) — vehicle ${data.outward_vehicle_no || '-'}, client ${data.outward_client_name || '-'}`
    );

    return res.status(201).json({ id: insertId, reference_no, message: 'Outward temperature record saved successfully.' });
  } catch (err) {
    return handleControllerError(res, err, {
      checkpoint: 'addOutwardLog',
      req,
      clientMessage: 'Failed to save outward log.'
    });
  }
};

// 3. DELETE AN OUTWARD LOG
exports.deleteOutwardLog = async (req, res) => {
  try {
    const { id } = req.params;
    
    // First retrieve metadata + file paths to clean up disk storage
    const [rows] = await db.query(`
      SELECT reference_no, outward_vehicle_no, outward_client_name,
             outward_invoice_photos, outward_pod_photo, outward_vehicle_seal_photo, outward_vehicle_temp_photo, 
             outward_material_temp_photo, outward_vehicle_back_side_photo, outward_vehicle_back_side_photo_with_material, outward_count_sheet_photo, outward_damage_boxes_photo,
             outward_pre_vehicle_temp_photo
      FROM outward_temp_logs WHERE outward_id = ?
    `, [id]);

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Record not found.' });
    }

    const record = rows[0];
    const refNo = record.reference_no || `RF-OUT-26-${String(id).padStart(4, '0')}`;
    const vehicleNo = record.outward_vehicle_no || '-';
    const clientName = record.outward_client_name || '-';

    // Delete record from database
    await db.query('DELETE FROM outward_temp_logs WHERE outward_id = ?', [id]);

    // Async clean up files from disk
    const cleanupFile = (relPath) => {
      if (!relPath) return;
      const fullPath = path.join(__dirname, '../', relPath);
      if (fs.existsSync(fullPath)) {
        fs.unlink(fullPath, (err) => {
          if (err) console.error('Error removing file:', relPath, err.message);
        });
      }
    };

    // Clean up multiple photos
    if (record.outward_damage_boxes_photo) {
      record.outward_damage_boxes_photo.split(',').forEach(cleanupFile);
    }
    if (record.outward_invoice_photos) {
      record.outward_invoice_photos.split(',').forEach(cleanupFile);
    }
    if (record.outward_count_sheet_photo) {
      record.outward_count_sheet_photo.split(',').forEach(cleanupFile);
    }
    
    // Clean up single photos
    cleanupFile(record.outward_pod_photo);
    cleanupFile(record.outward_vehicle_seal_photo);
    cleanupFile(record.outward_vehicle_temp_photo);
    if (record.outward_pre_vehicle_temp_photo && record.outward_pre_vehicle_temp_photo !== record.outward_vehicle_temp_photo) {
      cleanupFile(record.outward_pre_vehicle_temp_photo);
    }
    cleanupFile(record.outward_material_temp_photo);
    cleanupFile(record.outward_vehicle_back_side_photo);
    cleanupFile(record.outward_vehicle_back_side_photo_with_material);

    // Log Operator Activity
    await logActivity(
      req.user ? req.user.email : 'unknown',
      'DELETE',
      'Outward Log',
      `${await getActorLabel(req.user)} deleted Outward record (Ref: ${refNo}) — vehicle ${vehicleNo}, client ${clientName}`
    );

    return res.json({ message: 'Record deleted and related files cleaned up.' });
  } catch (err) {
    return handleControllerError(res, err, {
      checkpoint: 'deleteOutwardLog',
      req,
      clientMessage: 'Failed to delete record.'
    });
  }
};

// 4. UPDATE AN EXISTING OUTWARD LOG
exports.updateOutwardLog = async (req, res) => {
  try {
    const { id } = req.params;
    const data = req.body;
    const files = req.files || {};

    // Get existing record to handle files merging
    const [existing] = await db.query('SELECT * FROM outward_temp_logs WHERE outward_id = ?', [id]);
    if (existing.length === 0) {
      return res.status(404).json({ error: 'Record not found.' });
    }
    const current = existing[0];

    // Single photos merging
    const getPhotoPath = (fieldName, fallbackValue) => {
      return files[fieldName] ? getSavedFilePath(files[fieldName][0], 'outward_images') : fallbackValue;
    };

    const outward_pod_photo = getPhotoPath('outward_pod_photo', current.outward_pod_photo);
    const outward_vehicle_seal_photo = getPhotoPath('outward_vehicle_seal_photo', current.outward_vehicle_seal_photo);
    const outward_pre_vehicle_temp_photo = getPhotoPath('outward_pre_vehicle_temp_photo', current.outward_pre_vehicle_temp_photo) || getPhotoPath('outward_vehicle_temp_photo', current.outward_vehicle_temp_photo);
    const outward_vehicle_temp_photo = outward_pre_vehicle_temp_photo;
    const outward_material_temp_photo = getPhotoPath('outward_material_temp_photo', current.outward_material_temp_photo);
    const outward_vehicle_back_side_photo = getPhotoPath('outward_vehicle_back_side_photo', current.outward_vehicle_back_side_photo);
    const outward_vehicle_back_side_photo_with_material = getPhotoPath('outward_vehicle_back_side_photo_with_material', current.outward_vehicle_back_side_photo_with_material);

    let outward_invoice_photos = current.outward_invoice_photos;
    if (files.outward_invoice_photos) {
      const invoice_photos_list = files.outward_invoice_photos.map(f => getSavedFilePath(f, 'outward_images'));
      outward_invoice_photos = invoice_photos_list.join(',');
    }

    let outward_count_sheet_photo = current.outward_count_sheet_photo;
    if (files.outward_count_sheet_photo) {
      const count_sheet_list = files.outward_count_sheet_photo.map(f => getSavedFilePath(f, 'outward_images'));
      outward_count_sheet_photo = count_sheet_list.join(',');
    }

    let outward_damage_boxes_photo = current.outward_damage_boxes_photo;
    if (files.outward_damage_boxes_photo) {
      const damage_photos_list = files.outward_damage_boxes_photo.map(f => getSavedFilePath(f, 'outward_images'));
      outward_damage_boxes_photo = damage_photos_list.join(',');
    }

    const localTimestamp = formatDateTime(new Date());

    const clFields = await resolveClientFields({
      client_code: data.outward_client_code ?? data.client_code ?? current.outward_client_code,
      client_name: data.outward_client_name ?? current.outward_client_name,
      warehouse_name: current.warehouse_name,
      warehouse_code: current.warehouse_code
    });
    const resolvedClientName = clFields.client_name || current.outward_client_name;
    const resolvedClientCode = clFields.client_code || current.outward_client_code;

    const query = `
      UPDATE outward_temp_logs SET
        outward_entry_date = COALESCE(?, outward_entry_date),
        outward_vehicle_no = COALESCE(?, outward_vehicle_no),
        outward_seal_no = ?,
        outward_invoice_no = ?,
        outward_mens_power = ?,
        outward_vehicle_temp = ?,
        outward_pre_vehicle_temp = ?,
        outward_material_temp = ?,
        outward_transporter_name = ?,
        outward_driver_name = ?,
        outward_driver_no = ?,
        outward_client_name = COALESCE(?, outward_client_name),
        outward_client_code = COALESCE(?, outward_client_code),
        outward_dock_no = ?,
        outward_vehicle_reporting_time = ?,
        outward_loading_start_time = ?,
        outward_loading_duration_hours = ?,
        outward_loading_duration_mins = ?,
        outward_loading_end_time = ?,
        outward_pallets_in_qty = ?,
        outward_invoice_qty = ?,
        outward_received_qty = ?,
        outward_received_boxes_qty = ?,
        outward_short_received_boxes_qty = ?,
        outward_excess_received_boxes_qty = ?,
        outward_damage_received_boxes_qty = ?,
        outward_material_type = ?,
        outward_loading_supervisor_name = ?,
        outward_remarks = ?,
        outward_invoice_photos = ?,
        outward_pod_photo = ?,
        outward_vehicle_seal_photo = ?,
        outward_vehicle_temp_photo = ?,
        outward_pre_vehicle_temp_photo = ?,
        outward_material_temp_photo = ?,
        outward_vehicle_back_side_photo = ?,
        outward_vehicle_back_side_photo_with_material = ?,
        outward_count_sheet_photo = ?,
        outward_damage_boxes_photo = ?,
        update_details = ?,
        update_count = ?,
        outward_updated_at = ?
      WHERE outward_id = ?
    `;

    let startWithDate = data.outward_loading_start_time !== undefined ? data.outward_loading_start_time : current.outward_loading_start_time;
    if (startWithDate && !startWithDate.includes('-')) {
      const entryDate = data.outward_entry_date || current.outward_entry_date;
      if (entryDate) {
        const dateParts = entryDate.split('-');
        if (dateParts.length === 3) {
          const [yyyy, mm, dd] = dateParts;
          startWithDate = `${dd}-${mm}-${yyyy} ${startWithDate}`;
        }
      }
    }

    let endWithDate = data.outward_loading_end_time !== undefined ? data.outward_loading_end_time : current.outward_loading_end_time;
    if (endWithDate && !endWithDate.includes('-')) {
      const entryDate = data.outward_entry_date || current.outward_entry_date;
      if (entryDate) {
        const dateParts = entryDate.split('-');
        if (dateParts.length === 3) {
          const [yyyy, mm, dd] = dateParts;
          let targetDay = parseInt(dd);
          let targetMonth = parseInt(mm);
          let targetYear = parseInt(yyyy);

          const startTimeVal = data.outward_loading_start_time !== undefined ? data.outward_loading_start_time : current.outward_loading_start_time;
          if (startTimeVal && !startTimeVal.includes('-')) {
            const [startH, startM] = startTimeVal.split(':').map(Number);
            const [endH, endM] = endWithDate.split(':').map(Number);
            if ((endH * 60 + endM) < (startH * 60 + startM)) {
              const dt = new Date(targetYear, targetMonth - 1, targetDay + 1);
              targetDay = dt.getDate();
              targetMonth = dt.getMonth() + 1;
              targetYear = dt.getFullYear();
            }
          }

          const ddStr = String(targetDay).padStart(2, '0');
          const mmStr = String(targetMonth).padStart(2, '0');
          endWithDate = `${ddStr}-${mmStr}-${targetYear} ${endWithDate}`;
        }
      }
    }

    const preTemp = data.outward_pre_vehicle_temp !== undefined && data.outward_pre_vehicle_temp !== '' 
      ? parseFloat(data.outward_pre_vehicle_temp) 
      : (data.outward_vehicle_temp !== undefined && data.outward_vehicle_temp !== '' ? parseFloat(data.outward_vehicle_temp) : current.outward_pre_vehicle_temp || current.outward_vehicle_temp);

    const updatedValues = {
      outward_entry_date: data.outward_entry_date || current.outward_entry_date,
      outward_vehicle_no: data.outward_vehicle_no || current.outward_vehicle_no,
      outward_seal_no: data.outward_seal_no !== undefined ? data.outward_seal_no : current.outward_seal_no,
      outward_invoice_no: data.outward_invoice_no !== undefined ? data.outward_invoice_no : current.outward_invoice_no,
      outward_mens_power: data.outward_mens_power !== undefined && data.outward_mens_power !== ''
        ? parseInt(data.outward_mens_power, 10)
        : (data.outward_mens_power === '' ? null : current.outward_mens_power),
      outward_vehicle_temp: preTemp,
      outward_pre_vehicle_temp: preTemp,
      outward_material_temp: data.outward_material_temp !== undefined && data.outward_material_temp !== '' ? parseFloat(data.outward_material_temp) : current.outward_material_temp,
      outward_transporter_name: data.outward_transporter_name !== undefined ? data.outward_transporter_name : current.outward_transporter_name,
      outward_driver_name: data.outward_driver_name !== undefined ? data.outward_driver_name : current.outward_driver_name,
      outward_driver_no: data.outward_driver_no !== undefined ? data.outward_driver_no : current.outward_driver_no,
      outward_client_name: resolvedClientName,
      outward_dock_no: data.outward_dock_no !== undefined ? data.outward_dock_no : current.outward_dock_no,
      outward_vehicle_reporting_time: data.outward_vehicle_reporting_time !== undefined ? data.outward_vehicle_reporting_time : current.outward_vehicle_reporting_time,
      outward_loading_start_time: startWithDate,
      outward_loading_duration_hours: data.outward_loading_duration_hours !== undefined ? data.outward_loading_duration_hours : current.outward_loading_duration_hours,
      outward_loading_duration_mins: data.outward_loading_duration_mins !== undefined ? data.outward_loading_duration_mins : current.outward_loading_duration_mins,
      outward_loading_end_time: endWithDate,
      outward_pallets_in_qty: data.outward_pallets_in_qty !== undefined && data.outward_pallets_in_qty !== '' ? parseInt(data.outward_pallets_in_qty) : current.outward_pallets_in_qty,
      outward_invoice_qty: data.outward_invoice_qty !== undefined && data.outward_invoice_qty !== '' ? parseInt(data.outward_invoice_qty) : current.outward_invoice_qty,
      outward_received_boxes_qty: data.outward_received_boxes_qty !== undefined && data.outward_received_boxes_qty !== '' ? parseInt(data.outward_received_boxes_qty) : (data.outward_received_qty !== undefined && data.outward_received_qty !== '' ? parseInt(data.outward_received_qty) : current.outward_received_boxes_qty || current.outward_received_qty || 0),
      outward_received_qty: data.outward_received_boxes_qty !== undefined && data.outward_received_boxes_qty !== '' ? parseInt(data.outward_received_boxes_qty) : (data.outward_received_qty !== undefined && data.outward_received_qty !== '' ? parseInt(data.outward_received_qty) : current.outward_received_boxes_qty || current.outward_received_qty || 0),
      outward_short_received_boxes_qty: data.outward_short_received_boxes_qty !== undefined && data.outward_short_received_boxes_qty !== '' ? parseInt(data.outward_short_received_boxes_qty) : current.outward_short_received_boxes_qty,
      outward_excess_received_boxes_qty: data.outward_excess_received_boxes_qty !== undefined && data.outward_excess_received_boxes_qty !== '' ? parseInt(data.outward_excess_received_boxes_qty) : current.outward_excess_received_boxes_qty,
      outward_damage_received_boxes_qty: data.outward_damage_received_boxes_qty !== undefined && data.outward_damage_received_boxes_qty !== '' ? parseInt(data.outward_damage_received_boxes_qty) : current.outward_damage_received_boxes_qty,
      outward_material_type: data.outward_material_type !== undefined ? data.outward_material_type : current.outward_material_type,
      outward_loading_supervisor_name: data.outward_loading_supervisor_name !== undefined ? data.outward_loading_supervisor_name : current.outward_loading_supervisor_name,
      outward_remarks: data.outward_remarks !== undefined ? data.outward_remarks : current.outward_remarks,
      outward_invoice_photos,
      outward_pod_photo,
      outward_vehicle_seal_photo,
      outward_vehicle_temp_photo,
      outward_pre_vehicle_temp_photo,
      outward_material_temp_photo,
      outward_vehicle_back_side_photo,
      outward_vehicle_back_side_photo_with_material,
      outward_count_sheet_photo,
      outward_damage_boxes_photo
    };

    const outwardFieldMapping = {
      outward_entry_date: 'Entry Date',
      outward_vehicle_no: 'Vehicle No',
      outward_seal_no: 'Seal No',
      outward_invoice_no: 'Invoice No',
      outward_mens_power: 'Mens Power',
      outward_vehicle_temp: 'Vehicle Temp',
      outward_pre_vehicle_temp: 'Pre Vehicle Temp',
      outward_material_temp: 'Material Temp',
      outward_transporter_name: 'Transporter Name',
      outward_driver_name: 'Driver Name',
      outward_driver_no: 'Driver Phone',
      outward_client_name: 'Client Name',
      outward_dock_no: 'Dock No',
      outward_vehicle_reporting_time: 'Reporting Time',
      outward_loading_start_time: 'Loading Start Time',
      outward_loading_duration_hours: 'Loading Duration Hours',
      outward_loading_duration_mins: 'Loading Duration Mins',
      outward_loading_end_time: 'Loading End Time',
      outward_pallets_in_qty: 'Pallets In Qty',
      outward_invoice_qty: 'Invoice Qty',
      outward_received_qty: 'Received Qty',
      outward_received_boxes_qty: 'Received Boxes Qty',
      outward_short_received_boxes_qty: 'Short Received Boxes Qty',
      outward_excess_received_boxes_qty: 'Excess Received Boxes Qty',
      outward_damage_received_boxes_qty: 'Damage Received Boxes Qty',
      outward_material_type: 'Material Type',
      outward_loading_supervisor_name: 'Loading Supervisor Name',
      outward_remarks: 'Remarks',
      outward_invoice_photos: 'Invoice Photo',
      outward_pod_photo: 'POD Photo',
      outward_vehicle_seal_photo: 'Vehicle Seal Photo',
      outward_vehicle_temp_photo: 'Vehicle Temp Photo',
      outward_pre_vehicle_temp_photo: 'Pre Vehicle Temp Photo',
      outward_material_temp_photo: 'Material Temp Photo',
      outward_vehicle_back_side_photo: 'Vehicle Back Photo',
      outward_vehicle_back_side_photo_with_material: 'Vehicle Back Photo With Material',
      outward_count_sheet_photo: 'Count Sheet Photo',
      outward_damage_boxes_photo: 'Damage Boxes Photo'
    };

    const update_details = buildDiffString(current, updatedValues, outwardFieldMapping);
    const update_count = (parseInt(current.update_count, 10) || 0) + 1;

    const values = [
      data.outward_entry_date,
      data.outward_vehicle_no,
      data.outward_seal_no !== undefined ? data.outward_seal_no : current.outward_seal_no,
      data.outward_invoice_no !== undefined ? data.outward_invoice_no : current.outward_invoice_no,
      data.outward_mens_power !== undefined && data.outward_mens_power !== ''
        ? parseInt(data.outward_mens_power, 10)
        : (data.outward_mens_power === '' ? null : current.outward_mens_power),
      preTemp,
      preTemp,
      data.outward_material_temp !== undefined && data.outward_material_temp !== '' ? parseFloat(data.outward_material_temp) : current.outward_material_temp,
      data.outward_transporter_name !== undefined ? data.outward_transporter_name : current.outward_transporter_name,
      data.outward_driver_name !== undefined ? data.outward_driver_name : current.outward_driver_name,
      data.outward_driver_no !== undefined ? data.outward_driver_no : current.outward_driver_no,
      resolvedClientName,
      resolvedClientCode,
      data.outward_dock_no !== undefined ? data.outward_dock_no : current.outward_dock_no,
      data.outward_vehicle_reporting_time !== undefined ? data.outward_vehicle_reporting_time : current.outward_vehicle_reporting_time,
      startWithDate,
      data.outward_loading_duration_hours !== undefined ? data.outward_loading_duration_hours : current.outward_loading_duration_hours,
      data.outward_loading_duration_mins !== undefined ? data.outward_loading_duration_mins : current.outward_loading_duration_mins,
      endWithDate,
      data.outward_pallets_in_qty !== undefined && data.outward_pallets_in_qty !== '' ? parseInt(data.outward_pallets_in_qty) : current.outward_pallets_in_qty,
      data.outward_invoice_qty !== undefined && data.outward_invoice_qty !== '' ? parseInt(data.outward_invoice_qty) : current.outward_invoice_qty,
      data.outward_received_boxes_qty !== undefined && data.outward_received_boxes_qty !== '' ? parseInt(data.outward_received_boxes_qty) : (data.outward_received_qty !== undefined && data.outward_received_qty !== '' ? parseInt(data.outward_received_qty) : current.outward_received_boxes_qty || current.outward_received_qty || 0),
      data.outward_received_boxes_qty !== undefined && data.outward_received_boxes_qty !== '' ? parseInt(data.outward_received_boxes_qty) : (data.outward_received_qty !== undefined && data.outward_received_qty !== '' ? parseInt(data.outward_received_qty) : current.outward_received_boxes_qty || current.outward_received_qty || 0),
      data.outward_short_received_boxes_qty !== undefined && data.outward_short_received_boxes_qty !== '' ? parseInt(data.outward_short_received_boxes_qty) : current.outward_short_received_boxes_qty,
      data.outward_excess_received_boxes_qty !== undefined && data.outward_excess_received_boxes_qty !== '' ? parseInt(data.outward_excess_received_boxes_qty) : current.outward_excess_received_boxes_qty,
      data.outward_damage_received_boxes_qty !== undefined && data.outward_damage_received_boxes_qty !== '' ? parseInt(data.outward_damage_received_boxes_qty) : current.outward_damage_received_boxes_qty,
      data.outward_material_type !== undefined ? data.outward_material_type : current.outward_material_type,
      data.outward_loading_supervisor_name !== undefined ? data.outward_loading_supervisor_name : current.outward_loading_supervisor_name,
      data.outward_remarks !== undefined ? data.outward_remarks : current.outward_remarks,
      outward_invoice_photos,
      outward_pod_photo,
      outward_vehicle_seal_photo,
      outward_vehicle_temp_photo,
      outward_pre_vehicle_temp_photo,
      outward_material_temp_photo,
      outward_vehicle_back_side_photo,
      outward_vehicle_back_side_photo_with_material,
      outward_count_sheet_photo,
      outward_damage_boxes_photo,
      update_details || null,
      update_count,
      localTimestamp,
      id
    ];

    await db.query(query, values);
    
    // Log Operator Activity (includes Super Admin / Customer / DO updates)
    const refNo = current.reference_no || `RF-OUT-26-${String(id).padStart(4, '0')}`;
    const vehicleNo = data.outward_vehicle_no || current.outward_vehicle_no || '-';
    await logActivity(
      req.user ? req.user.email : 'unknown',
      'UPDATE',
      'Outward Log',
      `${await getActorLabel(req.user)} updated Outward record (Ref: ${refNo}) — vehicle ${vehicleNo}${update_details ? `. Changes: ${update_details}` : ''}`,
      id,
      null
    );

    return res.json({ message: 'Outward temperature record updated successfully.', update_count });
  } catch (err) {
    return handleControllerError(res, err, {
      checkpoint: 'updateOutwardLog',
      req,
      clientMessage: 'Failed to update outward log.'
    });
  }
};

/**
 * POD-only update — DO can replace POD photo from profile without admin edit permission.
 */
exports.updateOutwardPodPhoto = async (req, res) => {
  try {
    const { id } = req.params;
    const uploaded = req.file || (req.files && req.files.outward_pod_photo && req.files.outward_pod_photo[0]);

    if (!uploaded) {
      return res.status(400).json({ error: 'POD photo file is required.' });
    }

    const [existing] = await db.query(
      'SELECT outward_id, reference_no, outward_vehicle_no, outward_pod_photo, update_details, update_count FROM outward_temp_logs WHERE outward_id = ?',
      [id]
    );
    if (existing.length === 0) {
      return res.status(404).json({ error: 'Record not found.' });
    }

    const current = existing[0];
    const newPath = getSavedFilePath(uploaded, 'outward_images');
    const localTimestamp = formatDateTime(new Date());
    const podDiff = current.outward_pod_photo
      ? 'POD Photo: (previous file) → (new file)'
      : 'POD Photo: (empty) → (new file)';
    let update_details = current.update_details
      ? `${current.update_details} | ${podDiff}`
      : podDiff;
    if (update_details && update_details.length > 60000) {
      update_details = update_details.slice(-60000);
    }
    const update_count = (parseInt(current.update_count, 10) || 0) + 1;

    await db.query(
      `UPDATE outward_temp_logs
       SET outward_pod_photo = ?, update_details = ?, update_count = ?, outward_updated_at = ?
       WHERE outward_id = ?`,
      [newPath, update_details, update_count, localTimestamp, id]
    );

    if (current.outward_pod_photo && current.outward_pod_photo !== newPath) {
      const oldFull = path.join(__dirname, '../', current.outward_pod_photo);
      if (fs.existsSync(oldFull)) {
        fs.unlink(oldFull, () => {});
      }
    }

    await logActivity(
      req.user ? req.user.email : 'unknown',
      'UPDATE',
      'Outward Log',
      `${await getActorLabel(req.user)} updated POD Photo for Outward record (Ref: ${current.reference_no || `RF-OUT-26-${String(id).padStart(4, '0')}`}) — vehicle ${current.outward_vehicle_no || '-'}`
    );

    return res.json({
      message: 'POD photo updated successfully.',
      outward_pod_photo: newPath,
      update_details,
      update_count,
      outward_updated_at: localTimestamp
    });
  } catch (err) {
    return handleControllerError(res, err, {
      checkpoint: 'updateOutwardPodPhoto',
      req,
      clientMessage: err.message || 'Failed to update POD photo.'
    });
  }
};
