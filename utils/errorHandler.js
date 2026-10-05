// ====================================================================
// Structured Error Checkpoints (backend/utils/errorHandler.js)
// Captures: type, status, file, line, checkpoint, method, url, message
// Persists ERROR rows into do_operator_activities for Super Admin logs.
// ====================================================================

const path = require('path');
const { logActivity } = require('./logger');

/**
 * Application error with HTTP status + checkpoint metadata.
 */
class AppError extends Error {
  constructor(message, statusCode = 500, options = {}) {
    super(message);
    this.name = options.type || 'AppError';
    this.statusCode = statusCode;
    this.type = options.type || 'AppError';
    this.checkpoint = options.checkpoint || null;
    this.isOperational = options.isOperational !== false;
    this.details = options.details || null;
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Parse first useful frame from an Error stack.
 * Skips node_modules and this utility file.
 */
function parseStackFrame(err) {
  const stack = err && err.stack ? String(err.stack) : '';
  const lines = stack.split('\n').map((l) => l.trim()).filter(Boolean);

  for (const line of lines) {
    if (line.startsWith('Error') || line.startsWith(err?.name || 'Error')) continue;
    if (line.includes('node_modules')) continue;
    if (line.includes(`${path.sep}utils${path.sep}errorHandler`)) continue;

    // at fn (C:\path\file.js:12:34)  OR  at C:\path\file.js:12:34
    const withFn = line.match(/at\s+(?:(.+?)\s+)?\(?(.+?):(\d+):(\d+)\)?$/);
    if (withFn) {
      const filePath = withFn[2];
      if (!filePath || filePath.startsWith('node:')) continue;
      return {
        functionName: (withFn[1] || '').trim() || null,
        file: path.basename(filePath),
        filePath,
        line: Number(withFn[3]) || null,
        column: Number(withFn[4]) || null
      };
    }
  }

  return { functionName: null, file: null, filePath: null, line: null, column: null };
}

/** Maps mysql / multer / custom errors to a short label for logs and checkpoints. */
function classifyErrorType(err) {
  if (!err) return 'UnknownError';
  if (err.type) return err.type;
  if (err.name && err.name !== 'Error') return err.name;
  if (err.code === 'ER_DUP_ENTRY') return 'DatabaseDuplicateError';
  if (err.code && String(err.code).startsWith('ER_')) return 'DatabaseError';
  if (err.code === 'ENOENT') return 'FileNotFoundError';
  if (err.code === 'LIMIT_FILE_SIZE') return 'UploadLimitError';
  if (err instanceof SyntaxError) return 'SyntaxError';
  return 'UnhandledError';
}

/** Picks HTTP status from err.statusCode or known error codes (duplicate row → 409). */
function resolveStatusCode(err, fallback = 500) {
  if (err && Number.isInteger(err.statusCode)) return err.statusCode;
  if (err && Number.isInteger(err.status)) return err.status;
  if (err && err.code === 'ER_DUP_ENTRY') return 409;
  if (err && err.code === 'LIMIT_FILE_SIZE') return 413;
  return fallback;
}

/**
 * Build a structured checkpoint object for logging / API responses.
 */
function buildCheckpoint(err, meta = {}) {
  const frame = parseStackFrame(err);
  const status = resolveStatusCode(err, meta.statusCode || 500);
  const type = classifyErrorType(err);

  return {
    checkpoint: meta.checkpoint || err?.checkpoint || frame.functionName || 'unknown',
    type,
    status,
    file: frame.file || meta.file || null,
    line: frame.line || meta.line || null,
    column: frame.column || null,
    functionName: frame.functionName || null,
    method: meta.method || null,
    url: meta.url || null,
    message: (err && err.message) ? String(err.message) : 'Unknown error',
    details: err?.details || meta.details || null,
    timestamp: new Date().toISOString()
  };
}

/**
 * Human + machine readable checkpoint string for activity log description.
 */
function formatCheckpointDescription(cp) {
  const parts = [
    `[CHECKPOINT]`,
    `type=${cp.type || '-'}`,
    `status=${cp.status || '-'}`,
    `file=${cp.file || '-'}`,
    `line=${cp.line ?? '-'}`,
    `checkpoint=${cp.checkpoint || '-'}`,
    cp.method ? `method=${cp.method}` : null,
    cp.url ? `url=${cp.url}` : null,
    `msg=${(cp.message || '').replace(/\s+/g, ' ').slice(0, 400)}`
  ].filter(Boolean);

  return parts.join(' | ');
}

/**
 * Append structured error to backend/logs/error.log + daily errors-YYYY-MM-DD.log
 * Fields: DATE, TIME, STATUS, FILE, PROCESS, METHOD, URL, MESSAGE, STACK
 */
function logToFile(cp, err) {
  try {
    const { writeErrorLog } = require('./errorFileLogger');
    writeErrorLog({
      category: 'ERROR',
      status: cp.status || 500,
      type: cp.type || 'Error',
      file: cp.file || '-',
      line: cp.line != null ? cp.line : '-',
      process: cp.checkpoint || 'unknown',
      method: cp.method || '-',
      url: cp.url || '-',
      user: cp.email || '-',
      message: cp.message || 'Unknown error',
      stack: err && err.stack ? err.stack : null,
      details: cp.details || null
    });
  } catch (writeErr) {
    console.warn('[LOG_WRITE_ERROR] Failed to write to error.log:', writeErr.message);
  }
}

/**
 * Persist structured error into do_operator_activities (ERROR / SYSTEM_ERROR)
 * AND always append to the on-disk error log files.
 */
async function logErrorCheckpoint(err, meta = {}) {
  const cp = buildCheckpoint(err, meta);
  // Carry email onto checkpoint for the file logger
  cp.email = meta.email || 'system';
  const email = cp.email;
  const description = formatCheckpointDescription(cp);

  console.error(`[ERROR] ${cp.status || 500} ${cp.method || '-'} ${cp.url || '-'} | ${cp.type || 'Error'} @ ${cp.file || '?'}:${cp.line ?? '?'} | ${cp.message}`);

  // Always store on disk (file name, status, date/time, process)
  logToFile(cp, err);

  try {
    await logActivity(email, 'SYSTEM_ERROR', 'ERROR', description);
  } catch (logErr) {
    console.error('Failed to persist error checkpoint:', logErr.message);
    // Still keep a file trail if DB activity log fails
    try {
      const { writeFailedProcess } = require('./errorFileLogger');
      writeFailedProcess('logActivity', logErr, {
        status: 500,
        details: { original: description }
      });
    } catch (_) {}
  }

  return cp;
}

/**
 * Standard controller catch helper.
 * Logs a checkpoint (file + console + activity) then returns a safe JSON body:
 *   { success: false, message, error, checkpoint: { type, status, file, line, ... } }
 *
 * 5xx responses never leak raw SQL / stack traces — only clientMessage.
 *
 * Usage in any controller:
 *   const { handleControllerError } = require('../utils/errorHandler');
 *   ...
 *   } catch (err) {
 *     return handleControllerError(res, err, {
 *       checkpoint: 'getInwardLogs',          // unique name for logs
 *       req,                                 // fills method/url/email
 *       clientMessage: 'Failed to fetch inward logs.'
 *     });
 *   }
 */
async function handleControllerError(res, err, options = {}) {
  const req = options.req || null;
  const statusCode = resolveStatusCode(err, options.statusCode || 500);
  // 5xx: never leak internal DB/stack messages to clients
  const clientMessage =
    statusCode >= 500
      ? options.clientMessage || 'A system error occurred. Please contact support.'
      : options.clientMessage || err?.message || 'Request failed.';

  const cp = await logErrorCheckpoint(err, {
    checkpoint: options.checkpoint || 'controller',
    statusCode,
    method: req?.method || options.method || null,
    url: req?.originalUrl || req?.url || options.url || null,
    email: req?.user?.email || options.email || 'system',
    details: options.details || null
  });

  if (res.headersSent) return;

  // Avoid double-logging via server.js res.json interceptor
  res.locals = res.locals || {};
  res.locals.errorCheckpointLogged = true;

  return res.status(statusCode).json({
    success: false,
    message: clientMessage,
    error: clientMessage,
    checkpoint: {
      type: cp.type,
      status: cp.status,
      file: cp.file,
      line: cp.line,
      checkpoint: cp.checkpoint,
      method: cp.method,
      url: cp.url,
      timestamp: cp.timestamp
    }
  });
}

/**
 * Express global error middleware (err, req, res, next).
 */
async function globalErrorMiddleware(err, req, res, next) {
  const statusCode = resolveStatusCode(err, 500);
  const cp = await logErrorCheckpoint(err, {
    checkpoint: err?.checkpoint || 'globalErrorMiddleware',
    statusCode,
    method: req.method,
    url: req.originalUrl,
    email: req.user?.email || 'system'
  });

  if (res.headersSent) return next(err);

  res.locals = res.locals || {};
  res.locals.errorCheckpointLogged = true;

  return res.status(statusCode).json({
    success: false,
    message: statusCode >= 500
      ? 'A system error occurred. Please contact support.'
      : (err.message || 'Request failed.'),
    error: statusCode >= 500
      ? 'A system error occurred. Please contact support.'
      : (err.message || 'Request failed.'),
    checkpoint: {
      type: cp.type,
      status: cp.status,
      file: cp.file,
      line: cp.line,
      checkpoint: cp.checkpoint,
      method: cp.method,
      url: cp.url,
      timestamp: cp.timestamp
    }
  });
}

module.exports = {
  AppError,
  parseStackFrame,
  classifyErrorType,
  resolveStatusCode,
  buildCheckpoint,
  formatCheckpointDescription,
  logErrorCheckpoint,
  handleControllerError,
  globalErrorMiddleware,
  // Re-export file logger helpers for controllers / scripts
  writeErrorLog: (...args) => require('./errorFileLogger').writeErrorLog(...args),
  writeFailedProcess: (...args) => require('./errorFileLogger').writeFailedProcess(...args)
};
