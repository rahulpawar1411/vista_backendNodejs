// ====================================================================
// Permission Requests Controller
// (backend/controllers/permissionController.js)
// Implements secure workflow for DO operators to request edit/delete permissions
// and for Super Admins to approve/deny them, using ONLY the existing
// do_operator_activities table! No separate requests table is needed.
// ====================================================================

const db = require('../config/db');
const { logActivity, extractRemark, getActorLabel } = require('../utils/logger');
const { handleControllerError } = require('../utils/errorHandler');
const { notifySubAdminsPermissionRequest, notifyDoOperatorPermissionDecision } = require('../utils/notifySubAdmins');
const { enrichActivityWithDecisionAudit } = require('../utils/decisionAudit');

const PERMISSION_LOG_TYPES = "('Chamber', 'Inward', 'Outward', 'ChamberMaster', 'MasterSetup', 'ClientMaster', 'ChamberType')";

/** One pending row per real-world request (ignores permission_req / hash drift). */
function buildPermissionRequestFingerprint(row) {
  const desc = String(row.request_description || row.description || '');
  const op = String(row.operator_email || '').toLowerCase();
  const type = row.record_type || row.log_type || '';
  const rawAction = row.raw_action || row.action || '';
  const actionKind = rawAction === 'REQUEST_DELETE' ? 'delete' : 'edit';

  if (type === 'ClientMaster') {
    const addMatch = desc.match(/ADD client "([^"]+)"/i);
    const delMatch = desc.match(/DELETE client "([^"]+)"/i);
    const editMatch = desc.match(/EDIT client "([^"]+)"/i);
    const renameTo = desc.match(/EDIT client "[^"]+"\s*(?:→|->)\s*"([^"]+)"/i);
    const chamberMatch =
      desc.match(/\(id:\s*(\d+)\)/i) ||
      desc.match(/chamber_id:\s*(\d+)/i);
    const client = String(addMatch?.[1] || delMatch?.[1] || editMatch?.[1] || '')
      .trim()
      .toLowerCase();
    const chamberId = chamberMatch?.[1] || row.chamber_id || '';
    const kind = addMatch ? 'add' : delMatch ? 'delete' : editMatch ? 'edit' : actionKind;
    const renameKey = renameTo ? `->${String(renameTo[1]).trim().toLowerCase()}` : '';
    return `${op}|ClientMaster|${kind}|${chamberId}|${client}${renameKey}`;
  }

  if (type === 'ChamberType') {
    const chamberMatch = desc.match(/\(id:\s*(\d+)\)/i);
    const id = chamberMatch?.[1] || row.record_id || '';
    return `${op}|ChamberType|${id}`;
  }

  if (type === 'ChamberMaster') {
    const addMatch = desc.match(/ADD chamber "([^"]+)"/i);
    const delMatch = desc.match(/delete chamber "([^"]+)"/i);
    const name = String(addMatch?.[1] || delMatch?.[1] || '').trim().toLowerCase();
    const kind = addMatch ? 'add' : delMatch ? 'delete' : actionKind;
    return `${op}|ChamberMaster|${kind}|${name || row.record_id}`;
  }

  return `${op}|${type}|${row.record_id}|${actionKind}`;
}

/**
 * Keeps only the newest Pending row per fingerprint so the admin UI is not cluttered.
 * WHY: Retries and hash drift can create duplicate REQUEST rows for the same ask.
 */
function dedupePendingPermissionRequests(rows) {
  const pendingByFp = new Map();
  const nonPending = [];
  for (const row of rows || []) {
    if (!row) continue;
    if (row.status === 'Pending') {
      const fp = buildPermissionRequestFingerprint(row);
      const cur = pendingByFp.get(fp);
      if (!cur || Number(row.id) > Number(cur.id)) {
        pendingByFp.set(fp, row);
      }
    } else {
      nonPending.push(row);
    }
  }
  return [...pendingByFp.values(), ...nonPending].sort(
    (a, b) => Number(b.id) - Number(a.id)
  );
}

/**
 * Blocks a second identical pending request before insert.
 * HOW: Compares semantic fingerprints, not only permission_req id.
 */
async function findPendingSemanticDuplicate(operatorEmail, recordType, reqActionType, description, recordId) {
  const probe = {
    operator_email: operatorEmail,
    record_type: recordType,
    raw_action: reqActionType,
    description,
    record_id: recordId
  };
  const targetFp = buildPermissionRequestFingerprint(probe);

  const [rows] = await db.query(
    `
    SELECT a.id, a.operator_email, a.log_type, a.permission_req, a.action, a.description
    FROM do_operator_activities a
    INNER JOIN (
      SELECT operator_email, log_type, permission_req, MAX(id) AS max_id
      FROM do_operator_activities
      WHERE operator_email = ? AND log_type = ?
      GROUP BY operator_email, log_type, permission_req
    ) latest ON latest.max_id = a.id
    WHERE a.operator_email = ? AND a.log_type = ?
      AND a.action IN ('REQUEST_EDIT', 'REQUEST_DELETE')
    `,
    [operatorEmail, recordType, operatorEmail, recordType]
  );

  for (const row of rows) {
    const fp = buildPermissionRequestFingerprint({
      operator_email: row.operator_email,
      record_type: row.log_type,
      raw_action: row.action,
      description: row.description,
      record_id: row.permission_req
    });
    if (fp === targetFp) {
      return row;
    }
  }
  return null;
}

/** Stable INT for ClientMaster permission rows (must match mobile). */
function clientMasterPermissionId(chamberId, action, clientName, extra = '') {
  const s = `client|${chamberId}|${action}|${String(clientName || '').trim().toLowerCase()}|${String(extra || '').trim().toLowerCase()}`;
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 2000000000 || 1;
}
exports.clientMasterPermissionId = clientMasterPermissionId;

/**
 * On Super Admin approve of Chamber Add: create chamber (if needed) and raise DO chamber_limit
 * so Registered Operators Directory + mobile GET /api/chambers stay in sync.
 */
