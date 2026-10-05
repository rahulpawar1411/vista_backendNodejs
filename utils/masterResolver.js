/**
 * Master code/name resolver for log writes (inward / outward / chamber temp).
 *
 * Lookup order: explicit code → name (+ warehouse when needed).
 * Returns stable warehouse_code / client_code so reports and inventory stay consistent
 * even when the UI only sends human-readable names.
 */
const db = require('../config/db');

/** Resolve warehouse_master row by WH-code or exact name. */
async function resolveWarehouseByCodeOrName({ warehouse_code, warehouse_name }) {
  const code = String(warehouse_code || '').trim();
  const name = String(warehouse_name || '').trim();
  if (code) {
    const [rows] = await db.query(
      'SELECT warehouse_code, warehouse_name FROM warehouse_master WHERE warehouse_code = ? LIMIT 1',
      [code]
    );
    if (rows.length) return rows[0];
  }
  if (name) {
    const [rows] = await db.query(
      'SELECT warehouse_code, warehouse_name FROM warehouse_master WHERE LOWER(TRIM(warehouse_name)) = LOWER(TRIM(?)) LIMIT 1',
      [name]
    );
    if (rows.length) return rows[0];
  }
  return null;
}

/** Looks up client_master by CL-code or by client name plus warehouse (when names repeat). */
async function resolveClientByCodeOrName({ client_code, client_name, warehouse_name }) {
  const code = String(client_code || '').trim();
  const name = String(client_name || '').trim();
  const wh = String(warehouse_name || '').trim();
  if (code) {
    const [rows] = await db.query(
      'SELECT client_code, client_name, warehouse_name FROM client_master WHERE client_code = ? LIMIT 1',
      [code]
    );
    if (rows.length) return rows[0];
  }
  if (name) {
    const [rows] = await db.query(
      `SELECT client_code, client_name, warehouse_name
       FROM client_master
       WHERE LOWER(TRIM(client_name)) = LOWER(TRIM(?))
         AND LOWER(TRIM(COALESCE(warehouse_name, ''))) = LOWER(TRIM(COALESCE(?, '')))
       LIMIT 1`,
      [name, wh]
    );
    if (rows.length) return rows[0];
  }
  return null;
}

/** Resolve warehouse code + canonical name from code and/or name input. */
async function resolveWarehouseFields({ warehouse_code, warehouse_name } = {}) {
  const resolved = await resolveWarehouseByCodeOrName({ warehouse_code, warehouse_name });
  if (resolved) {
    return {
      warehouse_code: resolved.warehouse_code,
      warehouse_name: resolved.warehouse_name
    };
  }
  return {
    warehouse_code: warehouse_code ? String(warehouse_code).trim() : null,
    warehouse_name: warehouse_name ? String(warehouse_name).trim() : null
  };
}

/** Resolve client code + canonical name from code and/or name input. */
async function resolveClientFields({ client_code, client_name, warehouse_name, warehouse_code } = {}) {
  let whName = warehouse_name ? String(warehouse_name).trim() : null;
  if (warehouse_code && !whName) {
    const wh = await resolveWarehouseByCodeOrName({ warehouse_code });
    whName = wh?.warehouse_name || null;
  }
  const resolved = await resolveClientByCodeOrName({
    client_code,
    client_name,
    warehouse_name: whName || warehouse_name
  });
  if (resolved) {
    return {
      client_code: resolved.client_code,
      client_name: resolved.client_name
    };
  }
  return {
    client_code: client_code ? String(client_code).trim() : null,
    client_name: client_name ? String(client_name).trim() : null
  };
}

module.exports = {
  resolveWarehouseByCodeOrName,
  resolveClientByCodeOrName,
  resolveWarehouseFields,
  resolveClientFields
};
