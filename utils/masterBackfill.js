/**
 * Checkpoint 2: backfill warehouse_master + client_master from existing name-based data.
 * Non-destructive — only INSERT missing rows; never updates/deletes existing masters.
 */

function slugPart(name, maxLen = 8) {
  const s = String(name || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '')
    .slice(0, maxLen);
  return s || 'UNK';
}

function pairKey(warehouseName, clientName) {
  const wh = String(warehouseName || '').trim().toLowerCase();
  const cl = String(clientName || '').trim().toLowerCase();
  return `${wh}|${cl}`;
}

async function safeQueryDistinct(pool, sql) {
  try {
    const [rows] = await pool.query(sql);
    return rows || [];
  } catch {
    return [];
  }
}

async function collectDistinctWarehouseNames(pool) {
  const queries = [
    `SELECT DISTINCT TRIM(warehouse_name) AS name FROM do_operators
     WHERE warehouse_name IS NOT NULL AND TRIM(warehouse_name) <> ''`,
    `SELECT DISTINCT TRIM(warehouse_name) AS name FROM chamber_client_assignments
     WHERE warehouse_name IS NOT NULL AND TRIM(warehouse_name) <> ''`,
    `SELECT DISTINCT TRIM(warehouse_name) AS name FROM daily_chamber_temp_logs
     WHERE warehouse_name IS NOT NULL AND TRIM(warehouse_name) <> ''`,
    `SELECT DISTINCT TRIM(warehouse_name) AS name FROM inward_temp_logs
     WHERE warehouse_name IS NOT NULL AND TRIM(warehouse_name) <> ''`,
    `SELECT DISTINCT TRIM(warehouse_name) AS name FROM outward_temp_logs
     WHERE warehouse_name IS NOT NULL AND TRIM(warehouse_name) <> ''`,
    `SELECT DISTINCT TRIM(warehouse_name) AS name FROM daily_temp_logs
     WHERE warehouse_name IS NOT NULL AND TRIM(warehouse_name) <> ''`,
  ];

  const byLower = new Map();
  for (const sql of queries) {
    for (const row of await safeQueryDistinct(pool, sql)) {
      const name = String(row.name || '').trim();
      if (!name) continue;
      const key = name.toLowerCase();
      if (!byLower.has(key)) byLower.set(key, name);
    }
  }
  return [...byLower.values()].sort((a, b) => a.localeCompare(b));
}

async function collectDistinctClientPairs(pool) {
  const queries = [
    `SELECT DISTINCT TRIM(warehouse_name) AS warehouse_name, TRIM(client_name) AS client_name
     FROM chamber_client_assignments
     WHERE client_name IS NOT NULL AND TRIM(client_name) <> ''`,
    `SELECT DISTINCT TRIM(warehouse_name) AS warehouse_name, TRIM(client_name) AS client_name
     FROM daily_chamber_temp_logs
     WHERE client_name IS NOT NULL AND TRIM(client_name) <> ''`,
    `SELECT DISTINCT TRIM(warehouse_name) AS warehouse_name, TRIM(inward_client_name) AS client_name
     FROM inward_temp_logs
     WHERE inward_client_name IS NOT NULL AND TRIM(inward_client_name) <> ''`,
    `SELECT DISTINCT TRIM(warehouse_name) AS warehouse_name, TRIM(outward_client_name) AS client_name
     FROM outward_temp_logs
     WHERE outward_client_name IS NOT NULL AND TRIM(outward_client_name) <> ''`,
    `SELECT DISTINCT TRIM(warehouse_name) AS warehouse_name, TRIM(client_name) AS client_name
     FROM daily_temp_logs
     WHERE client_name IS NOT NULL AND TRIM(client_name) <> ''`,
  ];

  const byPair = new Map();
  for (const sql of queries) {
    for (const row of await safeQueryDistinct(pool, sql)) {
      const clientName = String(row.client_name || '').trim();
      if (!clientName) continue;
      const warehouseName = String(row.warehouse_name || '').trim() || null;
      const key = pairKey(warehouseName, clientName);
      if (!byPair.has(key)) {
        byPair.set(key, { warehouse_name: warehouseName, client_name: clientName });
      }
    }
  }
  return [...byPair.values()].sort((a, b) => {
    const wh = String(a.warehouse_name || '').localeCompare(String(b.warehouse_name || ''));
    if (wh !== 0) return wh;
    return String(a.client_name).localeCompare(String(b.client_name));
  });
}

