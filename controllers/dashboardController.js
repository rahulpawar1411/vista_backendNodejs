// ====================================================================
// Dashboard Controller (controllers/dashboardController.js)
// --------------------------------------------------------------------
// Mobile/web summary APIs: stats, inventory reconciliation, DO task overview.
// Errors: always return via handleControllerError (safe message + checkpoint).
// Customer inventory rows are filtered by allowed_clients / allowed_warehouses.
// ====================================================================

const db = require('../config/db');
const { handleControllerError } = require('../utils/errorHandler');

function parseCsvNames(value) {
  if (value == null) return [];
  if (Array.isArray(value)) {
    return value.map((v) => String(v || '').trim()).filter(Boolean);
  }
  return String(value)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Scope inventory rows to customer allowed clients / warehouses. */
function matchesScopeToken(tokens, name, code) {
  if (!tokens.length) return true;
  const n = String(name || '').trim().toLowerCase();
  const c = String(code || '').trim().toLowerCase();
  return (c && tokens.includes(c)) || (n && tokens.includes(n));
}

function applyCustomerInventoryScope(rows, user) {
  if (!user || user.role !== 'customer') return rows;
  const clients = parseCsvNames(user.allowed_clients).map((c) => c.toLowerCase());
  const warehouses = parseCsvNames(user.allowed_warehouses).map((w) => w.toLowerCase());
  if (clients.length === 0 && warehouses.length === 0) return rows;

  return (rows || []).filter((r) => {
    const clientOk = matchesScopeToken(clients, r.client_name, r.client_code);
    const warehouseOk = matchesScopeToken(warehouses, r.warehouse_name, r.warehouse_code);
    return clientOk && warehouseOk;
  });
}

/** Scope inventory rows to DO operator warehouse + assigned clients. */
async function applyDoInventoryScope(rows, user) {
  if (!user || user.role !== 'do_operator') return rows;

  let warehouse = String(user.warehouse_name || user.warehouse || '').trim();
  let limit = parseInt(user.chamber_limit || 4, 10);
  if (!Number.isFinite(limit) || limit < 1) limit = 4;

  try {
    const [opRows] = await db.query(
      'SELECT warehouse_name, warehouse_code, chamber_limit FROM do_operators WHERE email = ? LIMIT 1',
      [user.email]
    );
    if (opRows.length > 0) {
      if (opRows[0].warehouse_name) {
        warehouse = String(opRows[0].warehouse_name).trim();
      }
      if (opRows[0].warehouse_code) {
        user.warehouse_code = opRows[0].warehouse_code;
      }
      const lim = parseInt(opRows[0].chamber_limit || limit, 10);
      if (Number.isFinite(lim) && lim >= 1) limit = lim;
    }
  } catch (_) {
    // keep JWT/profile values
  }

  let filtered = Array.isArray(rows) ? [...rows] : [];
  const whLower = warehouse.toLowerCase();
  const codeLower = String(user.warehouse_code || '').trim().toLowerCase();

  // Same rule as chamber-temp DO access: own warehouse (code or name) OR blank warehouse
  if (whLower || codeLower) {
    filtered = filtered.filter((r) => {
      const wh = String(r.warehouse_name || '').trim().toLowerCase();
      const code = String(r.warehouse_code || '').trim().toLowerCase();
      if (!wh && !code) return true;
      if (codeLower && code && code === codeLower) return true;
      if (whLower && wh && wh === whLower) return true;
      return false;
    });
  }

  // Clients the DO can work with: active assignments for their warehouse + chamber limit
  try {
    const [assignRows] = await db.query(
      `SELECT cca.client_name, c.name AS chamber_name
       FROM chamber_client_assignments cca
       JOIN chambers c ON cca.chamber_id = c.id
       WHERE cca.status = 'active'
         AND (
           ? = ''
           OR cca.warehouse_name IS NULL
           OR TRIM(cca.warehouse_name) = ''
           OR LOWER(TRIM(cca.warehouse_name)) = ?
         )`,
      [warehouse, whLower]
    );

    const clients = new Set();
    (assignRows || []).forEach((row) => {
      const name = String(row.chamber_name || '');
      const m = name.match(/^Chamber\s+(\d+)$/i);
      const num = m
        ? parseInt(m[1], 10)
        : (() => {
            const any = name.match(/(\d+)/);
            return any ? parseInt(any[1], 10) : null;
          })();
      if (num != null && num > limit) return;
      const client = String(row.client_name || '').trim().toLowerCase();
      if (client && client !== 'general') clients.add(client);
    });

    if (clients.size > 0) {
      const byClient = filtered.filter((r) =>
        clients.has(String(r.client_name || '').trim().toLowerCase())
      );
      // Keep client filter only when it still returns data; else keep warehouse-scoped rows
      if (byClient.length > 0) filtered = byClient;
    }
  } catch (err) {
    console.warn('DO inventory client scope skipped:', err.message);
  }

  return filtered;
}

/**
 * GET DASHBOARD STATS SUMMARY
 * Calculates totals, status breakdown, and total revenue pipeline.
 */
exports.getDashboardStats = async (req, res) => {
  try {
    // 1. Total count of all leads
    const [totalRows] = await db.query('SELECT COUNT(*) as totalLeads FROM leads');
    
    // 2. Count leads by status
    const [newRows] = await db.query("SELECT COUNT(*) as newLeads FROM leads WHERE status = 'New'");
    const [inProgressRows] = await db.query("SELECT COUNT(*) as inProgressLeads FROM leads WHERE status = 'In Progress'");
    const [wonRows] = await db.query("SELECT COUNT(*) as wonLeads FROM leads WHERE status = 'Won'");

    // 3. Calculate total pipeline value (INR)
    const [valueRows] = await db.query('SELECT SUM(value) as totalValue FROM leads');

    // 4. Customers and operators count
    let totalCustomers = 0;
    try {
      const [subRows] = await db.query('SELECT COUNT(*) as totalCustomers FROM customers');
      totalCustomers = subRows[0].totalCustomers || 0;
    } catch (err) {
      if (err.code === 'ER_NO_SUCH_TABLE') {
        const [subRows] = await db.query('SELECT COUNT(*) as totalCustomers FROM sub_admins');
        totalCustomers = subRows[0].totalCustomers || 0;
      } else {
        throw err;
      }
    }
    const [operatorRows] = await db.query('SELECT COUNT(*) as totalOperators FROM do_operators');

    // 5. Calculate Overdue chamber inspections for the past 5 days
    let overdueCount = 0;
    try {
      // Fetch all active assignments
      const [assignments] = await db.query(`
        SELECT a.chamber_id, a.client_name, c.name as chamber_name 
        FROM chamber_client_assignments a 
        JOIN chambers c ON a.chamber_id = c.id
      `);

      // Generate dates for the past 5 days
      const pastDates = [];
      for (let i = 1; i <= 5; i++) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        pastDates.push(d.toISOString().split('T')[0]);
      }

      if (assignments.length > 0 && pastDates.length > 0) {
        // Fetch all logs in the past 5 days
        const [pastLogs] = await db.query(
          'SELECT entry_date, client_name, chamber_name FROM daily_chamber_temp_logs WHERE entry_date IN (?)',
          [pastDates]
        );

        // Normalize database dates to YYYY-MM-DD strings for fast lookup
        const logMap = {};
        pastLogs.forEach(log => {
          if (!log.entry_date) return;
          let dateStr = log.entry_date;
          if (log.entry_date instanceof Date) {
            dateStr = log.entry_date.toISOString().split('T')[0];
          } else {
            dateStr = String(log.entry_date).split('T')[0];
          }
          const key = `${dateStr}_${log.chamber_name}_${log.client_name}`.toLowerCase();
          logMap[key] = true;
        });

        // Check which dates/assignments are missing logs
        pastDates.forEach(date => {
          assignments.forEach(item => {
            const key = `${date}_${item.chamber_name}_${item.client_name}`.toLowerCase();
            if (!logMap[key]) {
              overdueCount++;
            }
          });
        });
      }
    } catch (dbErr) {
      console.warn('⚠️ Overdue calculations query failed or table not found:', dbErr.message);
    }

    return res.status(200).json({
      success: true,
      stats: {
        totalLeads: totalRows[0].totalLeads || 0,
        newLeads: newRows[0].newLeads || 0,
        inProgressLeads: inProgressRows[0].inProgressLeads || 0,
        wonLeads: wonRows[0].wonLeads || 0,
        totalValue: parseFloat(valueRows[0].totalValue || 0),
        totalSubAdmins: totalCustomers,
        totalCustomers,
        totalOperators: operatorRows[0].totalOperators || 0,
        overdueInspections: overdueCount
      }
    });
  } catch (error) {
    return handleControllerError(res, error, {
      checkpoint: 'getDashboardStats',
      req,
      clientMessage: 'Server error while calculating dashboard statistics.'
    });
  }
};

/**
 * GET DISTINCT CLIENTS & WAREHOUSES (for Customer access scope selection)
 * Includes every client name that has saved data (logs + master assignments),
 * even after the Data Operator account is deleted.
 */
