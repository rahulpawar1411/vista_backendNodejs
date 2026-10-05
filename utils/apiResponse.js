// ====================================================================
// Standard API JSON responses (backend/utils/apiResponse.js)
// --------------------------------------------------------------------
// Success: { success: true, message, data }
// Error:   { success: false, message, error, checkpoint? }
// ====================================================================

/**
 * @param {import('express').Response} res
 * @param {*} [data]
 * @param {string} [message]
 * @param {number} [status]
 */
/**
 * Sends a standard success JSON shape so web and mobile clients parse responses the same way.
 */
function sendSuccess(res, data = null, message = 'OK', status = 200) {
  const body = { success: true, message };
  if (data !== null && data !== undefined) body.data = data;
  return res.status(status).json(body);
}

/**
 * @param {import('express').Response} res
 * @param {string} message
 * @param {number} [status]
 * @param {object} [extra] - checkpoint, details, etc.
 */
/**
 * Sends a standard error JSON shape; optional extra fields carry checkpoint metadata for debugging.
 */
function sendError(res, message, status = 500, extra = {}) {
  return res.status(status).json({
    success: false,
    message,
    error: message,
    ...extra
  });
}

module.exports = { sendSuccess, sendError };