async function applyApprovedChamberAdd(operatorEmail, requestDescription, recordId) {
  const desc = String(requestDescription || '');
  const nameMatch = desc.match(/ADD chamber "([^"]+)"/i);
  const remarkMatch = desc.match(/Remark:\s*(.+)$/i);
  const name = (nameMatch?.[1] || '').trim();
  if (!name) {
    return { ok: false, reason: 'missing_name' };
  }

  const { chamberAddPermissionId, pickDoChambers } = require('./chamberController');
  const expectedId = chamberAddPermissionId(name);
  if (Number(recordId) !== Number(expectedId)) {
    // Still allow if description has the name (legacy / hash drift)
  }

  const [userRows] = await db.query(
    'SELECT chamber_limit, warehouse_name FROM do_operators WHERE email = ? LIMIT 1',
    [operatorEmail]
  );
  let limit = parseInt(userRows[0]?.chamber_limit || 4, 10);
  if (!Number.isFinite(limit) || limit < 1) limit = 4;
  const warehouseName = String(userRows[0]?.warehouse_name || '').trim() || null;

  let chamberId = null;
  const [dup] = await db.query('SELECT id, name, warehouse_name FROM chambers WHERE name = ? LIMIT 1', [
    name
  ]);
  if (dup.length > 0) {
    chamberId = dup[0].id;
    // Bind existing chamber to this DO warehouse so it appears on DO screen
    if (warehouseName && !String(dup[0].warehouse_name || '').trim()) {
      await db.query('UPDATE chambers SET warehouse_name = ? WHERE id = ?', [
        warehouseName,
        chamberId
      ]);
    }
  } else {
    const [result] = await db.query(
      'INSERT INTO chambers (name, warehouse_name) VALUES (?, ?)',
      [name, warehouseName]
    );
    chamberId = result.insertId;
  }

  const [all] = await db.query('SELECT id, name FROM chambers ORDER BY id ASC');
  let picked = pickDoChambers(all, limit);
  const included = picked.some((c) => Number(c.id) === Number(chamberId));
  if (!included) {
    let newLimit = Math.min(50, Math.max(limit + 1, picked.length + 1));
    while (
      newLimit <= 50 &&
      !pickDoChambers(all, newLimit).some((c) => Number(c.id) === Number(chamberId))
    ) {
      newLimit += 1;
    }
    await db.query('UPDATE do_operators SET chamber_limit = ? WHERE email = ?', [
      newLimit,
      operatorEmail
    ]);
    limit = newLimit;
  }

  try {
    const actorLabel = operatorEmail;
    await logActivity(
      operatorEmail,
      'ADD_CHAMBER',
      'Chamber Master',
      `Super Admin approved add of chamber "${name}" (id: ${chamberId}) for ${actorLabel}${
        remarkMatch?.[1] ? `. Remark: ${remarkMatch[1].trim()}` : ''
      }. Limit now ${limit}.`
    );
  } catch (_) {}

  return {
    ok: true,
    id: chamberId,
    name,
    chamber_limit: limit,
    remark: (remarkMatch?.[1] || '').trim()
  };
}

/**
 * On Super Admin allow of chamber type: apply Frozen/Chilled/Dry immediately.
 */
async function applyApprovedChamberTypeChange(requestDescription, recordId) {
  const desc = String(requestDescription || '');
  const fromTo = desc.match(/from\s+([A-Za-z]+)\s+to\s+([A-Za-z]+)/i);
  const nextRaw = String(fromTo?.[2] || '').trim();
  const allowed = ['Frozen', 'Chilled', 'Dry', 'Other'];
  const nextType = allowed.find((t) => t.toLowerCase() === nextRaw.toLowerCase());
  const id = parseInt(recordId, 10);
  if (!nextType || !id) {
    return { ok: false, reason: 'missing_type' };
  }

  const [rows] = await db.query(
    'SELECT id, name, chamber_type FROM chambers WHERE id = ? LIMIT 1',
    [id]
  );
  if (!rows.length) {
    return { ok: false, reason: 'not_found' };
  }

  await db.query('UPDATE chambers SET chamber_type = ? WHERE id = ?', [nextType, id]);
  try {
    await db.query(
      "UPDATE chamber_client_assignments SET chamber_type = ? WHERE chamber_id = ? AND status = 'active'",
      [nextType, id]
    );
  } catch (_) {}

  const remarkMatch = desc.match(/Remark:\s*(.+)$/i);
  try {
    await logActivity(
      'system',
      'UPDATE_CHAMBER_ZONE',
      'DO_CHANGE',
      `Super Admin approved chamber type of "${rows[0].name}" to "${nextType}"${
        remarkMatch?.[1] ? `. Remark: ${remarkMatch[1].trim()}` : ''
      }.`,
      id,
      remarkMatch?.[1]?.trim() || null
    );
  } catch (_) {}

  return {
    ok: true,
    id,
    name: rows[0].name,
    chamber_type: nextType,
    old_type: rows[0].chamber_type
  };
}

/**
 * On Super Admin allow of client master add/edit/delete: apply to chamber_client_assignments.
 */