exports.getAccessScopeOptions = async (req, res) => {
  try {
    const clientSet = new Set();
    const warehouseSet = new Set();
    const warehouseClients = new Map(); // warehouse -> Set(client)

    const addWarehouseClient = (warehouse, client) => {
      const wh = warehouse != null ? String(warehouse).trim() : '';
      const cl = client != null ? String(client).trim() : '';
      if (!wh || !cl) return;
      if (!warehouseClients.has(wh)) warehouseClients.set(wh, new Set());
      warehouseClients.get(wh).add(cl);
      warehouseSet.add(wh);
      clientSet.add(cl);
    };

    const clientQueries = [
      // Clients added to chambers in Master Setup (DB assignments) — include even if inactive / DO deleted
      `SELECT DISTINCT cca.client_name AS name
       FROM chamber_client_assignments cca
       INNER JOIN chambers c ON c.id = cca.chamber_id
       WHERE cca.client_name IS NOT NULL AND TRIM(cca.client_name) != ''`,
      // Fallback if join fails older DBs: assignments without requiring chamber row
      `SELECT DISTINCT client_name AS name FROM chamber_client_assignments WHERE client_name IS NOT NULL AND TRIM(client_name) != ''`,
      `SELECT DISTINCT client_name AS name FROM daily_chamber_temp_logs WHERE client_name IS NOT NULL AND TRIM(client_name) != ''`,
      `SELECT DISTINCT inward_client_name AS name FROM inward_temp_logs WHERE inward_client_name IS NOT NULL AND TRIM(inward_client_name) != ''`,
      `SELECT DISTINCT outward_client_name AS name FROM outward_temp_logs WHERE outward_client_name IS NOT NULL AND TRIM(outward_client_name) != ''`,
      `SELECT DISTINCT client_name AS name FROM daily_temp_logs WHERE client_name IS NOT NULL AND TRIM(client_name) != ''`,
      `SELECT DISTINCT client_name AS name FROM leads WHERE client_name IS NOT NULL AND TRIM(client_name) != ''`,
      `SELECT DISTINCT client_name AS name FROM inward_outward_logs WHERE client_name IS NOT NULL AND TRIM(client_name) != ''`
    ];

    for (const sql of clientQueries) {
      try {
        const [rows] = await db.query(sql);
        rows.forEach((row) => {
          if (row.name) clientSet.add(String(row.name).trim());
        });
      } catch (tableErr) {
        console.warn('Access scope client query skipped:', tableErr.message);
      }
    }

    const warehouseQueries = [
      `SELECT DISTINCT warehouse_name AS name FROM daily_chamber_temp_logs WHERE warehouse_name IS NOT NULL AND TRIM(warehouse_name) != ''`,
      `SELECT DISTINCT warehouse_name AS name FROM inward_temp_logs WHERE warehouse_name IS NOT NULL AND TRIM(warehouse_name) != ''`,
      `SELECT DISTINCT warehouse_name AS name FROM outward_temp_logs WHERE warehouse_name IS NOT NULL AND TRIM(warehouse_name) != ''`,
      `SELECT DISTINCT warehouse_name AS name FROM daily_temp_logs WHERE warehouse_name IS NOT NULL AND TRIM(warehouse_name) != ''`,
      `SELECT DISTINCT warehouse_name AS name FROM do_operators WHERE warehouse_name IS NOT NULL AND TRIM(warehouse_name) != ''`,
      `SELECT DISTINCT warehouse_name AS name FROM chamber_client_assignments WHERE warehouse_name IS NOT NULL AND TRIM(warehouse_name) != ''`
    ];

    for (const sql of warehouseQueries) {
      try {
        const [rows] = await db.query(sql);
        rows.forEach((row) => {
          if (row.name) warehouseSet.add(String(row.name).trim());
        });
      } catch (tableErr) {
        console.warn('Access scope warehouse query skipped:', tableErr.message);
      }
    }

    // Warehouse → client pairs (for cascading Customer client dropdown)
    const pairQueries = [
      `SELECT DISTINCT warehouse_name, client_name
       FROM chamber_client_assignments
       WHERE warehouse_name IS NOT NULL AND TRIM(warehouse_name) != ''
         AND client_name IS NOT NULL AND TRIM(client_name) != ''`,
      `SELECT DISTINCT warehouse_name, client_name
       FROM daily_chamber_temp_logs
       WHERE warehouse_name IS NOT NULL AND TRIM(warehouse_name) != ''
         AND client_name IS NOT NULL AND TRIM(client_name) != ''`,
      `SELECT DISTINCT warehouse_name, inward_client_name AS client_name
       FROM inward_temp_logs
       WHERE warehouse_name IS NOT NULL AND TRIM(warehouse_name) != ''
         AND inward_client_name IS NOT NULL AND TRIM(inward_client_name) != ''`,
      `SELECT DISTINCT warehouse_name, outward_client_name AS client_name
       FROM outward_temp_logs
       WHERE warehouse_name IS NOT NULL AND TRIM(warehouse_name) != ''
         AND outward_client_name IS NOT NULL AND TRIM(outward_client_name) != ''`,
      // DO warehouse + chamber assignment clients (via chambers.warehouse_name if present)
      `SELECT DISTINCT COALESCE(cca.warehouse_name, c.warehouse_name, op.warehouse_name) AS warehouse_name,
              cca.client_name AS client_name
       FROM chamber_client_assignments cca
       LEFT JOIN chambers c ON c.id = cca.chamber_id
       LEFT JOIN do_operators op ON LOWER(TRIM(op.email)) = LOWER(TRIM(c.operator_email))
       WHERE cca.client_name IS NOT NULL AND TRIM(cca.client_name) != ''`
    ];

    for (const sql of pairQueries) {
      try {
        const [rows] = await db.query(sql);
        rows.forEach((row) => addWarehouseClient(row.warehouse_name, row.client_name));
      } catch (tableErr) {
        console.warn('Access scope warehouse-client pair query skipped:', tableErr.message);
      }
    }

    const warehouseCodeToName = new Map(); // lower(code|name) -> display warehouse_name
    try {
      const [masterWh] = await db.query(
        `SELECT warehouse_code, warehouse_name FROM warehouse_master WHERE is_active = 1 ORDER BY warehouse_name ASC`
      );
      (masterWh || []).forEach((row) => {
        const name = row.warehouse_name != null ? String(row.warehouse_name).trim() : '';
        const code = row.warehouse_code != null ? String(row.warehouse_code).trim() : '';
        if (name) {
          warehouseSet.add(name);
          warehouseCodeToName.set(name.toLowerCase(), name);
        }
        if (code && name) {
          warehouseCodeToName.set(code.toLowerCase(), name);
        }
      });
      const [masterCl] = await db.query(
        `SELECT cm.client_code, cm.client_name, cm.warehouse_name, wm.warehouse_code
         FROM client_master cm
         LEFT JOIN warehouse_master wm
           ON LOWER(TRIM(wm.warehouse_name)) = LOWER(TRIM(COALESCE(cm.warehouse_name, '')))
           OR LOWER(TRIM(wm.warehouse_code)) = LOWER(TRIM(COALESCE(cm.warehouse_name, '')))
         WHERE cm.is_active = 1
         ORDER BY cm.client_name ASC`
      );
      (masterCl || []).forEach((row) => {
        const clientName = row.client_name != null ? String(row.client_name).trim() : '';
        if (!clientName) return;
        clientSet.add(clientName);
        const rawWh = row.warehouse_name != null ? String(row.warehouse_name).trim() : '';
        const resolvedWh =
          (rawWh && warehouseCodeToName.get(rawWh.toLowerCase())) ||
          rawWh ||
          (row.warehouse_code ? warehouseCodeToName.get(String(row.warehouse_code).trim().toLowerCase()) : '') ||
          '';
        if (resolvedWh) addWarehouseClient(resolvedWh, clientName);
        // Also index under code so UI matching by WH-CODE works
        if (row.warehouse_code) addWarehouseClient(String(row.warehouse_code).trim(), clientName);
      });
    } catch (masterErr) {
      console.warn('Access scope master tables skipped:', masterErr.message);
    }

    // Case-insensitive unique display names (prefer first-seen casing)
    const uniqueClients = [];
    const seenClients = new Set();
    [...clientSet]
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
      .forEach((name) => {
        const key = name.toLowerCase();
        if (seenClients.has(key)) return;
        seenClients.add(key);
        uniqueClients.push(name);
      });

    const warehouses = [...warehouseSet].sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: 'base' })
    );

    const warehouseClientMap = {};
    [...warehouseClients.entries()]
      .sort((a, b) => a[0].localeCompare(b[0], undefined, { sensitivity: 'base' }))
      .forEach(([wh, clients]) => {
        const unique = [];
        const seen = new Set();
        [...clients]
          .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
          .forEach((name) => {
            const key = name.toLowerCase();
            if (seen.has(key)) return;
            seen.add(key);
            unique.push(name);
          });
        warehouseClientMap[wh] = unique;
        // Alias: if this key is a code, also expose under the master name (and vice versa)
        const aliasName = warehouseCodeToName.get(String(wh).trim().toLowerCase());
        if (aliasName && aliasName !== wh) {
          if (!warehouseClientMap[aliasName]) warehouseClientMap[aliasName] = [];
          unique.forEach((c) => {
            if (!warehouseClientMap[aliasName].some((x) => String(x).toLowerCase() === c.toLowerCase())) {
              warehouseClientMap[aliasName].push(c);
            }
          });
        }
      });

    return res.json({
      clients: uniqueClients,
      warehouses,
      warehouseClients: warehouseClientMap
    });
  } catch (error) {
    return handleControllerError(res, error, {
      checkpoint: 'getAccessScopeOptions',
      req,
      clientMessage: 'Failed to fetch options.'
    });
  }
};

/**
 * Live warehouse → client filter options from DB (assignments + logs + operators).
 * Used by Daily Box Inventory Tracker cascading filters.
 */
