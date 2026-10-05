// ====================================================================
// Warehouse master code generator (utils/warehouseCodeGenerator.js)
// Assigns WH-CITY-01 style codes when Super Admin adds warehouses.
// ====================================================================

/** Build uppercase slug for warehouse codes (letters/digits/hyphen). */
function slugPart(value, maxLen = 12) {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-')
    .slice(0, maxLen);
}

/** Prefer warehouse name only (city does not affect code). */
function warehouseCodeSlug(warehouseName, _city) {
  return slugPart(warehouseName, 12);
}

/**
 * Auto warehouse code: WH-PUNE-01, WH-PUNE-02, …
 * Number increments for the same name slug among existingCodes.
 */
function generateWarehouseCode(warehouseName, city, existingCodes = []) {
  const slug = warehouseCodeSlug(warehouseName, city);
  if (!slug) return '';
  const prefix = `WH-${slug}`;
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^${escaped}(?:-(\\d+))?$`, 'i');
  let max = 0;
  (existingCodes || []).forEach((raw) => {
    const code = String(raw || '').trim().toUpperCase();
    const m = code.match(re);
    if (!m) return;
    const n = m[1] ? parseInt(m[1], 10) : 1;
    if (Number.isFinite(n) && n > max) max = n;
  });
  const next = max + 1;
  return `${prefix}-${String(next).padStart(2, '0')}`.slice(0, 48);
}

module.exports = { generateWarehouseCode, warehouseCodeSlug };
