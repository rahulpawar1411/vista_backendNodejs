/**
 * Resolve customer/DO scope CSV tokens (codes or names) → master display names.
 */
const db = require('../config/db');

function normalizeScopeCsv(value) {
  if (value == null || value === '') return null;
  const parts = Array.isArray(value)
    ? value.map((v) => String(v || '').trim()).filter(Boolean)
    : String(value)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
  return parts.length ? parts.join(',') : null;
}

async function loadScopeMaps() {
  const clientMaps = { byCode: new Map(), byName: new Map() };
  const warehouseMaps = { byCode: new Map(), byName: new Map() };
  try {
    const [clients] = await db.query(
      'SELECT client_code, client_name FROM client_master WHERE is_active = 1'
    );
    (clients || []).forEach((r) => {
      const code = String(r.client_code || '').trim();
      const name = String(r.client_name || '').trim();
      if (code) clientMaps.byCode.set(code.toLowerCase(), name || code);
      if (name) clientMaps.byName.set(name.toLowerCase(), name);
    });
    const [warehouses] = await db.query(
      'SELECT warehouse_code, warehouse_name FROM warehouse_master WHERE is_active = 1'
    );
    (warehouses || []).forEach((r) => {
      const code = String(r.warehouse_code || '').trim();
      const name = String(r.warehouse_name || '').trim();
      if (code) warehouseMaps.byCode.set(code.toLowerCase(), name || code);
      if (name) warehouseMaps.byName.set(name.toLowerCase(), name);
    });
  } catch (err) {
    console.warn('loadScopeMaps skipped:', err.message);
  }
  return { clientMaps, warehouseMaps };
}

async function resolveScopeTokens({ clientsCsv, warehousesCsv, clientMaps, warehouseMaps }) {
  let clientsStr = normalizeScopeCsv(clientsCsv);
  let warehousesStr = normalizeScopeCsv(warehousesCsv);

  try {
    let byClientCode = clientMaps?.byCode;
    let byClientName = clientMaps?.byName;
    if (!byClientCode || !byClientName) {
      const maps = await loadScopeMaps();
      byClientCode = maps.clientMaps.byCode;
      byClientName = maps.clientMaps.byName;
      if (!warehouseMaps) {
        warehouseMaps = maps.warehouseMaps;
      }
    }

    let byWhCode = warehouseMaps?.byCode;
    let byWhName = warehouseMaps?.byName;
    if (!byWhCode || !byWhName) {
      const maps = await loadScopeMaps();
      byWhCode = maps.warehouseMaps.byCode;
      byWhName = maps.warehouseMaps.byName;
    }

    if (clientsStr) {
      const resolved = clientsStr
        .split(',')
        .map((token) => {
          const t = token.trim();
          if (!t) return '';
          const key = t.toLowerCase();
          return byClientName.get(key) || byClientCode.get(key) || t;
        })
        .filter(Boolean);
      const seen = new Set();
      clientsStr =
        resolved
          .filter((v) => {
            const k = v.toLowerCase();
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
          })
          .join(',') || null;
    }

    if (warehousesStr) {
      const resolved = warehousesStr
        .split(',')
        .map((token) => {
          const t = token.trim();
          if (!t) return '';
          const key = t.toLowerCase();
          return byWhName.get(key) || byWhCode.get(key) || t;
        })
        .filter(Boolean);
      const seen = new Set();
      warehousesStr =
        resolved
          .filter((v) => {
            const k = v.toLowerCase();
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
          })
          .join(',') || null;
    }
  } catch (err) {
    console.warn('resolveScopeTokens skipped:', err.message);
  }

  return { clientsStr, warehousesStr };
}

module.exports = {
  normalizeScopeCsv,
  loadScopeMaps,
  resolveScopeTokens
};