exports.getInventoryFilterOptions = async (req, res) => {
  try {
    const warehouseClients = new Map(); // warehouse -> Set(client)

    const addPair = (warehouse, client) => {
      const wh = warehouse != null ? String(warehouse).trim() : '';
      const cl = client != null ? String(client).trim() : '';
      if (!wh) return;
      if (!warehouseClients.has(wh)) warehouseClients.set(wh, new Set());
      if (cl) warehouseClients.get(wh).add(cl);
    };

    const pairQueries = [
      // Keep inactive/deactivated chamber clients — history & filters must still list them
      `SELECT DISTINCT warehouse_name, client_name
       FROM chamber_client_assignments
       WHERE warehouse_name IS NOT NULL AND TRIM(warehouse_name) != ''
         AND client_name IS NOT NULL AND TRIM(client_name) != ''`,
      `SELECT DISTINCT warehouse_name, client_name
       FROM daily_chamber_temp_logs
       WHERE warehouse_name IS NOT NULL AND TRIM(warehouse_name) != ''
         AND client_name IS NOT NULL AND TRIM(client_name) != ''`,
      `SELECT DISTINCT warehouse_name, inward_client_name AS client_name
       FROM inward_temp_logs
       WHERE warehouse_name IS NOT NULL AND TRIM(warehouse_name) != ''
         AND inward_client_name IS NOT NULL AND TRIM(inward_client_name) != ''`,
      `SELECT DISTINCT warehouse_name, outward_client_name AS client_name
       FROM outward_temp_logs
       WHERE warehouse_name IS NOT NULL AND TRIM(warehouse_name) != ''
         AND outward_client_name IS NOT NULL AND TRIM(outward_client_name) != ''`
    ];

    for (const sql of pairQueries) {
      try {
        const [rows] = await db.query(sql);
        rows.forEach((row) => addPair(row.warehouse_name, row.client_name));
      } catch (tableErr) {
        console.warn('Inventory filter pair query skipped:', tableErr.message);
      }
    }

    // Client master (active + inactive/deactivated) — keep Client (by Warehouse) complete
    try {
      const [masterCl] = await db.query(
        `SELECT cm.client_name, cm.warehouse_name, cm.is_active, wm.warehouse_name AS resolved_warehouse_name
         FROM client_master cm
         LEFT JOIN warehouse_master wm
           ON LOWER(TRIM(wm.warehouse_name)) = LOWER(TRIM(COALESCE(cm.warehouse_name, '')))
           OR LOWER(TRIM(wm.warehouse_code)) = LOWER(TRIM(COALESCE(cm.warehouse_name, '')))
         WHERE cm.client_name IS NOT NULL AND TRIM(cm.client_name) != ''`
      );
      (masterCl || []).forEach((row) => {
        const clientName = row.client_name != null ? String(row.client_name).trim() : '';
        if (!clientName) return;
        const wh =
          (row.resolved_warehouse_name && String(row.resolved_warehouse_name).trim()) ||
          (row.warehouse_name && String(row.warehouse_name).trim()) ||
          '';
        if (wh) addPair(wh, clientName);
      });
    } catch (masterErr) {
      console.warn('Inventory filter client_master query skipped:', masterErr.message);
    }

    // Warehouses configured on DO operators (even if no client rows yet)
    try {
      const [opRows] = await db.query(
        `SELECT DISTINCT warehouse_name
         FROM do_operators
         WHERE warehouse_name IS NOT NULL AND TRIM(warehouse_name) != ''`
      );
      opRows.forEach((row) => addPair(row.warehouse_name, null));
    } catch (opErr) {
      console.warn('Inventory filter operator warehouse query skipped:', opErr.message);
    }

    const warehouses = Array.from(warehouseClients.entries())
      .map(([name, clientSet]) => {
        const clients = Array.from(clientSet).sort((a, b) =>
          a.localeCompare(b, undefined, { sensitivity: 'base' })
        );
        return {
          name,
          client_count: clients.length,
          clients
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

    const allClients = new Set();
    warehouses.forEach((w) => w.clients.forEach((c) => allClients.add(c)));

    return res.status(200).json({
      success: true,
      total_warehouses: warehouses.length,
      total_clients: allClients.size,
      warehouses
    });
  } catch (error) {
    return handleControllerError(res, error, {
      checkpoint: 'getInventoryFilterOptions',
      req,
      clientMessage: 'Server error while loading live warehouse/client filters.'
    });
  }
};

/**
 * GET INVENTORY RECONCILIATION LOG
 * Calculates inward, outward, and daily audit counts with discrepancies.
 */
exports.getInventoryReconciliation = async (req, res) => {
  try {
    const { search, warehouse, client, view, page, limit, offset } = req.query;

    const pageNum = (() => {
      const n = parseInt(page, 10);
      return Number.isFinite(n) && n > 0 ? n : 1;
    })();
    const limitNum = (() => {
      const n = parseInt(limit, 10);
      // Keep a safe clamp to prevent accidental huge loads
      const safe = Number.isFinite(n) && n > 0 ? n : 50;
      return Math.min(200, safe);
    })();
    const offsetNum = (() => {
      const n = parseInt(offset, 10);
      if (Number.isFinite(n) && n >= 0) return n;
      return (pageNum - 1) * limitNum;
    })();

    const sql = `
      SELECT 
        d.client_name,
        d.warehouse_name,
        d.chamber_id,
        d.chamber_name,
        d.chamber_type,
        COALESCE(i.total_inward, 0) AS total_inward_boxes,
        COALESCE(o.total_outward, 0) AS total_outward_boxes,
        GREATEST(0, COALESCE(i.total_inward, 0) - COALESCE(o.total_outward, 0)) AS calculated_balance,
        COALESCE(d.last_box_count, 0) AS physical_audit_count,
        d.last_audit_date,
        (GREATEST(0, COALESCE(i.total_inward, 0) - COALESCE(o.total_outward, 0)) - COALESCE(d.last_box_count, 0)) AS discrepancy
      FROM (
        SELECT
          d1.client_name,
          d1.warehouse_name,
          COALESCE(d1.chamber_id, ch.id, chn.id) AS chamber_id,
          COALESCE(NULLIF(TRIM(d1.chamber_name), ''), ch.name, chn.name) AS chamber_name,
          COALESCE(
            NULLIF(NULLIF(TRIM(ch.chamber_type), ''), 'Other'),
            NULLIF(NULLIF(TRIM(chn.chamber_type), ''), 'Other'),
            NULLIF(NULLIF(TRIM(cca.chamber_type), ''), 'Other'),
            NULLIF(NULLIF(TRIM(d1.chamber_type), ''), 'Other'),
            'Frozen'
          ) AS chamber_type,
          d1.box_count AS last_box_count,
          d1.entry_date AS last_audit_date
        FROM daily_chamber_temp_logs d1
        INNER JOIN (
          SELECT MAX(id) AS max_id
          FROM daily_chamber_temp_logs
          WHERE client_name IS NOT NULL AND TRIM(client_name) != ''
          GROUP BY
            client_name,
            COALESCE(warehouse_name, ''),
            COALESCE(chamber_id, 0),
            LOWER(TRIM(COALESCE(chamber_name, '')))
        ) pick ON d1.id = pick.max_id
        LEFT JOIN chambers ch ON ch.id = d1.chamber_id
        LEFT JOIN chambers chn
          ON (d1.chamber_id IS NULL OR d1.chamber_id = 0)
         AND LOWER(TRIM(chn.name)) = LOWER(TRIM(d1.chamber_name))
        LEFT JOIN chamber_client_assignments cca
          ON cca.status = 'active'
         AND LOWER(TRIM(cca.client_name)) = LOWER(TRIM(d1.client_name))
         AND cca.chamber_id = COALESCE(d1.chamber_id, ch.id, chn.id)
      ) d
      LEFT JOIN (
        SELECT
          LOWER(TRIM(inward_client_name)) AS client_key,
          LOWER(TRIM(IFNULL(warehouse_name, ''))) AS wh_key,
          SUM(
            GREATEST(
              0,
              COALESCE(
                NULLIF(inward_received_boxes_qty, 0),
                NULLIF(inward_received_qty, 0),
                0
              )
            )
          ) AS total_inward
        FROM inward_temp_logs
        WHERE inward_client_name IS NOT NULL AND TRIM(inward_client_name) != ''
        GROUP BY LOWER(TRIM(inward_client_name)), LOWER(TRIM(IFNULL(warehouse_name, '')))
      ) i
        ON LOWER(TRIM(d.client_name)) = i.client_key
       AND LOWER(TRIM(IFNULL(d.warehouse_name, ''))) = i.wh_key
      LEFT JOIN (
        SELECT
          LOWER(TRIM(outward_client_name)) AS client_key,
          LOWER(TRIM(IFNULL(warehouse_name, ''))) AS wh_key,
          SUM(
            GREATEST(
              0,
              COALESCE(
                NULLIF(outward_received_boxes_qty, 0),
                NULLIF(outward_received_qty, 0),
                0
              )
            )
          ) AS total_outward
        FROM outward_temp_logs
        WHERE outward_client_name IS NOT NULL AND TRIM(outward_client_name) != ''
        GROUP BY LOWER(TRIM(outward_client_name)), LOWER(TRIM(IFNULL(warehouse_name, '')))
      ) o
        ON LOWER(TRIM(d.client_name)) = o.client_key
       AND LOWER(TRIM(IFNULL(d.warehouse_name, ''))) = o.wh_key
    `;

    const [rows] = await db.query(sql);

    // One lot per client + chamber + warehouse (never Morning + Evening as two lots)
    const lotMap = new Map();
    for (const r of rows || []) {
      const key = `${String(r.client_name || '')
        .trim()
        .toLowerCase()}|||${String(r.warehouse_name || '')
        .trim()
        .toLowerCase()}|||${r.chamber_id != null ? Number(r.chamber_id) : ''}|||${String(r.chamber_name || '')
        .trim()
        .toLowerCase()}`;
      if (!lotMap.has(key)) lotMap.set(key, r);
    }
    let filteredRows = Array.from(lotMap.values());

    // Customer portal: only assigned clients / warehouses
    filteredRows = applyCustomerInventoryScope(filteredRows, req.user);
    // DO portal: warehouse + assigned clients (chamber_limit aware)
    filteredRows = await applyDoInventoryScope(filteredRows, req.user);

    if (warehouse && warehouse !== 'All') {
      const warehouseLower = warehouse.toLowerCase().trim();
      filteredRows = filteredRows.filter(r => r.warehouse_name && r.warehouse_name.toLowerCase().trim() === warehouseLower);
    }

    if (client && client !== 'All') {
      const clientLower = String(client).toLowerCase().trim();
      filteredRows = filteredRows.filter(
        (r) => r.client_name && r.client_name.toLowerCase().trim() === clientLower
      );
    }

    // View filters (Reports)
    const viewParam = String(view || '').toLowerCase().trim();
    if (viewParam === 'mismatch') {
      // Same rule as frontend:
      // bal = max(0, calculated_balance), phys = max(0, physical_audit_count)
      // mismatch if bal - phys !== 0
      filteredRows = filteredRows.filter((r) => {
        const bal = Math.max(0, Number(r.calculated_balance) || 0);
        const phys = Math.max(0, Number(r.physical_audit_count) || 0);
        return bal - phys !== 0;
      });
    }

    if (search && search.trim() !== '') {
      const searchLower = search.toLowerCase().trim();
      filteredRows = filteredRows.filter(r => 
        (r.client_name && r.client_name.toLowerCase().includes(searchLower)) ||
        (r.warehouse_name && r.warehouse_name.toLowerCase().includes(searchLower)) ||
        (r.chamber_name && r.chamber_name.toLowerCase().includes(searchLower)) ||
        (r.chamber_type && r.chamber_type.toLowerCase().includes(searchLower))
      );
    }

    const total = filteredRows.length;
    const items = filteredRows.slice(offsetNum, offsetNum + limitNum);
    return res.status(200).json({
      success: true,
      total,
      page: pageNum,
      limit: limitNum,
      offset: offsetNum,
      has_more: offsetNum + items.length < total,
      items
    });
  } catch (error) {
    return handleControllerError(res, error, {
      checkpoint: 'getInventoryReconciliation',
      req,
      clientMessage: 'Server error while calculating inventory logs.'
    });
  }
};

/**
 * GET DAILY INVENTORY DELTAS
 * Compares the latest two box counts for each client/chamber combination.
 */
exports.getDailyInventoryDeltas = async (req, res) => {
  try {
    const { warehouse, fromDate, toDate } = req.query;

    const parseTemp = (value) => {
      if (value === null || value === undefined || value === '') return null;
      const n = Number(value);
      return Number.isFinite(n) ? n : null;
    };

    const normalizeShift = (row) => {
      const s = String(row.shift || '').trim();
      if (/^morning$/i.test(s)) return 'Morning';
      if (/^evening$/i.test(s)) return 'Evening';
      const t = String(row.inspection_time || '').trim();
      const tUp = t.toUpperCase();
      if (/^10:00\b/.test(t) || tUp === '10:00 AM') return 'Morning';
      if (/^16:00\b|^18:00\b/.test(t) || tUp.includes('04:00 PM') || tUp.includes('06:00 PM')) {
        return 'Evening';
      }
      const hm = t.match(/^(\d{1,2}):(\d{2})/);
      if (hm) {
        let h = parseInt(hm[1], 10);
        if (tUp.includes('PM') && h < 12) h += 12;
        if (tUp.includes('AM') && h === 12) h = 0;
        return h < 14 ? 'Morning' : 'Evening';
      }
      if (row.created_at) {
        const d = new Date(row.created_at);
        if (!Number.isNaN(d.getTime())) return d.getHours() < 14 ? 'Morning' : 'Evening';
      }
      return 'Morning';
    };

    let sql = `
      SELECT
        id,
        DATE_FORMAT(entry_date, '%Y-%m-%d') AS entry_date,
        client_name,
        chamber_name,
        warehouse_name,
        box_count,
        box_temp,
        box_temp AS chamber_temp,
        shift,
        inspection_time,
        created_at
      FROM daily_chamber_temp_logs 
      WHERE client_name IS NOT NULL AND TRIM(client_name) != ''
    `;
    const params = [];
    if (warehouse && warehouse !== 'All') {
      sql += ` AND LOWER(TRIM(warehouse_name)) = LOWER(TRIM(?)) `;
      params.push(warehouse);
    }
    sql += ` ORDER BY entry_date DESC, id DESC `;

    const [rows] = await db.query(sql, params);

    // Group logs by client + chamber + warehouse
    const groups = {};
    rows.forEach(row => {
      const key = `${row.client_name}|||${row.chamber_name || ''}|||${row.warehouse_name || ''}`;
      if (!groups[key]) {
        groups[key] = [];
      }
      const shiftLabel = normalizeShift(row);
      const dateShiftKey = `${row.entry_date}|||${shiftLabel}`;
      // Keep Morning + Evening for same date (unique by date+slot)
      if (!groups[key].some(item => item._dateShiftKey === dateShiftKey)) {
        groups[key].push({ ...row, shift: shiftLabel, _dateShiftKey: dateShiftKey });
      }
    });

    const deltas = [];
    Object.keys(groups).forEach(key => {
      const parts = key.split('|||');
      const client_name = parts[0];
      const chamber_name = parts[1];
      const warehouse_name = parts[2];
      const groupLogs = groups[key]; // Sorted descending (newest first)

      if (groupLogs.length > 0) {
        // Find the index of the first log that falls within the selected date range
        let indexOfLatest = -1;
        for (let i = 0; i < groupLogs.length; i++) {
          const entryDate = groupLogs[i].entry_date;
          let inRange = true;
          if (fromDate && entryDate < fromDate) inRange = false;
          if (toDate && entryDate > toDate) inRange = false;
          
          if (inRange) {
            indexOfLatest = i;
            break;
          }
        }

        // If a date range was selected and no audit falls inside it, skip this client/chamber
        if ((fromDate || toDate) && indexOfLatest === -1) {
          return;
        }

        // If no filter is matched, indexOfLatest is simply 0 (latest log of all time)
        if (indexOfLatest === -1) {
          indexOfLatest = 0;
        }

        const latest = groupLogs[indexOfLatest];
        const prev = indexOfLatest + 1 < groupLogs.length ? groupLogs[indexOfLatest + 1] : null;

        // Chamber box qty can never be negative
        const latest_count = Math.max(0, Number(latest.box_count) || 0);
        const prev_count = prev ? Math.max(0, Number(prev.box_count) || 0) : 0;
        const rawDelta = latest_count - prev_count;
        // Inward: prev 30 → latest 45 = +15 in | Outward: prev 30 → latest 12 = 18 out (qty never shown as negative)
        const inward_qty = rawDelta > 0 ? rawDelta : 0;
        const outward_qty = rawDelta < 0 ? Math.abs(rawDelta) : 0;
        const flow_type = rawDelta > 0 ? 'inward' : rawDelta < 0 ? 'outward' : 'no_change';

        // Retrieve audits based on selected calendar date filters, else full history (cap 50)
        let historyLogs = [];
        if (fromDate || toDate) {
          historyLogs = groupLogs.filter(g => {
            const entryDate = g.entry_date;
            if (fromDate && entryDate < fromDate) return false;
            if (toDate && entryDate > toDate) return false;
            return true;
          });
        } else {
          historyLogs = groupLogs.slice(0, 50);
        }

        const history = historyLogs
          .map(g => {
            const shift = g.shift || normalizeShift(g);
            const temp = parseTemp(g.box_temp ?? g.chamber_temp);
            const rawCount = g.box_count;
            const count = rawCount === null || rawCount === undefined || rawCount === ''
              ? null
              : Math.max(0, Number(rawCount) || 0);
            return {
              id: g.id,
            date: g.entry_date,
              entry_date: g.entry_date,
              shift,
              slot: shift,
              inspection_time: g.inspection_time || null,
              box_count: count,
              count,
              box_temp: temp,
              temp,
              chamber_temp: temp,
              chamber_name: g.chamber_name || null,
              warehouse_name: g.warehouse_name || null
            };
          })
          // Newest first: date DESC, Evening before Morning same day, then id DESC
          .sort((a, b) => {
            const da = String(a.date || '');
            const db = String(b.date || '');
            if (db !== da) return db.localeCompare(da);
            const sa = a.shift === 'Evening' ? 1 : 0;
            const sb = b.shift === 'Evening' ? 1 : 0;
            if (sb !== sa) return sb - sa;
            return (Number(b.id) || 0) - (Number(a.id) || 0);
          });

        const latest_temp = parseTemp(latest.box_temp ?? latest.chamber_temp);
        const prev_temp = prev ? parseTemp(prev.box_temp ?? prev.chamber_temp) : null;
        const latest_shift = latest.shift || normalizeShift(latest);
        const prev_shift = prev ? (prev.shift || normalizeShift(prev)) : null;

        deltas.push({
          client_name,
          chamber_name: chamber_name || '-',
          warehouse_name: warehouse_name || '-',
          latest_date: latest.entry_date,
          latest_count,
          latest_temp,
          latest_shift,
          latest_slot: latest_shift,
          box_temp: latest_temp,
          prev_date: prev ? prev.entry_date : null,
          prev_count,
          prev_temp,
          prev_shift,
          prev_slot: prev_shift,
          delta: rawDelta,
          inward_qty,
          outward_qty,
          flow_type,
          history
        });
      }
    });

    // Latest updates first
    deltas.sort((a, b) => {
      const da = String(a.latest_date || '');
      const dbDate = String(b.latest_date || '');
      if (dbDate !== da) return dbDate.localeCompare(da);
      return String(a.client_name || '').localeCompare(String(b.client_name || ''));
    });

    return res.status(200).json({
      success: true,
      items: deltas
    });
  } catch (error) {
    return handleControllerError(res, error, {
      checkpoint: 'getDailyInventoryDeltas',
      req,
      clientMessage: 'Server error while calculating daily inventory deltas.'
    });
  }
};

/**
 * GET CLIENT MONTH BOX SHEET
 * Excel-style 1-month (default last 30 days) daily rows for one client lot:
 * Date | Morning qty | Evening qty | Inward boxes | Outward boxes | Total (closing)
 * Plus warehouse, chamber, warehouse supervisor (DO full_name).
 */
exports.getClientMonthBoxSheet = async (req, res) => {
  try {
    const clientName = String(req.query.client || req.query.client_name || '').trim();
    const warehouseName = String(req.query.warehouse || req.query.warehouse_name || '').trim();
    const chamberName = String(req.query.chamber || req.query.chamber_name || '').trim();

    if (!clientName) {
      return res.status(400).json({
        success: false,
        message: 'client (client_name) is required.'
      });
    }

    const pad = (n) => String(n).padStart(2, '0');
    const toYmd = (d) =>
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    let toDate = String(req.query.toDate || '').trim() || toYmd(today);
    let fromDate = String(req.query.fromDate || '').trim();
    if (!fromDate) {
      const from = new Date(today);
      from.setDate(from.getDate() - 29); // 30 calendar days inclusive
      fromDate = toYmd(from);
    }
    if (fromDate > toDate) {
      const tmp = fromDate;
      fromDate = toDate;
      toDate = tmp;
    }

    const normalizeShift = (row) => {
      const s = String(row.shift || '').trim();
      if (/^morning$/i.test(s)) return 'Morning';
      if (/^evening$/i.test(s)) return 'Evening';
      const t = String(row.inspection_time || '').trim();
      const tUp = t.toUpperCase();
      if (/^10:00\b/.test(t) || tUp === '10:00 AM') return 'Morning';
      if (/^16:00\b|^18:00\b/.test(t) || tUp.includes('04:00 PM') || tUp.includes('06:00 PM')) {
        return 'Evening';
      }
      const hm = t.match(/^(\d{1,2}):(\d{2})/);
      if (hm) {
        let h = parseInt(hm[1], 10);
        if (tUp.includes('PM') && h < 12) h += 12;
        if (tUp.includes('AM') && h === 12) h = 0;
        return h < 14 ? 'Morning' : 'Evening';
      }
      if (row.created_at) {
        const d = new Date(row.created_at);
        if (!Number.isNaN(d.getTime())) return d.getHours() < 14 ? 'Morning' : 'Evening';
      }
      return 'Morning';
    };

    // Chamber morning/evening audits for this lot
    let chamberSql = `
      SELECT
        id,
        DATE_FORMAT(entry_date, '%Y-%m-%d') AS entry_date,
        client_name,
        chamber_name,
        warehouse_name,
        box_count,
        box_temp,
        shift,
        inspection_time,
        created_at
      FROM daily_chamber_temp_logs
      WHERE LOWER(TRIM(client_name)) = LOWER(TRIM(?))
        AND entry_date >= ?
        AND entry_date <= ?
    `;
    const chamberParams = [clientName, fromDate, toDate];
    if (warehouseName) {
      chamberSql += ` AND LOWER(TRIM(IFNULL(warehouse_name,''))) = LOWER(TRIM(?)) `;
      chamberParams.push(warehouseName);
    }
    if (chamberName && chamberName !== '-') {
      chamberSql += ` AND LOWER(TRIM(IFNULL(chamber_name,''))) = LOWER(TRIM(?)) `;
      chamberParams.push(chamberName);
    }
    chamberSql += ` ORDER BY entry_date ASC, id ASC `;
    const [chamberRows] = await db.query(chamberSql, chamberParams);

    // Inward boxes by date
    let inwardSql = `
      SELECT
        DATE_FORMAT(inward_entry_date, '%Y-%m-%d') AS entry_date,
        SUM(GREATEST(0, COALESCE(inward_received_boxes_qty, inward_received_qty, 0))) AS boxes
      FROM inward_temp_logs
      WHERE LOWER(TRIM(inward_client_name)) = LOWER(TRIM(?))
        AND inward_entry_date >= ?
        AND inward_entry_date <= ?
    `;
    const inwardParams = [clientName, fromDate, toDate];
    if (warehouseName) {
      inwardSql += ` AND (
        LOWER(TRIM(IFNULL(warehouse_name,''))) = LOWER(TRIM(?))
        OR LOWER(TRIM(IFNULL(warehouse_code,''))) = LOWER(TRIM(?))
      ) `;
      inwardParams.push(warehouseName, warehouseName);
    }
    inwardSql += ` GROUP BY DATE_FORMAT(inward_entry_date, '%Y-%m-%d') `;
    const [inwardRows] = await db.query(inwardSql, inwardParams);

    // Outward boxes by date
    let outwardSql = `
      SELECT
        DATE_FORMAT(outward_entry_date, '%Y-%m-%d') AS entry_date,
        SUM(GREATEST(0, COALESCE(outward_received_boxes_qty, outward_received_qty, 0))) AS boxes
      FROM outward_temp_logs
      WHERE LOWER(TRIM(outward_client_name)) = LOWER(TRIM(?))
        AND outward_entry_date >= ?
        AND outward_entry_date <= ?
    `;
    const outwardParams = [clientName, fromDate, toDate];
    if (warehouseName) {
      outwardSql += ` AND (
        LOWER(TRIM(IFNULL(warehouse_name,''))) = LOWER(TRIM(?))
        OR LOWER(TRIM(IFNULL(warehouse_code,''))) = LOWER(TRIM(?))
      ) `;
      outwardParams.push(warehouseName, warehouseName);
    }
    outwardSql += ` GROUP BY DATE_FORMAT(outward_entry_date, '%Y-%m-%d') `;
    const [outwardRows] = await db.query(outwardSql, outwardParams);

    // Warehouse supervisor = DO full_name for that warehouse
    let supervisor_name = null;
    let supervisor_email = null;
    const whForSupervisor = warehouseName || String(chamberRows[0]?.warehouse_name || '').trim();
    if (whForSupervisor) {
      const [ops] = await db.query(
        `SELECT full_name, email FROM do_operators
         WHERE LOWER(TRIM(warehouse_name)) = LOWER(TRIM(?))
         ORDER BY id ASC LIMIT 1`,
        [whForSupervisor]
      );
      if (ops.length) {
        supervisor_name = ops[0].full_name || null;
        supervisor_email = ops[0].email || null;
      }
    }

    const byDate = {};
    const ensureDay = (ymd) => {
      if (!byDate[ymd]) {
        byDate[ymd] = {
          date: ymd,
          morning_qty: null,
          evening_qty: null,
          morning_temp: null,
          evening_temp: null,
          inward_boxes: 0,
          outward_boxes: 0,
          total_boxes: null
        };
      }
      return byDate[ymd];
    };

    // Fill every calendar day in range (Excel feel — empty days still listed)
    {
      const cursor = new Date(`${fromDate}T00:00:00`);
      const end = new Date(`${toDate}T00:00:00`);
      while (cursor <= end) {
        ensureDay(toYmd(cursor));
        cursor.setDate(cursor.getDate() + 1);
      }
    }

    (chamberRows || []).forEach((row) => {
      const ymd = row.entry_date;
      if (!ymd) return;
      const day = ensureDay(ymd);
      const shift = normalizeShift(row);
      const qty =
        row.box_count === null || row.box_count === undefined || row.box_count === ''
          ? null
          : Math.max(0, Number(row.box_count) || 0);
      const temp =
        row.box_temp === null || row.box_temp === undefined || row.box_temp === ''
          ? null
          : Number.isFinite(Number(row.box_temp))
            ? Number(row.box_temp)
            : null;
      if (shift === 'Evening') {
        day.evening_qty = qty;
        day.evening_temp = temp;
      } else {
        day.morning_qty = qty;
        day.morning_temp = temp;
      }
    });

    (inwardRows || []).forEach((row) => {
      if (!row.entry_date) return;
      const day = ensureDay(row.entry_date);
      day.inward_boxes = Math.max(0, Number(row.boxes) || 0);
    });
    (outwardRows || []).forEach((row) => {
      if (!row.entry_date) return;
      const day = ensureDay(row.entry_date);
      day.outward_boxes = Math.max(0, Number(row.boxes) || 0);
    });

    // Opening before range = lifetime In − Out only (no daily-task / chamber counts)
    let openingLeft = 0;
    try {
      let openInSql = `
        SELECT COALESCE(SUM(
          GREATEST(0, COALESCE(inward_received_boxes_qty, inward_received_qty, 0))
        ), 0) AS boxes
        FROM inward_temp_logs
        WHERE LOWER(TRIM(inward_client_name)) = LOWER(TRIM(?))
          AND inward_entry_date < ?
      `;
      const openInParams = [clientName, fromDate];
      if (warehouseName) {
        openInSql += ` AND (
          LOWER(TRIM(IFNULL(warehouse_name,''))) = LOWER(TRIM(?))
          OR LOWER(TRIM(IFNULL(warehouse_code,''))) = LOWER(TRIM(?))
        ) `;
        openInParams.push(warehouseName, warehouseName);
      }
      let openOutSql = `
        SELECT COALESCE(SUM(
          GREATEST(0, COALESCE(outward_received_boxes_qty, outward_received_qty, 0))
        ), 0) AS boxes
        FROM outward_temp_logs
        WHERE LOWER(TRIM(outward_client_name)) = LOWER(TRIM(?))
          AND outward_entry_date < ?
      `;
      const openOutParams = [clientName, fromDate];
      if (warehouseName) {
        openOutSql += ` AND (
          LOWER(TRIM(IFNULL(warehouse_name,''))) = LOWER(TRIM(?))
          OR LOWER(TRIM(IFNULL(warehouse_code,''))) = LOWER(TRIM(?))
        ) `;
        openOutParams.push(warehouseName, warehouseName);
      }
      const [[openIn]] = await db.query(openInSql, openInParams);
      const [[openOut]] = await db.query(openOutSql, openOutParams);
      openingLeft = Math.max(
        0,
        (Number(openIn?.boxes) || 0) - (Number(openOut?.boxes) || 0)
      );
    } catch (openErr) {
      console.warn('Client month opening balance skipped:', openErr.message);
    }

    /**
     * In/Out records only (no daily-task morning/evening totals):
     *   Start = previous day Left
     *   Left  = Start + Inward − Outward
     */
    let runningLeft = openingLeft;
    Object.keys(byDate)
      .sort((a, b) => a.localeCompare(b))
      .forEach((ymd) => {
        const day = byDate[ymd];
        const inn = Math.max(0, Number(day.inward_boxes) || 0);
        const out = Math.max(0, Number(day.outward_boxes) || 0);
        const startLeft = runningLeft;
        const endLeft = Math.max(0, startLeft + inn - out);
        day.start_left = startLeft;
        day.left_boxes = endLeft;
        day.total_boxes = endLeft;
        day.has_movement = inn > 0 || out > 0;
        if (day.evening_qty != null) day.audit_qty = day.evening_qty;
        else if (day.morning_qty != null) day.audit_qty = day.morning_qty;
        else day.audit_qty = null;
        runningLeft = endLeft;
      });

    const allDays = Object.keys(byDate)
      .sort((a, b) => a.localeCompare(b))
      .map((k) => byDate[k]);

    // Only In/Out movement days — Start = previous visible Left
    const activityDays = allDays.filter((d) => d.has_movement);
    const days = activityDays.length ? activityDays : allDays;
    for (let i = 0; i < days.length; i += 1) {
      const d = days[i];
      const inn = Math.max(0, Number(d.inward_boxes) || 0);
      const out = Math.max(0, Number(d.outward_boxes) || 0);
      if (i === 0) {
        d.start_left = Math.max(0, Number(d.start_left) || 0);
        d.has_previous = openingLeft > 0 || d.start_left > 0;
      } else {
        d.start_left = Math.max(0, Number(days[i - 1].left_boxes) || 0);
        d.has_previous = true;
      }
      d.left_boxes = Math.max(0, d.start_left + inn - out);
      d.total_boxes = d.left_boxes;
    }

    const resolvedChamber =
      chamberName && chamberName !== '-'
        ? chamberName
        : String(chamberRows[0]?.chamber_name || '').trim() || null;
    const resolvedWarehouse =
      warehouseName || String(chamberRows[0]?.warehouse_name || '').trim() || null;

    const totals = days.reduce(
      (acc, d) => {
        acc.inward += Number(d.inward_boxes) || 0;
        acc.outward += Number(d.outward_boxes) || 0;
        return acc;
      },
      { inward: 0, outward: 0 }
    );
    const lastDay = days.length ? days[days.length - 1] : null;

    return res.status(200).json({
      success: true,
      meta: {
        client_name: clientName,
        warehouse_name: resolvedWarehouse,
        chamber_name: resolvedChamber,
        supervisor_name,
        supervisor_email,
        fromDate,
        toDate,
        day_count: days.length,
        month_inward_total: totals.inward,
        month_outward_total: totals.outward,
        opening_left: openingLeft,
        closing_total: lastDay != null ? lastDay.left_boxes : openingLeft
      },
      days
    });
  } catch (error) {
    return handleControllerError(res, error, {
      checkpoint: 'getClientMonthBoxSheet',
      req,
      clientMessage: 'Failed to load client month box sheet.'
    });
  }
};

/**
 * GET DO TASK OVERVIEW (warehouse-wise)
 * For Sub-Admin / Super Admin mobile home:
 * DO names, today completed / pending, overdue (past 5 days).
 */
exports.getDoTaskOverview = async (req, res) => {
  try {
    const pad = (n) => String(n).padStart(2, '0');
    const toYmd = (d) =>
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

    // Prefer India local "today" (pool timezone is +05:30; Date here is server local).
    // Optional ?date= or ?fromDate=YYYY-MM-DD (+ optional ?toDate=) for Mor/Evn totals.
    // Single day: overdue = prior 5 days. Range: sum Mor/Evn across each day in range.
    const now = new Date();
    const requestedFrom = String(req.query.fromDate || req.query.date || '')
      .trim()
      .slice(0, 10);
    const requestedTo = String(req.query.toDate || '')
      .trim()
      .slice(0, 10);
    const validYmd = (s) =>
      /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(new Date(`${s}T12:00:00`).getTime());
    let fromStr = validYmd(requestedFrom) ? requestedFrom : toYmd(now);
    let toStr = validYmd(requestedTo) ? requestedTo : fromStr;
    if (fromStr > toStr) {
      const tmp = fromStr;
      fromStr = toStr;
      toStr = tmp;
    }
    // Cap range length to keep queries bounded
    const rangeDates = [];
    {
      const cursor = new Date(`${fromStr}T12:00:00`);
      const end = new Date(`${toStr}T12:00:00`);
      let guard = 0;
      while (cursor <= end && guard < 62) {
        rangeDates.push(toYmd(cursor));
        cursor.setDate(cursor.getDate() + 1);
        guard += 1;
      }
    }
    if (!rangeDates.length) rangeDates.push(toYmd(now));
    const calendarToday = toYmd(now);
    // Never project expected tasks past calendar today
    const seriesDates = rangeDates.filter((d) => d <= calendarToday);
    if (!seriesDates.length) seriesDates.push(calendarToday);
    const todayStr = seriesDates[seriesDates.length - 1];
    const useRange = rangeDates.length > 1;
    const baseDate = new Date(`${todayStr}T12:00:00`);
    const expectedShifts = ['Morning', 'Evening'];

    const pastDates = [];
    for (let i = 1; i <= 5; i += 1) {
      const d = new Date(baseDate);
      d.setDate(d.getDate() - i);
      pastDates.push(toYmd(d));
    }

    const [operators] = await db.query(
      `SELECT id, email, full_name, phone_no, warehouse_name, warehouse_code, chamber_limit
       FROM do_operators
       ORDER BY warehouse_name ASC, full_name ASC`
    );

    let assignments = [];
    try {
      const [assignmentRows] = await db.query(`
        SELECT
          a.chamber_id,
          a.client_name,
          NULLIF(TRIM(a.warehouse_name), '') AS assignment_warehouse,
          NULLIF(TRIM(a.warehouse_code), '') AS assignment_warehouse_code,
          NULLIF(TRIM(c.warehouse_name), '') AS chamber_warehouse,
          c.name AS chamber_name
        FROM chamber_client_assignments a
        LEFT JOIN chambers c ON c.id = a.chamber_id
        WHERE (a.status IS NULL OR LOWER(TRIM(a.status)) = 'active')
          AND a.client_name IS NOT NULL
          AND TRIM(a.client_name) <> ''
          AND LOWER(TRIM(a.client_name)) <> 'general'
      `);
      assignments = Array.isArray(assignmentRows) ? assignmentRows : [];
    } catch (assignErr) {
      console.warn('DO task overview assignments query failed:', assignErr.message);
      assignments = [];
    }

    let masterClients = [];
    try {
      const [masterRows] = await db.query(`
        SELECT client_name, warehouse_name, client_code
        FROM client_master
        WHERE (is_active IS NULL OR is_active = 1)
          AND client_name IS NOT NULL
          AND TRIM(client_name) <> ''
        ORDER BY client_name ASC
      `);
      masterClients = Array.isArray(masterRows) ? masterRows : [];
    } catch (masterErr) {
      console.warn('DO task overview client_master skipped:', masterErr.message);
    }

    const dateList = [...new Set([...rangeDates, ...pastDates])];
    const [logs] = await db.query(
      `SELECT
         DATE_FORMAT(entry_date, '%Y-%m-%d') AS entry_date,
         client_name,
         chamber_name,
         chamber_id,
         warehouse_name,
         shift,
         inspection_time,
         operator_email
       FROM daily_chamber_temp_logs
       WHERE entry_date IN (?)`,
      [dateList]
    );

    const normalizeShift = (row) => {
      const s = String(row.shift || '').trim();
      if (/^morning$/i.test(s)) return 'Morning';
      if (/^evening$/i.test(s)) return 'Evening';
      const t = String(row.inspection_time || '').trim().toUpperCase();
      if (t.startsWith('16:') || t.startsWith('18:') || t.includes('04:00 PM') || t.includes('06:00 PM')) {
        return 'Evening';
      }
      return 'Morning';
    };

    const normalizeWh = (v) => {
      const s = String(v || '').trim();
      return s || 'Unassigned';
    };

    const keySet = (...vals) => {
      const out = new Set();
      vals.forEach((v) => {
        const s = String(v || '').trim().toLowerCase();
        if (s) out.add(s);
      });
      return out;
    };

    const setsOverlap = (a, b) => {
      for (const k of a) {
        if (b.has(k)) return true;
      }
      return false;
    };

    const chamberNumber = (name) => {
      const m = String(name || '').match(/^Chamber\s+(\d+)$/i);
      return m ? parseInt(m[1], 10) : null;
    };

    const logKey = (date, chamber, client, shift) =>
      `${date}|${String(chamber || '').trim().toLowerCase()}|${String(client || '').trim().toLowerCase()}|${shift}`;

    const logIdKey = (date, chamberId, client, shift) =>
      `${date}|id:${chamberId}|${String(client || '').trim().toLowerCase()}|${shift}`;

    const dayClientKey = (date, chamber, client) =>
      `${date}|${String(chamber || '').trim().toLowerCase()}|${String(client || '').trim().toLowerCase()}`;

    const rangeLogSet = new Set();
    const pastLogSet = new Set();
    const submittedByEmail = new Map();
    const rangeDateSet = new Set(rangeDates);
    (logs || []).forEach((row) => {
      const date = String(row.entry_date || '').slice(0, 10);
      if (!date) return;
      const chamber = row.chamber_name;
      const client = row.client_name;
      const shift = normalizeShift(row);
      if (rangeDateSet.has(date)) {
        rangeLogSet.add(logKey(date, chamber, client, shift));
        if (row.chamber_id != null) {
          rangeLogSet.add(logIdKey(date, row.chamber_id, client, shift));
        }
        const email = String(row.operator_email || '').trim().toLowerCase();
        if (email) {
          submittedByEmail.set(email, (submittedByEmail.get(email) || 0) + 1);
        }
      } else {
        pastLogSet.add(dayClientKey(date, chamber, client));
        if (row.chamber_id != null) {
          pastLogSet.add(`${date}|id:${row.chamber_id}|${String(client || '').trim().toLowerCase()}`);
        }
      }
    });

    const assignmentIsDone = (a, day, shift) =>
      rangeLogSet.has(logKey(day, a.chamber_name, a.client_name, shift))
      || (a.chamber_id != null && rangeLogSet.has(logIdKey(day, a.chamber_id, a.client_name, shift)));

    const assignmentIsOverdue = (a, date) => {
      const byName = pastLogSet.has(dayClientKey(date, a.chamber_name, a.client_name));
      const byId =
        a.chamber_id != null
        && pastLogSet.has(`${date}|id:${a.chamber_id}|${String(a.client_name || '').trim().toLowerCase()}`);
      return !(byName || byId);
    };

    const dailySeriesMap = new Map(
      seriesDates.map((day) => [
        day,
        {
          date: day,
          morning_completed: 0,
          morning_pending: 0,
          morning_overdue: 0,
          morning_expected: 0,
          evening_completed: 0,
          evening_pending: 0,
          evening_overdue: 0,
          evening_expected: 0,
          completed: 0,
          pending: 0,
          overdue: 0,
          inward: 0,
          outward: 0
        }
      ])
    );
    // Prevent double-counting when one assignment matches multiple warehouse buckets
    const seriesAssignmentSeen = new Set();

    const buckets = new Map();

    const ensureBucket = (warehouse, extra = {}) => {
      const key = normalizeWh(warehouse).toLowerCase();
      if (!buckets.has(key)) {
        buckets.set(key, {
          warehouse_name: normalizeWh(warehouse),
          warehouse_keys: keySet(warehouse, extra.warehouse_code),
          chamber_limit: Number(extra.chamber_limit) || 4,
          seenAssignments: new Set(),
          operators: [],
          clients: [],
          assignment_count: 0,
          completed: 0,
          pending: 0,
          overdue: 0,
          expected_today: 0,
          morning_expected: 0,
          morning_completed: 0,
          morning_pending: 0,
          morning_overdue: 0,
          evening_expected: 0,
          evening_completed: 0,
          evening_pending: 0,
          evening_overdue: 0
        });
      }
      const bucket = buckets.get(key);
      keySet(warehouse, extra.warehouse_code).forEach((k) => bucket.warehouse_keys.add(k));
      const limit = Number(extra.chamber_limit);
      if (Number.isFinite(limit) && limit > bucket.chamber_limit) bucket.chamber_limit = limit;
      return bucket;
    };

    const addAssignmentToBucket = (bucket, a) => {
      const num = chamberNumber(a.chamber_name);
      if (num != null && num > (Number(bucket.chamber_limit) || 4)) return;
      const client = String(a.client_name || '').trim();
      if (!client) return;
      const dedupeKey = `${num ?? a.chamber_id ?? ''}|${client.toLowerCase()}`;
      if (bucket.seenAssignments.has(dedupeKey)) return;
      bucket.seenAssignments.add(dedupeKey);
      bucket.assignment_count += 1;
      bucket.clients.push({
        client_name: client,
        chamber_name: a.chamber_name || null,
        chamber_id: a.chamber_id != null ? a.chamber_id : null
      });

      // Chart series: count each chamber+client once globally (not per matched warehouse)
      const seriesKey = `${a.chamber_id != null ? `id:${a.chamber_id}` : `n:${num ?? ''}`}|${client.toLowerCase()}`;
      const countForSeries = !seriesAssignmentSeen.has(seriesKey);
      if (countForSeries) seriesAssignmentSeen.add(seriesKey);

      expectedShifts.forEach((shift) => {
        rangeDates.forEach((day) => {
          // Skip future calendar days for expected/pending (bucket totals still use full requested range)
          if (day > calendarToday) return;

          bucket.expected_today += 1;
          const prefix = shift === 'Evening' ? 'evening' : 'morning';
          bucket[`${prefix}_expected`] += 1;
          const series = countForSeries ? dailySeriesMap.get(day) : null;
          if (series) series[`${prefix}_expected`] += 1;

          if (assignmentIsDone(a, day, shift)) {
            bucket.completed += 1;
            bucket[`${prefix}_completed`] += 1;
            if (series) {
              series.completed += 1;
              series[`${prefix}_completed`] += 1;
            }
          } else if (day < calendarToday) {
            // Past day incomplete = overdue (not pending)
            bucket.overdue += 1;
            bucket[`${prefix}_overdue`] += 1;
            if (series) {
              series.overdue += 1;
              series[`${prefix}_overdue`] += 1;
            }
          } else {
            // Calendar today incomplete = pending
            bucket.pending += 1;
            bucket[`${prefix}_pending`] += 1;
            if (series) {
              series.pending += 1;
              series[`${prefix}_pending`] += 1;
            }
          }
        });
      });

      // Single-day view: also count prior 5 days with no chamber log at all
      if (!useRange) {
        pastDates.forEach((date) => {
          if (assignmentIsOverdue(a, date)) {
            bucket.overdue += 1;
          }
        });
      }
    };

    (operators || []).forEach((op) => {
      const bucket = ensureBucket(op.warehouse_name || op.warehouse_code, {
        warehouse_code: op.warehouse_code,
        chamber_limit: op.chamber_limit
      });
      bucket.operators.push({
        id: op.id,
        name: op.full_name || op.email?.split('@')[0] || 'DO',
        email: op.email,
        phone_no: op.phone_no || null,
        warehouse_name: op.warehouse_name || null,
        warehouse_code: op.warehouse_code || null,
        chamber_limit: op.chamber_limit
      });
    });

    (assignments || []).forEach((a) => {
      const aKeys = keySet(
        a.assignment_warehouse,
        a.assignment_warehouse_code,
        a.chamber_warehouse
      );
      let matched = false;
      // First matching warehouse only — avoids double-counting pending/overdue/IO scope
      for (const bucket of buckets.values()) {
        if (aKeys.size === 0) break;
        if (setsOverlap(aKeys, bucket.warehouse_keys)) {
          addAssignmentToBucket(bucket, a);
          matched = true;
          break;
        }
      }
      if (!matched) {
        const fallback = a.assignment_warehouse || a.chamber_warehouse || a.assignment_warehouse_code || 'Unassigned';
        addAssignmentToBucket(
          ensureBucket(fallback, { warehouse_code: a.assignment_warehouse_code }),
          a
        );
      }
    });

    const warehouses = Array.from(buckets.values())
      .map((w) => {
        const { seenAssignments, warehouse_keys, chamber_limit, ...rest } = w;
        return {
          ...rest,
          do_names: w.operators.map((o) => o.name).join(', ') || 'No DO assigned',
          status:
            w.pending === 0 && w.overdue === 0
              ? 'On track'
              : w.overdue > 0
                ? 'Needs attention'
                : 'In progress'
        };
      })
      .sort((a, b) => a.warehouse_name.localeCompare(b.warehouse_name));

    const flatOperators = [];
    const flatClients = [];
    const seenClient = new Set();
    const pushClient = (entry) => {
      const name = String(entry.client_name || '').trim();
      if (!name || name.toLowerCase() === 'general') return;
      const warehouse = normalizeWh(entry.warehouse_name);
      const chamber = entry.chamber_name ? String(entry.chamber_name).trim() : '';
      const key = `${warehouse.toLowerCase()}|${name.toLowerCase()}|${chamber.toLowerCase()}`;
      if (seenClient.has(key)) return;
      seenClient.add(key);
      flatClients.push({
        client_name: name,
        warehouse_name: warehouse,
        chamber_name: chamber || null,
        chamber_id: entry.chamber_id != null ? entry.chamber_id : null,
        client_code: entry.client_code || null,
        source: entry.source || 'assignment'
      });
    };

    warehouses.forEach((w) => {
      (w.operators || []).forEach((op) => {
        const emailKey = String(op.email || '').trim().toLowerCase();
        flatOperators.push({
          ...op,
          warehouse_name: w.warehouse_name,
          completed: w.completed,
          pending: w.pending,
          overdue: w.overdue,
          expected_today: w.expected_today,
          morning_expected: w.morning_expected,
          morning_completed: w.morning_completed,
          morning_pending: w.morning_pending,
          morning_overdue: w.morning_overdue,
          evening_expected: w.evening_expected,
          evening_completed: w.evening_completed,
          evening_pending: w.evening_pending,
          evening_overdue: w.evening_overdue,
          assignment_count: w.assignment_count,
          submitted_today: submittedByEmail.get(emailKey) || 0,
          status: w.status,
          total_inward: 0,
          total_outward: 0,
          today_inward: 0,
          today_outward: 0
        });
      });
      (w.clients || []).forEach((c) => {
        pushClient({
          client_name: c.client_name,
          warehouse_name: w.warehouse_name,
          chamber_name: c.chamber_name,
          chamber_id: c.chamber_id,
          source: 'assignment'
        });
      });
    });

    masterClients.forEach((row) => {
      pushClient({
        client_name: row.client_name,
        warehouse_name: row.warehouse_name,
        client_code: row.client_code,
        source: 'master'
      });
    });

    flatClients.sort(
      (a, b) =>
        String(a.client_name).localeCompare(String(b.client_name)) ||
        String(a.warehouse_name).localeCompare(String(b.warehouse_name))
    );
    flatOperators.sort(
      (a, b) =>
        String(a.warehouse_name).localeCompare(String(b.warehouse_name)) ||
        String(a.name).localeCompare(String(b.name))
    );

    const uniqueClientNames = new Set(
      flatClients.map((c) => String(c.client_name || '').trim().toLowerCase()).filter(Boolean)
    );

    let portalCustomerCount = 0;
    try {
      const [custCountRows] = await db.query('SELECT COUNT(*) AS total FROM customers');
      portalCustomerCount = Number(custCountRows?.[0]?.total) || 0;
    } catch (custCountErr) {
      console.warn('DO task overview customers count skipped:', custCountErr.message);
    }

    const ioByEmail = new Map();
    let totalInward = 0;
    let totalOutward = 0;
    let todayInward = 0;
    let todayOutward = 0;
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
      const [inDayRows] = await db.query(
        `SELECT LOWER(TRIM(IFNULL(operator_email,''))) AS email, COUNT(*) AS c
         FROM inward_temp_logs
         WHERE DATE(inward_entry_date) >= ?
           AND DATE(inward_entry_date) <= ?
           AND TRIM(IFNULL(operator_email,'')) <> ''
         GROUP BY LOWER(TRIM(IFNULL(operator_email,'')))`,
        [fromStr, toStr]
      );
      const [outDayRows] = await db.query(
        `SELECT LOWER(TRIM(IFNULL(operator_email,''))) AS email, COUNT(*) AS c
         FROM outward_temp_logs
         WHERE DATE(outward_entry_date) >= ?
           AND DATE(outward_entry_date) <= ?
           AND TRIM(IFNULL(operator_email,'')) <> ''
         GROUP BY LOWER(TRIM(IFNULL(operator_email,'')))`,
        [fromStr, toStr]
      );

      // All-time totals (include blank email rows in summary only)
      const [[inAll]] = await db.query('SELECT COUNT(*) AS c FROM inward_temp_logs');
      const [[outAll]] = await db.query('SELECT COUNT(*) AS c FROM outward_temp_logs');
      const [[inDayAll]] = await db.query(
        'SELECT COUNT(*) AS c FROM inward_temp_logs WHERE DATE(inward_entry_date) >= ? AND DATE(inward_entry_date) <= ?',
        [fromStr, toStr]
      );
      const [[outDayAll]] = await db.query(
        'SELECT COUNT(*) AS c FROM outward_temp_logs WHERE DATE(outward_entry_date) >= ? AND DATE(outward_entry_date) <= ?',
        [fromStr, toStr]
      );
      const [inByDayRows] = await db.query(
        `SELECT DATE_FORMAT(inward_entry_date, '%Y-%m-%d') AS d, COUNT(*) AS c
         FROM inward_temp_logs
         WHERE DATE(inward_entry_date) >= ? AND DATE(inward_entry_date) <= ?
         GROUP BY DATE_FORMAT(inward_entry_date, '%Y-%m-%d')`,
        [fromStr, toStr]
      );
      const [outByDayRows] = await db.query(
        `SELECT DATE_FORMAT(outward_entry_date, '%Y-%m-%d') AS d, COUNT(*) AS c
         FROM outward_temp_logs
         WHERE DATE(outward_entry_date) >= ? AND DATE(outward_entry_date) <= ?
         GROUP BY DATE_FORMAT(outward_entry_date, '%Y-%m-%d')`,
        [fromStr, toStr]
      );
      const dayKey = (raw) => {
        if (raw == null) return '';
        const s = String(raw);
        const m = s.match(/(\d{4}-\d{2}-\d{2})/);
        return m ? m[1] : s.slice(0, 10);
      };
      (inByDayRows || []).forEach((row) => {
        const series = dailySeriesMap.get(dayKey(row.d));
        if (series) series.inward = Number(row.c) || 0;
      });
      (outByDayRows || []).forEach((row) => {
        const series = dailySeriesMap.get(dayKey(row.d));
        if (series) series.outward = Number(row.c) || 0;
      });
      totalInward = Number(inAll?.c) || 0;
      totalOutward = Number(outAll?.c) || 0;
      todayInward = Number(inDayAll?.c) || 0;
      todayOutward = Number(outDayAll?.c) || 0;

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
      (inDayRows || []).forEach((r) => bump(r.email, 'today_inward', r.c));
      (outDayRows || []).forEach((r) => bump(r.email, 'today_outward', r.c));
    } catch (ioCountErr) {
      console.warn('DO task overview inward/outward counts skipped:', ioCountErr.message);
    }

    flatOperators.forEach((op) => {
      const emailKey = String(op.email || '').trim().toLowerCase();
      const io = ioByEmail.get(emailKey) || {
        total_inward: 0,
        total_outward: 0,
        today_inward: 0,
        today_outward: 0
      };
      op.total_inward = Number(io.total_inward) || 0;
      op.total_outward = Number(io.total_outward) || 0;
      op.today_inward = Number(io.today_inward) || 0;
      op.today_outward = Number(io.today_outward) || 0;
    });

    const summary = warehouses.reduce(
      (acc, w) => {
        acc.warehouses += 1;
        acc.operators += w.operators.length;
        acc.completed += w.completed;
        acc.pending += w.pending;
        acc.overdue += w.overdue;
        acc.morning_completed += Number(w.morning_completed) || 0;
        acc.morning_pending += Number(w.morning_pending) || 0;
        acc.morning_overdue += Number(w.morning_overdue) || 0;
        acc.morning_expected += Number(w.morning_expected) || 0;
        acc.evening_completed += Number(w.evening_completed) || 0;
        acc.evening_pending += Number(w.evening_pending) || 0;
        acc.evening_overdue += Number(w.evening_overdue) || 0;
        acc.evening_expected += Number(w.evening_expected) || 0;
        return acc;
      },
      {
        warehouses: 0,
        operators: 0,
        clients: uniqueClientNames.size || flatClients.length,
        customers: portalCustomerCount,
        completed: 0,
        pending: 0,
        overdue: 0,
        morning_completed: 0,
        morning_pending: 0,
        morning_overdue: 0,
        morning_expected: 0,
        evening_completed: 0,
        evening_pending: 0,
        evening_overdue: 0,
        evening_expected: 0,
        total_inward: totalInward,
        total_outward: totalOutward,
        today_inward: todayInward,
        today_outward: todayOutward,
        range_inward: todayInward,
        range_outward: todayOutward
      }
    );

    // Align summary pending/overdue with unique daily_series (no warehouse double-count)
    const seriesTotals = (dailySeriesMap
      ? Array.from(dailySeriesMap.values())
      : []
    ).reduce(
      (acc, d) => {
        acc.completed += Number(d.completed) || 0;
        acc.pending += Number(d.pending) || 0;
        acc.overdue += Number(d.overdue) || 0;
        acc.morning_completed += Number(d.morning_completed) || 0;
        acc.morning_pending += Number(d.morning_pending) || 0;
        acc.morning_overdue += Number(d.morning_overdue) || 0;
        acc.evening_completed += Number(d.evening_completed) || 0;
        acc.evening_pending += Number(d.evening_pending) || 0;
        acc.evening_overdue += Number(d.evening_overdue) || 0;
        acc.inward += Number(d.inward) || 0;
        acc.outward += Number(d.outward) || 0;
        return acc;
      },
      {
        completed: 0,
        pending: 0,
        overdue: 0,
        morning_completed: 0,
        morning_pending: 0,
        morning_overdue: 0,
        evening_completed: 0,
        evening_pending: 0,
        evening_overdue: 0,
        inward: 0,
        outward: 0
      }
    );
    if (useRange) {
      summary.completed = seriesTotals.completed;
      summary.pending = seriesTotals.pending;
      summary.overdue = seriesTotals.overdue;
      summary.morning_completed = seriesTotals.morning_completed;
      summary.morning_pending = seriesTotals.morning_pending;
      summary.morning_overdue = seriesTotals.morning_overdue;
      summary.evening_completed = seriesTotals.evening_completed;
      summary.evening_pending = seriesTotals.evening_pending;
      summary.evening_overdue = seriesTotals.evening_overdue;
    }
    // Prefer series day-sum for range IO when available
    if (seriesTotals.inward > 0 || seriesTotals.outward > 0) {
      summary.today_inward = seriesTotals.inward;
      summary.today_outward = seriesTotals.outward;
      summary.range_inward = seriesTotals.inward;
      summary.range_outward = seriesTotals.outward;
    }

    const daily_series = seriesDates.map((day) => dailySeriesMap.get(day)).filter(Boolean);

    return res.status(200).json({
      success: true,
      today: fromStr,
      fromDate: fromStr,
      toDate: toStr,
      range_days: rangeDates.length,
      expected_shifts: expectedShifts,
      summary,
      daily_series,
      warehouses,
      operators: flatOperators,
      clients: flatClients
    });
  } catch (error) {
    return handleControllerError(res, error, {
      checkpoint: 'getDoTaskOverview',
      req,
      clientMessage: 'Server error while building DO task overview.'
    });
  }
};

/**
 * GET /api/dashboard/customers
 * Portal customer accounts (customers table) — not chamber client names.
 */
exports.getPortalCustomers = async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT id, email, full_name, phone_no, allowed_clients, allowed_warehouses, created_at
       FROM customers
       ORDER BY full_name ASC, email ASC`
    );
    const customers = (rows || []).map((row) => ({
      id: row.id,
      email: row.email || null,
      full_name: row.full_name || null,
      phone_no: row.phone_no || null,
      allowed_clients: row.allowed_clients || null,
      allowed_warehouses: row.allowed_warehouses || null,
      created_at: row.created_at || null
    }));
    return res.status(200).json({
      success: true,
      total: customers.length,
      customers
    });
  } catch (error) {
    return handleControllerError(res, error, {
      checkpoint: 'getPortalCustomers',
      req,
      clientMessage: 'Server error while loading customers.'
    });
  }
};

/**
 * GET /api/dashboard/do-operators
 * Data Operator accounts for Sub-Admin / Admin home lists.
 */
exports.getDoOperatorsList = async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT id, email, full_name, phone_no, warehouse_name, warehouse_code, chamber_limit, created_at
       FROM do_operators
       ORDER BY warehouse_name ASC, full_name ASC, email ASC`
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
      console.warn('DO operators list IO counts skipped:', ioErr.message);
    }

    const operators = (rows || []).map((row) => {
      const emailKey = String(row.email || '').trim().toLowerCase();
      const io = ioByEmail.get(emailKey) || {
        total_inward: 0,
        total_outward: 0,
        today_inward: 0,
        today_outward: 0
      };
      return {
        id: row.id,
        email: row.email || null,
        name: row.full_name || (row.email ? String(row.email).split('@')[0] : 'DO'),
        full_name: row.full_name || null,
        phone_no: row.phone_no || null,
        warehouse_name: row.warehouse_name || 'Unassigned',
        warehouse_code: row.warehouse_code || null,
        chamber_limit: row.chamber_limit != null ? Number(row.chamber_limit) : null,
        created_at: row.created_at || null,
        total_inward: io.total_inward,
        total_outward: io.total_outward,
        today_inward: io.today_inward,
        today_outward: io.today_outward
      };
    });
    return res.status(200).json({
      success: true,
      total: operators.length,
      today: todayStr,
      operators
    });
  } catch (error) {
    return handleControllerError(res, error, {
      checkpoint: 'getDoOperatorsList',
      req,
      clientMessage: 'Server error while loading DO operators.'
    });
  }
};