async function applyApprovedClientMasterChange(operatorEmail, requestDescription, recordId, isDelete) {
  const desc = String(requestDescription || '');
  const remarkMatch = desc.match(/Remark:\s*(.+)$/i);
  const remark = remarkMatch?.[1]?.trim() || null;

  let warehouse_name = null;
  let warehouse_code = null;
  try {
    const [userRows] = await db.query(
      'SELECT warehouse_name, warehouse_code FROM do_operators WHERE email = ? LIMIT 1',
      [operatorEmail]
    );
    warehouse_name = userRows[0]?.warehouse_name || null;
    warehouse_code = userRows[0]?.warehouse_code || null;
  } catch (_) {}

  const { resolveWarehouseByCodeOrName, resolveClientByCodeOrName } = require('../utils/masterResolver');
  const resolvedWarehouse = await resolveWarehouseByCodeOrName({ warehouse_code, warehouse_name });
  if (resolvedWarehouse) {
    warehouse_code = resolvedWarehouse.warehouse_code;
    warehouse_name = resolvedWarehouse.warehouse_name;
  }

  const addMatch = desc.match(
    /allow to ADD client "([^"]+)"\s*\(([^)]*)\)\s*on chamber "([^"]+)"\s*\(id:\s*(\d+)\)/i
  );
  const delMatch = desc.match(
    /allow to DELETE client "([^"]+)" from chamber "([^"]+)"\s*\(id:\s*(\d+)\)/i
  );
  const editMatch = desc.match(
    /allow to EDIT client "([^"]+)"\s*(?:→|->)\s*"([^"]+)" on chamber "([^"]+)"\s*\(id:\s*(\d+)\)/i
  );

  if (!isDelete && addMatch) {
    const [, clientName, chamberType, chamberName, chamberIdRaw] = addMatch;
    const chamberId = parseInt(chamberIdRaw, 10);
    const expectedId = clientMasterPermissionId(chamberId, 'add', clientName);
    if (Number(recordId) !== Number(expectedId)) {
      // allow legacy / hash drift if description is valid
    }
    const resolvedClient = await resolveClientByCodeOrName({
      client_name: clientName,
      warehouse_name
    });
    const finalClientName = resolvedClient?.client_name || clientName;
    const finalClientCode = resolvedClient?.client_code || null;
    const [chRows] = await db.query(
      'SELECT id, name, chamber_type FROM chambers WHERE id = ? LIMIT 1',
      [chamberId]
    );
    const resolvedType =
      String(chRows[0]?.chamber_type || '').trim() ||
      String(chamberType || '').trim() ||
      'Frozen';

    await db.query(
      `INSERT INTO chamber_client_assignments
       (chamber_id, client_name, client_code, warehouse_name, warehouse_code, remark, chamber_type, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active')
       ON DUPLICATE KEY UPDATE
         client_code = VALUES(client_code),
         warehouse_code = VALUES(warehouse_code),
         remark = VALUES(remark),
         chamber_type = VALUES(chamber_type),
         status = 'active'`,
      [chamberId, finalClientName, finalClientCode, warehouse_name, warehouse_code, remark, resolvedType]
    );

    return {
      ok: true,
      action: 'add',
      chamber_id: chamberId,
      chamber_name: chRows[0]?.name || chamberName,
      client_name: finalClientName,
      chamber_type: resolvedType
    };
  }

  if (isDelete && delMatch) {
    const [, clientName, chamberName, chamberIdRaw] = delMatch;
    const chamberId = parseInt(chamberIdRaw, 10);
    await db.query(
      `UPDATE chamber_client_assignments
       SET status = 'inactive', remark = ?
       WHERE chamber_id = ?
         AND LOWER(TRIM(client_name)) = LOWER(TRIM(?))
         AND (
           (? IS NOT NULL AND TRIM(?) <> '' AND warehouse_code = ?)
           OR (? IS NULL OR TRIM(?) = '')
             AND (LOWER(TRIM(COALESCE(warehouse_name, ''))) = LOWER(TRIM(COALESCE(?, ''))) OR warehouse_name IS NULL OR warehouse_name = '')
         )`,
      [
        remark || '',
        chamberId,
        clientName,
        warehouse_code || null, warehouse_code || '', warehouse_code || null,
        warehouse_code || null, warehouse_code || '', warehouse_name || null
      ]
    );
    return {
      ok: true,
      action: 'delete',
      chamber_id: chamberId,
      chamber_name: chamberName,
      client_name: clientName
    };
  }

  if (!isDelete && editMatch) {
    const [, oldName, newName, chamberName, chamberIdRaw] = editMatch;
    const chamberId = parseInt(chamberIdRaw, 10);
    const resolvedClient = await resolveClientByCodeOrName({
      client_name: newName,
      warehouse_name
    });
    const finalNewName = resolvedClient?.client_name || newName;
    const finalClientCode = resolvedClient?.client_code || null;

    await db.query(
      `UPDATE chamber_client_assignments
       SET client_name = ?, client_code = COALESCE(?, client_code), remark = ?
       WHERE chamber_id = ?
         AND LOWER(TRIM(client_name)) = LOWER(TRIM(?))
         AND status = 'active'
         AND (
           (? IS NOT NULL AND TRIM(?) <> '' AND warehouse_code = ?)
           OR (? IS NULL OR TRIM(?) = '')
             AND (LOWER(TRIM(COALESCE(warehouse_name, ''))) = LOWER(TRIM(COALESCE(?, ''))) OR warehouse_name IS NULL OR warehouse_name = '')
         )`,
      [
        finalNewName,
        finalClientCode,
        remark,
        chamberId,
        oldName,
        warehouse_code || null, warehouse_code || '', warehouse_code || null,
        warehouse_code || null, warehouse_code || '', warehouse_name || null
      ]
    );
    return {
      ok: true,
      action: 'edit',
      chamber_id: chamberId,
      chamber_name: chamberName,
      client_name: finalNewName,
      old_name: oldName
    };
  }

  return { ok: false, reason: 'unparsed_request', record_id: recordId };
}

/**
 * Lists edit/delete permission requests for Super Admin or the requesting DO.
 */
exports.getPermissionRequests = async (req, res) => {
  try {
    // --- Build list query (Super Admin vs own requests for DO) ---
    let rows;
    const selectCols = `
        SELECT a.id, a.operator_email, a.log_type AS record_type, a.permission_req AS record_id, a.action AS raw_action,
               CASE 
                 WHEN a.action IN ('REQUEST_EDIT', 'REQUEST_DELETE') THEN 'Pending'
                 WHEN a.action IN ('GRANT_PERMISSION', 'GRANT_DELETE') THEN 'Approved'
                 WHEN a.action IN ('USE_EDIT_PERMISSION', 'USE_DELETE_PERMISSION') THEN 'Used'
                 ELSE 'Denied'
               END AS status,
               a.description, a.remark, a.created_at, a.do_action_completed_at,
               r.description AS request_description,
               r.remark AS request_remark,
               COALESCE(c.chamber_id, ch_master.id, ch_log.id) AS chamber_id,
               COALESCE(NULLIF(TRIM(ch_log.name), ''), NULLIF(TRIM(ch_master.name), ''), c.chamber_name) AS chamber_name,
               c.client_name, c.shift, c.entry_date,
               c.reference_no AS log_reference_no
        FROM do_operator_activities a
        LEFT JOIN (
          SELECT operator_email, log_type, permission_req, MAX(id) AS id
          FROM do_operator_activities
          WHERE action IN ('REQUEST_EDIT', 'REQUEST_DELETE')
          GROUP BY operator_email, log_type, permission_req
        ) r_latest
          ON r_latest.operator_email = a.operator_email
         AND r_latest.log_type = a.log_type
         AND r_latest.permission_req <=> a.permission_req
        LEFT JOIN do_operator_activities r ON r.id = r_latest.id
        LEFT JOIN daily_chamber_temp_logs c
          ON a.log_type = 'Chamber' AND c.id = a.permission_req
        LEFT JOIN chambers ch_master
          ON a.log_type IN ('ChamberMaster', 'ChamberType') AND ch_master.id = a.permission_req
        LEFT JOIN chambers ch_log
          ON a.log_type = 'Chamber' AND ch_log.id = c.chamber_id
    `;

    if (req.user.role === 'super_admin' || req.user.role === 'sub_admin') {
      [rows] = await db.query(`
        ${selectCols}
        WHERE a.log_type IN ${PERMISSION_LOG_TYPES}
          AND a.id IN (
          SELECT MAX(id)
          FROM do_operator_activities
          WHERE action IN ('REQUEST_EDIT', 'REQUEST_DELETE', 'GRANT_PERMISSION', 'GRANT_DELETE', 'DENY_PERMISSION', 'DENY_DELETE', 'USE_EDIT_PERMISSION', 'USE_DELETE_PERMISSION')
            AND log_type IN ${PERMISSION_LOG_TYPES}
          GROUP BY operator_email, log_type, permission_req
        )
        ORDER BY a.id DESC
      `);
    } else {
      [rows] = await db.query(`
        ${selectCols}
        WHERE a.operator_email = ?
          AND a.log_type IN ${PERMISSION_LOG_TYPES}
          AND a.id IN (
            SELECT MAX(id)
            FROM do_operator_activities
            WHERE operator_email = ?
              AND action IN ('REQUEST_EDIT', 'REQUEST_DELETE', 'GRANT_PERMISSION', 'GRANT_DELETE', 'DENY_PERMISSION', 'DENY_DELETE', 'USE_EDIT_PERMISSION', 'USE_DELETE_PERMISSION')
              AND log_type IN ${PERMISSION_LOG_TYPES}
            GROUP BY operator_email, log_type, permission_req
          )
        ORDER BY a.id DESC
      `, [req.user.email, req.user.email]);
    }
    const seen = new Set();
    const unique = [];
    for (const row of rows || []) {
      if (!row || row.id == null || seen.has(row.id)) continue;
      seen.add(row.id);
      unique.push(enrichActivityWithDecisionAudit(row));
    }
    return res.json(dedupePendingPermissionRequests(unique));
  } catch (err) {
    return handleControllerError(res, err, {
      checkpoint: 'getPermissionRequests',
      req,
      clientMessage: 'Failed to fetch permission requests.'
    });
  }
};