function nextWarehouseCode(name, slugCounts, usedCodes) {
  const slug = slugPart(name, 8);
  let n = (slugCounts.get(slug) || 0) + 1;
  slugCounts.set(slug, n);
  let code = `WH-${slug}-${String(n).padStart(2, '0')}`;
  while (usedCodes.has(code)) {
    n += 1;
    slugCounts.set(slug, n);
    code = `WH-${slug}-${String(n).padStart(2, '0')}`;
  }
  usedCodes.add(code);
  return code;
}

function nextClientCode(clientName, slugCounts, usedCodes) {
  const slug = slugPart(clientName, 10);
  let n = (slugCounts.get(slug) || 0) + 1;
  slugCounts.set(slug, n);
  let code = `CL-${slug}-${String(n).padStart(3, '0')}`;
  while (usedCodes.has(code)) {
    n += 1;
    slugCounts.set(slug, n);
    code = `CL-${slug}-${String(n).padStart(3, '0')}`;
  }
  usedCodes.add(code);
  return code;
}

/** Inserts warehouse_master rows for every distinct warehouse_name seen in live logs. */
async function backfillWarehouses(pool) {
  const names = await collectDistinctWarehouseNames(pool);
  let existing = [];
  try {
    const [rows] = await pool.query('SELECT warehouse_code, warehouse_name FROM warehouse_master');
    existing = rows || [];
  } catch {
    return { inserted: 0, skipped: names.length };
  }

  const byNameLower = new Map(
    existing.map((r) => [String(r.warehouse_name || '').trim().toLowerCase(), r])
  );
  const usedCodes = new Set(existing.map((r) => r.warehouse_code));
  const slugCounts = new Map();
  let inserted = 0;

  for (const name of names) {
    if (byNameLower.has(name.toLowerCase())) continue;
    const code = nextWarehouseCode(name, slugCounts, usedCodes);
    await pool.query(
      'INSERT INTO warehouse_master (warehouse_code, warehouse_name, is_active) VALUES (?, ?, 1)',
      [code, name]
    );
    byNameLower.set(name.toLowerCase(), { warehouse_code: code, warehouse_name: name });
    inserted += 1;
  }

  return { inserted, total: names.length };
}

/** Inserts client_master rows for each warehouse + client pair found in assignments and logs. */
async function backfillClients(pool) {
  const pairs = await collectDistinctClientPairs(pool);
  let existing = [];
  try {
    const [rows] = await pool.query(
      'SELECT client_code, client_name, warehouse_name FROM client_master'
    );
    existing = rows || [];
  } catch {
    return { inserted: 0, skipped: pairs.length };
  }

  const byPair = new Map(
    existing.map((r) => [
      pairKey(r.warehouse_name, r.client_name),
      r,
    ])
  );
  const usedCodes = new Set(existing.map((r) => r.client_code));
  const slugCounts = new Map();
  let inserted = 0;

  for (const pair of pairs) {
    const key = pairKey(pair.warehouse_name, pair.client_name);
    if (byPair.has(key)) continue;
    const code = nextClientCode(pair.client_name, slugCounts, usedCodes);
    await pool.query(
      'INSERT INTO client_master (client_code, client_name, warehouse_name, is_active) VALUES (?, ?, ?, 1)',
      [code, pair.client_name, pair.warehouse_name]
    );
    byPair.set(key, { client_code: code, ...pair });
    inserted += 1;
  }

  return { inserted, total: pairs.length };
}

/**
 * Run master backfill once all core tables exist.
 * Safe to call on every startup — only inserts missing rows.
 */
async function backfillMasterData(pool) {
  const wh = await backfillWarehouses(pool);
  const cl = await backfillClients(pool);
  if (wh.inserted > 0 || cl.inserted > 0) {
    console.log(
      `🌱 Master backfill: warehouses +${wh.inserted}/${wh.total}, clients +${cl.inserted}/${cl.total}`
    );
  }
  return { warehouses: wh, clients: cl };
}

module.exports = {
  backfillMasterData,
  slugPart,
};
