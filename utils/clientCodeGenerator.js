// ====================================================================
// Client master code generator (utils/clientCodeGenerator.js)
// Builds unique CL-* codes from client and warehouse names for reports.
// ====================================================================

/** Build URL-safe uppercase slug for master codes. */
function slugPart(value, maxLen = 14) {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-')
    .slice(0, maxLen);
}

/** Short token from warehouse code (WH-PUNE → PUNE) or warehouse name. */
function warehouseToken(warehouseName, warehouseCode) {
  const code = String(warehouseCode || '').trim().toUpperCase();
  if (code) {
    const stripped = code.replace(/^WH-/i, '');
    if (stripped) return slugPart(stripped, 10);
  }
  const name = String(warehouseName || '').trim();
  if (!name) return '';
  const words = name.split(/\s+/).filter(Boolean);
  if (words.length >= 2) {
    return words
      .map((w) => w[0])
      .join('')
      .toUpperCase()
      .slice(0, 8);
  }
  return slugPart(words[0], 10);
}

/** Primary token from client display name (Amul Logistics → AMUL). */
function clientToken(clientName) {
  const name = String(clientName || '').trim();
  if (!name) return '';
  const words = name.split(/\s+/).filter(Boolean);
  if (words.length >= 2 && words[0].length <= 6) {
    return slugPart(words[0], 12);
  }
  return slugPart(name.replace(/\s+/g, '-'), 16);
}

/**
 * Generate client master code from client + warehouse labels.
 * Example: Pune WH + Amul → CL-PUNE-AMUL
 */
function generateClientCode(clientName, warehouseName, warehouseCode) {
  const clientPart = clientToken(clientName);
  if (!clientPart) return '';
  const whPart = warehouseToken(warehouseName, warehouseCode);
  const raw = whPart ? `CL-${whPart}-${clientPart}` : `CL-${clientPart}`;
  return raw.replace(/-+/g, '-').slice(0, 48);
}

module.exports = {
  slugPart,
  generateClientCode
};