/** DO asks Super Admin to allow editing or deleting a specific log row. */
exports.createPermissionRequest = async (req, res) => {
  try {
    const { record_type, record_id, action = 'Edit', description, remark } = req.body;
    const operator_email = req.user.email;

    if (!record_type || !record_id) {
      return res.status(400).json({ error: 'Record type and Record ID are required.' });
    }

    const reqActionType = action === 'Edit' ? 'REQUEST_EDIT' : 'REQUEST_DELETE';
    const grantActionType = action === 'Edit' ? 'GRANT_PERMISSION' : 'GRANT_DELETE';

    // --- Block duplicate pending / already-granted (with master exceptions) ---
    const [existing] = await db.query(`
      SELECT action, id FROM do_operator_activities
      WHERE operator_email = ? AND log_type = ? AND permission_req = ?
      ORDER BY id DESC LIMIT 1
    `, [operator_email, record_type, record_id]);

    if (existing.length > 0) {
      const latestAction = existing[0].action;
      if (latestAction === reqActionType) {
        return res.status(400).json({ 
          error: `A permission request for this record is already pending approval.`, 
          request: { status: 'Pending', id: existing[0].id } 
        });
      }
      if (latestAction === grantActionType && String(record_type) !== 'ChamberType') {
        // ClientMaster / ChamberMaster: SA already applied on approve — leftover GRANT
        // must not let DO skip a fresh allow on the next change (common on live DBs).
        if (record_type === 'ClientMaster' || record_type === 'ChamberMaster') {
          try {
            await exports.consumeGrantedPermission(
              operator_email,
              record_type,
              record_id,
              action === 'Edit' ? 'Edit' : 'Delete'
            );
          } catch (_) {}
        } else {
          return res.status(400).json({
            error: `Permission to perform this action has already been granted.`,
            request: { status: 'Approved' }
          });
        }
      }
    }

    const semanticDup = await findPendingSemanticDuplicate(
      operator_email,
      record_type,
      reqActionType,
      description,
      record_id
    );
    if (semanticDup) {
      return res.status(400).json({
        error: 'An identical permission request is already pending Super Admin approval.',
        request: { status: 'Pending', id: semanticDup.id }
      });
    }

    // --- Human-readable ref for activity description ---
    let refQuery = '';
    if (record_type === 'Chamber') {
      refQuery = 'SELECT reference_no FROM daily_chamber_temp_logs WHERE id = ? LIMIT 1';
    } else if (record_type === 'Inward') {
      refQuery = 'SELECT reference_no FROM inward_temp_logs WHERE inward_id = ? LIMIT 1';
    } else if (record_type === 'Outward') {
      refQuery = 'SELECT reference_no FROM outward_temp_logs WHERE outward_id = ? LIMIT 1';
    }
    
    let reference_no = '';
    if (refQuery) {
      const [refRows] = await db.query(refQuery, [record_id]);
      if (refRows.length > 0) {
        reference_no = refRows[0].reference_no;
      }
    }
    let chamberMasterName = '';
    if ((record_type === 'ChamberMaster' || record_type === 'ChamberType') && record_id != null) {
      try {
        const [chNameRows] = await db.query('SELECT name FROM chambers WHERE id = ? LIMIT 1', [record_id]);
        chamberMasterName = String(chNameRows[0]?.name || '').trim();
      } catch (_) {}
    }
    const refText = reference_no
      ? `Ref: ${reference_no}`
      : (record_type === 'MasterSetup'
        ? 'Master Setup'
        : record_type === 'ChamberMaster'
          ? (chamberMasterName || 'Chamber')
          : record_type === 'ChamberType'
            ? (chamberMasterName || 'Chamber type')
          : record_type === 'ClientMaster'
            ? 'Client master'
            : `ID: ${record_id}`);

    // --- Persist REQUEST row in do_operator_activities ---
    const actionLabel = action === 'Edit' ? 'edit' : 'delete';
    let descText =
      description ||
      (record_type === 'MasterSetup'
        ? `Master Setup opened (Super Admin approval not required).`
        : record_type === 'ChamberMaster'
          ? `Requested Super Admin approval for chamber master (${refText}).`
          : record_type === 'ChamberType'
            ? `Requested Super Admin allow to EDIT chamber type (${refText}).`
          : record_type === 'ClientMaster'
            ? `Requested Super Admin approval to ${actionLabel} client master (${refText}).`
            : `Requested permission to ${actionLabel} ${record_type} log (${refText})`);

    const resolvedRemark =
      (remark != null && String(remark).trim()) ||
      extractRemark(descText) ||
      null;
    if (resolvedRemark && !/Remark\s*:/i.test(descText)) {
      descText = `${descText} Remark: ${resolvedRemark}`;
    }

    await logActivity(
      operator_email,
      reqActionType,
      record_type,
      descText,
      record_id,
      resolvedRemark
    );

    // Fetch the inserted row to return its ID
    const [inserted] = await db.query(`
      SELECT id FROM do_operator_activities 
      WHERE operator_email = ? AND action = ? AND log_type = ? AND permission_req = ?
      ORDER BY id DESC LIMIT 1
    `, [operator_email, reqActionType, record_type, record_id]);

    // Sub-Admin push (works when their app is closed)
    setImmediate(() => {
      notifySubAdminsPermissionRequest({
        operatorEmail: operator_email,
        recordType: record_type,
        action
      }).catch(() => {});
    });

    return res.status(201).json({
      message: 'Permission request submitted successfully.',
      requestId: inserted[0] ? inserted[0].id : null
    });
  } catch (err) {
    return handleControllerError(res, err, {
      checkpoint: 'createPermissionRequest',
      req,
      clientMessage: 'Failed to create permission request.'
    });
  }
};