/**
 * GET /api/dashboard/do-operator-io-counts?email=
 * Inward/outward totals + today for one Data Operator.
 */
exports.getDoOperatorIoCounts = async (req, res) => {
  try {
    const email = String(req.query.email || '').trim().toLowerCase();
    if (!email) {
      return res.status(400).json({ success: false, error: 'email is required.' });
    }
    const pad = (n) => String(n).padStart(2, '0');
    const now = new Date();
    const todayStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;

    const [[inTotal]] = await db.query(
      `SELECT COUNT(*) AS c FROM inward_temp_logs
       WHERE LOWER(TRIM(IFNULL(operator_email,''))) = ?`,
      [email]
    );
    const [[outTotal]] = await db.query(
      `SELECT COUNT(*) AS c FROM outward_temp_logs
       WHERE LOWER(TRIM(IFNULL(operator_email,''))) = ?`,
      [email]
    );
    const [[inToday]] = await db.query(
      `SELECT COUNT(*) AS c FROM inward_temp_logs
       WHERE LOWER(TRIM(IFNULL(operator_email,''))) = ?
         AND inward_entry_date = ?`,
      [email, todayStr]
    );
    const [[outToday]] = await db.query(
      `SELECT COUNT(*) AS c FROM outward_temp_logs
       WHERE LOWER(TRIM(IFNULL(operator_email,''))) = ?
         AND outward_entry_date = ?`,
      [email, todayStr]
    );

    return res.status(200).json({
      success: true,
      email,
      today: todayStr,
      total_inward: Number(inTotal?.c) || 0,
      total_outward: Number(outTotal?.c) || 0,
      today_inward: Number(inToday?.c) || 0,
      today_outward: Number(outToday?.c) || 0
    });
  } catch (error) {
    return handleControllerError(res, error, {
      checkpoint: 'getDoOperatorIoCounts',
      req,
      clientMessage: 'Server error while loading DO inward/outward counts.'
    });
  }
};
