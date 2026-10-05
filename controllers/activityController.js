// ====================================================================
// Operator activity controller (controllers/activityController.js)
// Lists and creates rows in do_operator_activities for audit trails.
// ====================================================================

const db = require('../config/db');
const { handleControllerError } = require('../utils/errorHandler');
const { parsePagination, sendPaginated } = require('../utils/pagination');
const { enrichActivityWithDecisionAudit } = require('../utils/decisionAudit');

/**
 * Paginated operator activity / security / system logs.
 * Query: page, limit, export, search, fromDate, toDate, action, category, warehouse
 * category: activity | security | system (default activity)
 */
exports.getActivityLogs = async (req, res) => {
  try {
    const { page, limit, offset } = parsePagination(req.query);
    const {
      search,
      fromDate,
      toDate,
      action,
      category = 'activity',
      warehouse
    } = req.query;

    const conditions = [];
    const params = [];

    const cat = String(category || 'activity').toLowerCase();
    if (cat === 'security') {
      conditions.push(`(a.log_type IN ('PERMISSION', 'SECURITY'))`);
    } else if (cat === 'system') {
      conditions.push(`(
        a.log_type IN ('SYSTEM', 'ERROR')
        OR a.action = 'SYSTEM_ERROR'
        OR (a.description IS NOT NULL AND a.description LIKE '%[CHECKPOINT]%')
      )`);
    } else if (cat === 'do_changes') {
      // DO client/chamber add-delete ops + permission allow/deny decisions
      conditions.push(`(
        a.action IN (
          'ADD_CLIENT', 'DELETE_CLIENT', 'UPDATE_CLIENT',
          'ADD_CHAMBER', 'DELETE_CHAMBER', 'UPDATE_CHAMBER', 'UPDATE_CHAMBER_ZONE',
          'MASTER_SETUP',
          'REQUEST_EDIT', 'REQUEST_DELETE',
          'GRANT_PERMISSION', 'GRANT_DELETE',
          'DENY_PERMISSION', 'DENY_DELETE',
          'USE_EDIT_PERMISSION', 'USE_DELETE_PERMISSION'
        )
        OR a.log_type IN ('DO_CHANGE', 'ChamberMaster', 'ClientMaster', 'MasterSetup', 'ChamberType')
        OR (a.log_type = 'Chamber Client Assignment' AND a.action IN ('CREATE', 'DELETE', 'ADD_CLIENT', 'DELETE_CLIENT'))
      )`);
    } else {
      // Operator activity trail (exclude security / system / error / DO master & permission rows)
      conditions.push(`(
        (a.log_type IS NULL OR a.log_type NOT IN ('PERMISSION', 'SECURITY', 'ERROR', 'SYSTEM', 'DO_CHANGE', 'ChamberMaster', 'ClientMaster', 'MasterSetup', 'ChamberType'))
        AND (a.action IS NULL OR a.action NOT IN (
          'SYSTEM_ERROR',
          'ADD_CLIENT', 'DELETE_CLIENT', 'UPDATE_CLIENT', 'ADD_CHAMBER', 'DELETE_CHAMBER',
          'UPDATE_CHAMBER', 'UPDATE_CHAMBER_ZONE', 'MASTER_SETUP',
          'REQUEST_EDIT', 'REQUEST_DELETE',
          'GRANT_PERMISSION', 'GRANT_DELETE',
          'DENY_PERMISSION', 'DENY_DELETE',
          'USE_EDIT_PERMISSION', 'USE_DELETE_PERMISSION'
        ))
        AND NOT (a.log_type = 'Chamber Client Assignment' AND a.action IN ('CREATE', 'DELETE'))
      )`);
    }

    if (action && action !== 'All') {
      conditions.push('a.action = ?');
      params.push(String(action));
    }

    const operatorEmailFilter = String(req.query.operatorEmail || req.query.operator_email || '').trim();
    if (operatorEmailFilter) {
      conditions.push(`(
        LOWER(TRIM(a.operator_email)) = LOWER(TRIM(?))
        AND a.operator_email IS NOT NULL
        AND TRIM(a.operator_email) != ''
      )`);
      params.push(operatorEmailFilter);
    }

    if (fromDate) {
      conditions.push('DATE(a.created_at) >= ?');
      params.push(String(fromDate));
    }
    if (toDate) {
      conditions.push('DATE(a.created_at) <= ?');
      params.push(String(toDate));
    }

    if (search && String(search).trim()) {
      const q = `%${String(search).trim()}%`;
      conditions.push(`(
        a.operator_email LIKE ?
        OR a.description LIKE ?
        OR a.remark LIKE ?
        OR a.action LIKE ?
        OR a.log_type LIKE ?
        OR op.full_name LIKE ?
      )`);
      params.push(q, q, q, q, q, q);
    }

    // Warehouse filter (activity tab only; matches prior UI behaviour)
    if (cat === 'activity' && warehouse && warehouse !== 'All') {
      if (warehouse === 'System/Admin') {
        conditions.push(`(op.warehouse_name IS NULL OR op.warehouse_name = '')`);
      } else {
        conditions.push(`(op.warehouse_name IS NULL OR op.warehouse_name = '' OR op.warehouse_name = ?)`);
        params.push(String(warehouse));
      }
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const fromJoin = `
      FROM do_operator_activities a
      LEFT JOIN do_operators op
        ON LOWER(TRIM(op.email)) = LOWER(TRIM(a.operator_email))
    `;

    const [countRows] = await db.query(
      `SELECT COUNT(*) AS total ${fromJoin} ${whereClause}`,
      params
    );
    const total = countRows[0]?.total ?? 0;

    const [rows] = await db.query(
      `SELECT
        a.id,
        a.operator_email,
        a.action,
        a.log_type,
        a.description,
        a.remark,
        a.permission_req,
        a.created_at
      ${fromJoin}
      ${whereClause}
      ORDER BY a.id DESC
      LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    return sendPaginated(
      res,
      (rows || []).map((row) => enrichActivityWithDecisionAudit(row)),
      total,
      page,
      limit
    );
  } catch (err) {
    return handleControllerError(res, err, {
      checkpoint: 'getActivityLogs',
      req,
      clientMessage: 'Failed to fetch operator activity logs.'
    });
  }
};

/**
 * Records a manual or client-generated activity row (mobile DO actions, system hooks).
 * WHY: Keeps a single audit table for Super Admin history and permission trails.
 */
exports.createActivityLog = async (req, res) => {
  try {
    const { action, description, remark, record_id, permission_req } = req.body;
    let log_type = req.body.log_type || req.body.logType || 'activity';
    if (!action || !description) {
      return res.status(400).json({ success: false, message: 'Action and Description are required.' });
    }
    const email = req.user ? req.user.email : 'system';

    const masterActions = [
      'ADD_CLIENT', 'DELETE_CLIENT', 'UPDATE_CLIENT',
      'ADD_CHAMBER', 'DELETE_CHAMBER', 'UPDATE_CHAMBER', 'UPDATE_CHAMBER_ZONE',
      'MASTER_SETUP',
      'REQUEST_EDIT', 'REQUEST_DELETE'
    ];
    if (masterActions.includes(String(action)) && (!log_type || log_type === 'activity')) {
      log_type = 'DO_CHANGE';
    }

    const { extractRemark } = require('../utils/logger');
    const resolvedRemark =
      (remark != null && String(remark).trim()) ||
      extractRemark(description) ||
      null;

    const permId =
      permission_req != null
        ? permission_req
        : record_id != null
          ? record_id
          : null;

    try {
      await db.query(
        'INSERT INTO do_operator_activities (operator_email, action, log_type, description, permission_req, remark) VALUES (?, ?, ?, ?, ?, ?)',
        [email, action, log_type, description, permId, resolvedRemark]
      );
    } catch (colErr) {
      if (/Unknown column 'remark'/i.test(String(colErr.message || ''))) {
        await db.query(
          'INSERT INTO do_operator_activities (operator_email, action, log_type, description, permission_req) VALUES (?, ?, ?, ?, ?)',
          [email, action, log_type, description, permId]
        );
      } else {
        throw colErr;
      }
    }

    return res.status(201).json({
      success: true,
      message: 'Activity log recorded successfully.',
      remark: resolvedRemark
    });
  } catch (error) {
    return handleControllerError(res, error, {
      checkpoint: 'createActivityLog',
      req,
      clientMessage: 'Failed to record activity log.'
    });
  }
};