/** Super Admin approves or denies a pending permission request (sends push to DO). */
exports.updatePermissionRequestStatus = async (req, res) => {
  try {
    const { id } = req.params; // The ID of the REQUEST log entry
    const { status, remark: saRemarkRaw } = req.body; // 'Approved' or 'Denied' + remark (required on Deny)

    if (!['Approved', 'Denied'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status. Must be Approved or Denied.' });
    }

    const saRemarkEarly = saRemarkRaw != null ? String(saRemarkRaw).trim() : '';
    if (status === 'Denied' && !saRemarkEarly) {
      return res.status(400).json({
        error: 'A remark is required when denying a permission request.'
      });
    }

    // --- Load original REQUEST row ---
    const [reqRows] = await db.query(`
      SELECT operator_email, action, log_type AS record_type, permission_req AS record_id, description, remark
      FROM do_operator_activities 
      WHERE id = ? LIMIT 1
    `, [id]);

    if (reqRows.length === 0) {
      return res.status(404).json({ error: 'Permission request log not found.' });
    }

    const {
      operator_email,
      action: requestAction,
      record_type,
      record_id,
      description: requestDescription,
      remark: requestRemarkCol
    } = reqRows[0];
    const isEdit = requestAction === 'REQUEST_EDIT';
    const requestRemark =
      (requestRemarkCol && String(requestRemarkCol).trim()) ||
      extractRemark(requestDescription) ||
      '';
    const saRemark = saRemarkRaw != null ? String(saRemarkRaw).trim() : '';

    // --- Map Approved/Denied to GRANT_* or DENY_* activity action ---
    let targetAction;
    if (status === 'Approved') {
      targetAction = isEdit ? 'GRANT_PERMISSION' : 'GRANT_DELETE';
    } else {
      targetAction = isEdit ? 'DENY_PERMISSION' : 'DENY_DELETE';
    }

    // --- On approve: apply side effects (chamber add, type, client master) ---
    let approvalRefNo = '';
    let chamberName = '';
    let clientName = '';
    let shiftName = '';
    let appliedChamberAdd = null;
    let appliedChamberType = null;
    let appliedClientMaster = null;

    if (record_type === 'Chamber') {
      const [approvalRefRows] = await db.query(
        `SELECT reference_no, chamber_name, client_name, shift
         FROM daily_chamber_temp_logs WHERE id = ? LIMIT 1`,
        [record_id]
      );
      if (approvalRefRows.length > 0) {
        approvalRefNo = approvalRefRows[0].reference_no || '';
        chamberName = approvalRefRows[0].chamber_name || '';
        clientName = approvalRefRows[0].client_name || '';
        shiftName = approvalRefRows[0].shift || '';
      }
    } else if (record_type === 'ChamberMaster') {
      const isAddRequest = /allow to ADD chamber/i.test(requestDescription || '');
      // ADD chamber: create on approve + bump DO chamber_limit (Operators Directory + mobile sync)
      if (status === 'Approved' && isEdit && isAddRequest) {
        appliedChamberAdd = await applyApprovedChamberAdd(operator_email, requestDescription, record_id);
        if (appliedChamberAdd?.name) chamberName = appliedChamberAdd.name;
      }
      if (!chamberName) {
        const [chRows] = await db.query(
          'SELECT name FROM chambers WHERE id = ? LIMIT 1',
          [record_id]
        );
        if (chRows.length > 0) {
          chamberName = chRows[0].name || '';
        } else {
          const nameMatch = String(requestDescription || '').match(/ADD chamber "([^"]+)"/i)
            || String(requestDescription || '').match(/delete chamber "([^"]+)"/i)
            || String(requestDescription || '').match(/EDIT chamber type "([^"]+)"/i)
            || String(requestDescription || '').match(/EDIT chamber "([^"]+)"/i);
          chamberName = nameMatch?.[1] || 'Chamber';
        }
      }
    } else if (record_type === 'ChamberType') {
      if (status === 'Approved' && isEdit) {
        appliedChamberType = await applyApprovedChamberTypeChange(requestDescription, record_id);
        if (appliedChamberType?.name) chamberName = appliedChamberType.name;
      }
      if (!chamberName) {
        const [chRows] = await db.query(
          'SELECT name FROM chambers WHERE id = ? LIMIT 1',
          [record_id]
        );
        if (chRows.length > 0) {
          chamberName = chRows[0].name || '';
        } else {
          const nameMatch = String(requestDescription || '').match(/EDIT chamber type "([^"]+)"/i);
          chamberName = nameMatch?.[1] || 'Chamber';
        }
      }
    } else if (record_type === 'ClientMaster') {
      if (status === 'Approved') {
        appliedClientMaster = await applyApprovedClientMasterChange(
          operator_email,
          requestDescription,
          record_id,
          !isEdit
        );
      }
      const addMatch = String(requestDescription || '').match(/ADD client "([^"]+)"/i);
      const delMatch = String(requestDescription || '').match(/DELETE client "([^"]+)"/i);
      const editMatch = String(requestDescription || '').match(/EDIT client "([^"]+)"\s*(?:→|->)\s*"([^"]+)"/i);
      const chamberMatch = String(requestDescription || '').match(/on chamber "([^"]+)"/i);
      chamberName = chamberMatch?.[1] || 'Chamber';
      if (appliedClientMaster?.client_name) {
        clientName = appliedClientMaster.old_name
          ? `${appliedClientMaster.old_name} → ${appliedClientMaster.client_name}`
          : appliedClientMaster.client_name;
      } else if (editMatch) {
        clientName = `${editMatch[1]} → ${editMatch[2]}`;
      } else {
        clientName = addMatch?.[1] || delMatch?.[1] || 'Client';
      }
    } else if (record_type === 'Inward') {
      const [approvalRefRows] = await db.query(
        'SELECT reference_no FROM inward_temp_logs WHERE inward_id = ? LIMIT 1',
        [record_id]
      );
      if (approvalRefRows.length > 0) approvalRefNo = approvalRefRows[0].reference_no || '';
    } else if (record_type === 'Outward') {
      const [approvalRefRows] = await db.query(
        'SELECT reference_no FROM outward_temp_logs WHERE outward_id = ? LIMIT 1',
        [record_id]
      );
      if (approvalRefRows.length > 0) approvalRefNo = approvalRefRows[0].reference_no || '';
    }

    const isAddRequest = record_type === 'ChamberMaster' && /allow to ADD chamber/i.test(requestDescription || '');
    const actionWord =
      record_type === 'MasterSetup'
        ? 'Master Setup'
        : record_type === 'ChamberType'
          ? 'Chamber Type'
        : record_type === 'ChamberMaster'
          ? (isEdit ? (isAddRequest ? 'Chamber Add' : 'Chamber Edit') : 'Chamber Delete')
          : record_type === 'ClientMaster'
            ? (isEdit ? 'Client Edit' : 'Client Delete')
            : (isEdit ? 'Edit' : 'Delete');
    const outcome = status === 'Approved' ? 'approved' : 'denied';
    const detailParts =
      record_type === 'MasterSetup'
        ? ['Chambers & Clients management']
        : record_type === 'ChamberType'
          ? [
              'Type change',
              chamberName || 'Chamber',
              appliedChamberType?.old_type && appliedChamberType?.chamber_type
                ? `${appliedChamberType.old_type} → ${appliedChamberType.chamber_type}`
                : null
            ].filter(Boolean)
        : record_type === 'ChamberMaster'
          ? [isEdit ? (isAddRequest ? 'Add chamber' : 'Edit chamber') : 'Master delete', chamberName || 'Chamber']
          : record_type === 'ClientMaster'
            ? [
                isEdit
                  ? (/EDIT client "/i.test(requestDescription || '') ? 'Rename client' : 'Add client')
                  : 'Delete client',
                clientName,
                chamberName
              ].filter(Boolean)
            : [chamberName, clientName, shiftName, approvalRefNo || `#${record_id}`].filter(Boolean);

    let saActor = '';
    try {
      saActor = await getActorLabel(req.user);
    } catch (_) {
      saActor = req.user?.email || 'Super Admin';
    }

    const approvalParts = [
      `${actionWord} ${outcome}`,
      detailParts.join(' · '),
      requestRemark ? `Request remark: ${requestRemark}` : null,
      saRemark ? `Admin remark: ${saRemark}` : null,
      saActor ? `Decided by: ${saActor}` : null
    ].filter(Boolean);
    const approvalMessage = approvalParts.join(' · ');
    const storedRemark = saRemark || requestRemark || null;

    // --- Write GRANT_* or DENY_* row + notify DO via push ---
    await logActivity(
      operator_email,
      targetAction,
      record_type,
      approvalMessage,
      record_id,
      storedRemark
    );

    // ClientMaster is applied on approve — consume GRANT now so DO cannot
    // reuse the same allow for the next master change (live DB stale GRANT bug).
    if (status === 'Approved' && record_type === 'ClientMaster') {
      try {
        await exports.consumeGrantedPermission(
          operator_email,
          'ClientMaster',
          record_id,
          isEdit ? 'Edit' : 'Delete'
        );
      } catch (_) {}
    }

    // DO push when app is closed (Approved / Denied)
    setImmediate(() => {
      notifyDoOperatorPermissionDecision({
        operatorEmail: operator_email,
        status,
        recordType: record_type,
        adminRemark: saRemark || null
      }).catch(() => {});
    });

    return res.json({
      message: `Permission request ${status.toLowerCase()} successfully.`,
      chamber_add: appliedChamberAdd || null,
      chamber_type: appliedChamberType || null,
      client_master: appliedClientMaster || null,
      remark: storedRemark
    });
  } catch (err) {
    return handleControllerError(res, err, {
      checkpoint: 'updatePermissionRequest',
      req,
      clientMessage: 'Failed to update permission request.'
    });
  }
};

