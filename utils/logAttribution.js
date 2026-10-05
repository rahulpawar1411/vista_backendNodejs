// ====================================================================
// Log attribution helper (utils/logAttribution.js)
// ====================================================================

/**
 * WHAT: Picks warehouse_name, warehouse_code, and operator_email for a new log row.
 * WHY: Reports must show which DO and site created the entry, even if body omits them.
 * HOW: JWT req.user wins; otherwise uses matching keys from the request body.
 */
function resolveLogAttribution(req, body = {}) {
  const warehouse =
    (req.user && req.user.warehouse_name) ||
    body.warehouse_name ||
    null;
  const warehouseCode =
    (req.user && req.user.warehouse_code) ||
    body.warehouse_code ||
    null;
  const operatorEmail =
    (req.user && req.user.email) ||
    body.operator_email ||
    null;

  return {
    warehouse_name: warehouse ? String(warehouse).trim() : null,
    warehouse_code: warehouseCode ? String(warehouseCode).trim() : null,
    operator_email: operatorEmail ? String(operatorEmail).trim().toLowerCase() : null
  };
}

module.exports = { resolveLogAttribution };
