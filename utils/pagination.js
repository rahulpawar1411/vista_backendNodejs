// ====================================================================
// Pagination + SQL scope helpers (utils/pagination.js)
// Keeps list APIs fast and filters rows by customer / DO / warehouse rules.
// ====================================================================

/**
 * Reads page and limit from query string; caps size so exports cannot overload the DB.
 */
function parsePagination(query, options = {}) {
  const defaultLimit = options.defaultLimit ?? 50;
  const maxLimit = options.maxLimit ?? 200;
  const exportMax = options.exportMax ?? 2000;
  const isExport = query.export === '1' || query.export === 'true';
  const cap = isExport ? exportMax : maxLimit;
  const page = Math.max(1, parseInt(String(query.page || '1'), 10) || 1);
  let limit = parseInt(String(query.limit || String(defaultLimit)), 10) || defaultLimit;
  limit = Math.min(Math.max(1, limit), cap);
  const offset = (page - 1) * limit;

  return { page, limit, offset, isExport };
}

/** Wraps list results with total count and hasMore for infinite-scroll UIs. */
function sendPaginated(res, items, total, page, limit) {
  const totalNum = Number(total) || 0;
  return res.json({
    items: items || [],
    total: totalNum,
    page,
    limit,
    hasMore: page * limit < totalNum
  });
}

/** Splits comma-separated filter tokens from query params or JWT allowed_clients fields. */
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

/**
 * Customer access scope from assigned client / warehouse codes or names.
 * CSV may contain codes (CL-… / WH-…) or legacy names — match either column.
 * Empty warehouse on a log is still allowed when warehouses are assigned.
 */
function appendSubAdminAccessScope(conditions, params, user, options = {}) {
  const role = user?.role === 'sub_admin' ? 'customer' : user?.role;
  if (!user || role !== 'customer') return;

  const clientColumn = options.clientColumn || 'client_name';
  const clientCodeColumn = options.clientCodeColumn || 'client_code';
  const warehouseColumn = options.warehouseColumn || 'warehouse_name';
  const warehouseCodeColumn = options.warehouseCodeColumn || 'warehouse_code';

  const clients = parseCsvNames(user.allowed_clients).map((c) => c.toLowerCase());
  const warehouses = parseCsvNames(user.allowed_warehouses).map((w) => w.toLowerCase());

  if (clients.length > 0) {
    const placeholders = clients.map(() => '?').join(', ');
    conditions.push(
      `(LOWER(TRIM(COALESCE(${clientCodeColumn}, ''))) IN (${placeholders}) OR LOWER(TRIM(COALESCE(${clientColumn}, ''))) IN (${placeholders}))`
    );
    params.push(...clients, ...clients);
  }

  if (warehouses.length > 0) {
    const placeholders = warehouses.map(() => '?').join(', ');
    conditions.push(
      `(${warehouseColumn} IS NULL OR TRIM(COALESCE(${warehouseColumn}, '')) = '' OR LOWER(TRIM(COALESCE(${warehouseCodeColumn}, ''))) IN (${placeholders}) OR LOWER(TRIM(${warehouseColumn})) IN (${placeholders}))`
    );
    params.push(...warehouses, ...warehouses);
  }
}

/** DO operator: own warehouse by code or name; blank warehouse on old logs still visible. */
function appendDoWarehouseScope(conditions, params, user, options = {}) {
  if (!user || user.role !== 'do_operator') return;
  const name = String(user.warehouse_name || '').trim();
  const code = String(user.warehouse_code || '').trim();
  if (!name && !code) return;
  const nameColumn = options.warehouseColumn || 'warehouse_name';
  const codeColumn = options.warehouseCodeColumn || 'warehouse_code';
  const parts = [`${nameColumn} IS NULL OR TRIM(COALESCE(${nameColumn}, '')) = ''`];
  if (code) {
    parts.push(`LOWER(TRIM(COALESCE(${codeColumn}, ''))) = ?`);
    params.push(code.toLowerCase());
  }
  if (name) {
    parts.push(`LOWER(TRIM(COALESCE(${nameColumn}, ''))) = ?`);
    params.push(name.toLowerCase());
  }
  conditions.push(`(${parts.join(' OR ')})`);
}

/** Optional warehouse filter for Super Admin / Customer list views (code or name). */
function appendWarehouseFilter(conditions, params, query, user, options = {}) {
  const warehouse = query.warehouse;
  if (!warehouse || warehouse === 'All') return;
  const role = user?.role === 'sub_admin' ? 'customer' : user?.role;
  if (!user || (role !== 'super_admin' && role !== 'customer')) return;
  const nameColumn = options.warehouseColumn || 'warehouse_name';
  const codeColumn = options.warehouseCodeColumn || 'warehouse_code';
  if (warehouse === 'Generic') {
    conditions.push(`(${nameColumn} IS NULL OR TRIM(COALESCE(${nameColumn}, '')) = '' OR LOWER(TRIM(${nameColumn})) = ?)`);
    params.push('generic');
  } else {
    const val = String(warehouse).trim().toLowerCase();
    conditions.push(
      `(LOWER(TRIM(COALESCE(${codeColumn}, ''))) = ? OR LOWER(TRIM(COALESCE(${nameColumn}, ''))) = ?)`
    );
    params.push(val, val);
  }
}

/** Optional client filter (SA / Customer / DO) — code or name. */
function appendClientFilter(conditions, params, query, user, options = {}) {
  const client = query.client;
  if (!client || client === 'All') return;
  const role = user?.role === 'sub_admin' ? 'customer' : user?.role;
  if (!user || (role !== 'super_admin' && role !== 'customer' && role !== 'do_operator')) return;
  const nameColumn = options.clientColumn || 'client_name';
  const codeColumn = options.clientCodeColumn || 'client_code';
  const val = String(client).trim().toLowerCase();
  conditions.push(
    `(LOWER(TRIM(COALESCE(${codeColumn}, ''))) = ? OR LOWER(TRIM(COALESCE(${nameColumn}, ''))) = ?)`
  );
  params.push(val, val);
}

/** Optional chamber filter so same client on two chambers does not mix. */
function appendChamberFilter(conditions, params, query) {
  const chamberId = query.chamber_id;
  if (chamberId != null && String(chamberId).trim() !== '' && String(chamberId).toLowerCase() !== 'all') {
    const id = parseInt(chamberId, 10);
    if (Number.isFinite(id)) {
      conditions.push('chamber_id = ?');
      params.push(id);
      return;
    }
  }
  const chamber = query.chamber || query.chamber_name;
  if (!chamber || chamber === 'All') return;
  conditions.push('LOWER(TRIM(COALESCE(chamber_name, \'\'))) = ?');
  params.push(String(chamber).trim().toLowerCase());
}

module.exports = {
  parsePagination,
  sendPaginated,
  parseCsvNames,
  appendSubAdminAccessScope,
  appendDoWarehouseScope,
  appendWarehouseFilter,
  appendClientFilter,
  appendChamberFilter
};