/**
 * DO or Super Admin marks a permission notification as completed in the app.
 * WHY: Clears the inbox and may consume one-time GRANT rows for master changes.
 */
exports.markPermissionActionComplete = async (req, res) => {
  try {
    const { id } = req.params;

    const [rows] = await db.query(
      `SELECT id, operator_email, action, log_type, permission_req FROM do_operator_activities WHERE id = ? LIMIT 1`,
      [id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Notification not found.' });
    }

    const row = rows[0];
    const allowedActions = [
      'REQUEST_EDIT',
      'REQUEST_DELETE',
      'GRANT_PERMISSION',
      'GRANT_DELETE',
      'DENY_PERMISSION',
      'DENY_DELETE',
      'USE_EDIT_PERMISSION',
      'USE_DELETE_PERMISSION'
    ];
    if (!allowedActions.includes(row.action)) {
      return res.status(400).json({ error: 'This activity cannot be marked complete.' });
    }

    if (req.user.role !== 'super_admin' && row.operator_email !== req.user.email) {
      return res.status(403).json({ error: 'Not allowed to update this notification.' });
    }

    await db.query(
      `UPDATE do_operator_activities SET do_action_completed_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [id]
    );

    // One-time grants: consume so next action needs SA approve again
    if (
      (row.log_type === 'MasterSetup' ||
        row.log_type === 'ChamberMaster' ||
        row.log_type === 'ClientMaster') &&
      (row.action === 'GRANT_PERMISSION' || row.action === 'GRANT_DELETE')
    ) {
      try {
        await exports.consumeGrantedPermission(
          row.operator_email,
          row.log_type,
          row.permission_req,
          row.action === 'GRANT_DELETE' ? 'Delete' : 'Edit'
        );
      } catch (_) {}
    }

    const [updated] = await db.query(
      `SELECT do_action_completed_at FROM do_operator_activities WHERE id = ? LIMIT 1`,
      [id]
    );

    return res.json({
      message: 'Notification moved to completed.',
      do_action_completed_at: updated[0]?.do_action_completed_at || null
    });
  } catch (err) {
    return handleControllerError(res, err, {
      checkpoint: 'markPermissionActionComplete',
      req,
      clientMessage: 'Failed to mark notification complete.'
    });
  }
};

/**
 * Structured Super Allow trail for History Log / Profile Lookup.
 * Query: record_type=Chamber|Inward|Outward|ChamberMaster..., record_id=<id>
 */
exports.getRecordPermissionHistory = async (req, res) => {
  try {
    const record_type = String(req.query.record_type || '').trim();
    const record_id = parseInt(req.query.record_id, 10);

    if (!record_type || !Number.isFinite(record_id)) {
      return res.status(400).json({ error: 'record_type and record_id are required.' });
    }

    // Normalize common aliases from frontend
    let logType = record_type;
    if (/^chamber/i.test(record_type) && !/master/i.test(record_type)) logType = 'Chamber';
    if (/^inward/i.test(record_type)) logType = 'Inward';
    if (/^outward/i.test(record_type)) logType = 'Outward';

    const [rows] = await db.query(
      `
      SELECT
        id,
        operator_email,
        action,
        log_type,
        description,
        remark,
        permission_req,
        created_at,
        do_action_completed_at,
        CASE
          WHEN action IN ('REQUEST_EDIT', 'REQUEST_DELETE') THEN 'Pending'
          WHEN action IN ('GRANT_PERMISSION', 'GRANT_DELETE') THEN 'Approved'
          WHEN action IN ('USE_EDIT_PERMISSION', 'USE_DELETE_PERMISSION') THEN 'Used'
          WHEN action IN ('DENY_PERMISSION', 'DENY_DELETE') THEN 'Denied'
          ELSE action
        END AS decision
      FROM do_operator_activities
      WHERE permission_req = ?
        AND (
          log_type = ?
          OR (? = 'Chamber' AND (log_type = 'Chamber' OR log_type LIKE 'Chamber%'))
          OR (? = 'Inward' AND (log_type = 'Inward' OR log_type LIKE 'Inward%'))
          OR (? = 'Outward' AND (log_type = 'Outward' OR log_type LIKE 'Outward%'))
        )
        AND action IN (
          'REQUEST_EDIT', 'REQUEST_DELETE',
          'GRANT_PERMISSION', 'GRANT_DELETE',
          'DENY_PERMISSION', 'DENY_DELETE',
          'USE_EDIT_PERMISSION', 'USE_DELETE_PERMISSION',
          'UPDATE', 'DELETE', 'CREATE'
        )
      ORDER BY id ASC
      `,
      [record_id, logType, logType, logType, logType]
    );

    const items = (rows || []).map((row) => {
      const desc = String(row.description || '');
      const requestRemark =
        (row.remark && String(row.remark).trim()) ||
        extractRemark(desc) ||
        '';
      const saRemarkMatch = desc.match(/SA remark:\s*([^·]+)/i);
      const decidedByMatch = desc.match(/Decided by:\s*([^·]+)/i);
      const changesMatch = desc.match(/Changes:\s*([^·]+?)(?:\.\s*Remarks:|$)/i);
      const changesText = changesMatch ? changesMatch[1].trim() : '';
      const change_rows = [];
      if (changesText) {
        const segments = changesText.split(/\s*\|\s*/);
        segments.forEach((segment) => {
          String(segment)
            .split(/\s*,\s*(?=[^,:]+:\s)/)
            .forEach((part) => {
              const m = part.match(/^(.*?):\s*(.*?)\s*(?:➔|→|->)\s*(.*)$/);
              if (m) {
                change_rows.push({
                  field: m[1].trim(),
                  from: m[2].trim() || 'N/A',
                  to: m[3].trim() || 'N/A'
                });
              }
            });
        });
      }
      const isEdit = /EDIT|GRANT_PERMISSION|REQUEST_EDIT|USE_EDIT|UPDATE/i.test(row.action);
      const isDelete = /DELETE|GRANT_DELETE|REQUEST_DELETE|USE_DELETE/i.test(row.action);

      let eventLabel = row.decision || row.action;
      const audit = enrichActivityWithDecisionAudit(row);
      const actorBit = audit.decided_by_name || audit.decided_by_email
        ? ` by ${[audit.decided_by_role, audit.decided_by_name].filter(Boolean).join(' ')}${audit.decided_by_email ? ` (${audit.decided_by_email})` : ''}`
        : '';
      if (row.action === 'REQUEST_EDIT') eventLabel = 'DO requested Edit allow';
      else if (row.action === 'REQUEST_DELETE') eventLabel = 'DO requested Delete allow';
      else if (row.action === 'GRANT_PERMISSION') eventLabel = `Edit ALLOWED${actorBit}`;
      else if (row.action === 'GRANT_DELETE') eventLabel = `Delete ALLOWED${actorBit}`;
      else if (row.action === 'DENY_PERMISSION') eventLabel = `Edit DENIED${actorBit}`;
      else if (row.action === 'DENY_DELETE') eventLabel = `Delete DENIED${actorBit}`;
      else if (row.action === 'USE_EDIT_PERMISSION') eventLabel = 'DO used Edit permission';
      else if (row.action === 'USE_DELETE_PERMISSION') eventLabel = 'DO used Delete permission';
      else if (row.action === 'UPDATE') eventLabel = 'Record updated (after allow)';
      else if (row.action === 'DELETE') eventLabel = 'Record deleted';

      return {
        id: row.id,
        action: row.action,
        decision: row.decision,
        event_label: eventLabel,
        request_type: isDelete ? 'Delete' : isEdit ? 'Edit' : 'Other',
        operator_email: row.operator_email,
        description: desc,
        remark: requestRemark || null,
        sa_remark: audit.admin_remark || (saRemarkMatch ? saRemarkMatch[1].trim() : null),
        decided_by: audit.decided_by || (decidedByMatch ? decidedByMatch[1].trim() : null),
        decided_by_name: audit.decided_by_name,
        decided_by_email: audit.decided_by_email,
        decided_by_role: audit.decided_by_role,
        changes: changesText || null,
        change_rows,
        date: row.created_at,
        completed_at: row.do_action_completed_at || null
      };
    });

    return res.json({
      success: true,
      record_type: logType,
      record_id,
      count: items.length,
      items
    });
  } catch (err) {
    return handleControllerError(res, err, {
      checkpoint: 'getRecordPermissionHistory',
      req,
      clientMessage: 'Failed to load approval history for this record.'
    });
  }
};

/** Returns whether the DO still has an active grant before opening an edit/delete form. */
exports.checkPermission = async (req, res) => {
  try {
    const { record_type, record_id, action = 'Edit' } = req.query;

    if (!record_type || !record_id) {
      return res.status(400).json({ error: 'Record type and record ID are required.' });
    }

    // Super Admin never needs DO permission approval
    if (req.user?.role === 'super_admin') {
      return res.json({
        approved: true,
        status: 'Approved',
        bypass: true,
        role: 'super_admin'
      });
    }

    const operator_email = req.user.email;

    // --- System-wide Allow vs Require Approval ---
    const configKey = `${record_type}_${action}`;
    const [configRows] = await db.query(`
      SELECT description FROM do_operator_activities
      WHERE operator_email = 'system' AND log_type = 'SYSTEM_CONFIG' AND action = ?
      ORDER BY id DESC LIMIT 1
    `, [configKey]);

    const isDirectAllowed = configRows.length > 0 && configRows[0].description === 'Allow';
    if (isDirectAllowed && !['ChamberType', 'ClientMaster'].includes(String(record_type))) {
      return res.json({ approved: true, status: 'Approved' });
    }

    // --- Latest activity row for this record + operator ---
    const reqActionType = action === 'Edit' ? 'REQUEST_EDIT' : 'REQUEST_DELETE';
    const grantActionType = action === 'Edit' ? 'GRANT_PERMISSION' : 'GRANT_DELETE';
    const denyActionType = action === 'Edit' ? 'DENY_PERMISSION' : 'DENY_DELETE';
    const useActionType = action === 'Edit' ? 'USE_EDIT_PERMISSION' : 'USE_DELETE_PERMISSION';

    const [rows] = await db.query(`
      SELECT action, id, description FROM do_operator_activities
      WHERE operator_email = ? AND log_type = ? AND permission_req = ?
      ORDER BY id DESC LIMIT 1
    `, [operator_email, record_type, record_id]);

    if (rows.length === 0) {
      return res.json({ approved: false, status: 'None' });
    }

    const latest = rows[0];
    let calculatedStatus = 'None';
    if (latest.action === reqActionType) calculatedStatus = 'Pending';
    else if (latest.action === grantActionType) calculatedStatus = 'Approved';
    else if (latest.action === denyActionType) calculatedStatus = 'Denied';
    else if (latest.action === useActionType) calculatedStatus = 'Used';

    return res.json({
      approved: latest.action === grantActionType,
      status: calculatedStatus,
      request: {
        id: latest.id,
        operator_email,
        record_type,
        record_id,
        action,
        status: calculatedStatus,
        description: latest.description
      }
    });
  } catch (err) {
    return handleControllerError(res, err, {
      checkpoint: 'checkPermission',
      req,
      clientMessage: 'Failed to check permission.'
    });
  }
};

/**
 * One-time grant: after DO successfully edits/deletes, mark permission as used
 * so another Super Admin approval is required for the next change.
 */
exports.consumeGrantedPermission = async (operatorEmail, recordType, recordId, action = 'Edit') => {
  if (!operatorEmail || !recordType || !recordId) return false;

  const grantActionType = action === 'Edit' ? 'GRANT_PERMISSION' : 'GRANT_DELETE';
  const useActionType = action === 'Edit' ? 'USE_EDIT_PERMISSION' : 'USE_DELETE_PERMISSION';

  const [rows] = await db.query(
    `SELECT action FROM do_operator_activities
     WHERE operator_email = ? AND log_type = ? AND permission_req = ?
     ORDER BY id DESC LIMIT 1`,
    [operatorEmail, recordType, recordId]
  );

  if (!rows.length || rows[0].action !== grantActionType) {
    return false;
  }

  const actionWord = action === 'Edit' ? 'Edit' : 'Delete';
  await logActivity(
    operatorEmail,
    useActionType,
    recordType,
    `${actionWord} used · #${recordId}`,
    recordId
  );
  return true;
};

/**
 * Returns true if DO may proceed (system Allow, or active GRANT not yet used).
 * Super Admin / Customer callers should not use this gate.
 */
exports.hasActivePermission = async (operatorEmail, recordType, recordId, action = 'Edit') => {
  const configKey = `${recordType}_${action}`;
  const [configRows] = await db.query(
    `SELECT description FROM do_operator_activities
     WHERE operator_email = 'system' AND log_type = 'SYSTEM_CONFIG' AND action = ?
     ORDER BY id DESC LIMIT 1`,
    [configKey]
  );
  if (configRows.length > 0 && configRows[0].description === 'Allow' && !['ChamberType', 'ClientMaster'].includes(String(recordType))) {
    return true;
  }

  const grantActionType = action === 'Edit' ? 'GRANT_PERMISSION' : 'GRANT_DELETE';
  // Only look at decision / use rows — ignore a newer REQUEST that would otherwise hide the GRANT.
  const [rows] = await db.query(
    `SELECT action FROM do_operator_activities
     WHERE LOWER(TRIM(operator_email)) = LOWER(TRIM(?))
       AND log_type = ?
       AND permission_req = ?
       AND action IN (
         'GRANT_PERMISSION', 'GRANT_DELETE',
         'DENY_PERMISSION', 'DENY_DELETE',
         'USE_EDIT_PERMISSION', 'USE_DELETE_PERMISSION'
       )
     ORDER BY id DESC LIMIT 1`,
    [operatorEmail, recordType, recordId]
  );
  return rows.length > 0 && rows[0].action === grantActionType;
};

/** Reads global permission toggles (whether DO must request approval). */
exports.getSystemConfig = async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT action AS config_key, description AS config_value FROM do_operator_activities
      WHERE operator_email = 'system' AND log_type = 'SYSTEM_CONFIG'
      AND id IN (
        SELECT MAX(id) FROM do_operator_activities
        WHERE operator_email = 'system' AND log_type = 'SYSTEM_CONFIG'
        GROUP BY action
      )
    `);
    
    // Default system configurations
    const config = {
      Chamber_Edit: 'Require Approval',
      Chamber_Delete: 'Require Approval',
      ChamberMaster_Edit: 'Require Approval',
      ChamberMaster_Delete: 'Require Approval',
      ClientMaster_Edit: 'Require Approval',
      ClientMaster_Delete: 'Require Approval',
      Inward_Edit: 'Require Approval',
      Inward_Delete: 'Require Approval',
      Outward_Edit: 'Require Approval',
      Outward_Delete: 'Require Approval',
    };

    rows.forEach(row => {
      config[row.config_key] = row.config_value;
    });

    return res.json(config);
  } catch (err) {
    return handleControllerError(res, err, {
      checkpoint: 'getSystemConfig',
      req,
      clientMessage: 'Failed to fetch configuration.'
    });
  }
};

/** Updates global permission policy flags (Super Admin only). */
exports.updateSystemConfig = async (req, res) => {
  try {
    const { config_key, config_value } = req.body;
    if (!config_key || !['Allow', 'Require Approval'].includes(config_value)) {
      return res.status(400).json({ error: 'Invalid configuration key or value.' });
    }

    await logActivity(
      'system',
      config_key,
      'SYSTEM_CONFIG',
      config_value,
      null
    );

    // Also log this as a security event for audit purposes
    await logActivity(
      req.user.email,
      'UPDATE_CONFIG',
      'SECURITY',
      `Updated permission configuration: Set DO operator access for ${config_key.replace('_', ' ')} to ${config_value}`,
      null
    );

    return res.json({ message: 'Configuration updated successfully.' });
  } catch (err) {
    return handleControllerError(res, err, {
      checkpoint: 'updateSystemConfig',
      req,
      clientMessage: 'Failed to update configuration.'
    });
  }
};
