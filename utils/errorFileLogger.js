// ====================================================================
// Error File Logger (backend/utils/errorFileLogger.js)
// --------------------------------------------------------------------
// Writes EVERY backend error / failed process under backend/logs/
//
// Text format (easy to read in editor):
//   logs/error.json                 → master pretty-JSON blocks
//   logs/errors-YYYY-MM-DD.json     → daily pretty-JSON blocks
//   logs/failed-process.json        → process crashes only
//
// Machine format (one object per line — tools / scripts):
//   logs/error.jsonl
//   logs/errors-YYYY-MM-DD.jsonl
//
// Each object has: date, time, status, file, line, process, method, url, message, stack
// ====================================================================

const fs = require('fs');
const path = require('path');

const LOGS_DIR = path.join(__dirname, '..', 'logs');

/** Ensure backend/logs exists. */
function ensureLogsDir() {
  if (!fs.existsSync(LOGS_DIR)) {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
  }
  return LOGS_DIR;
}

/**
 * Local calendar parts (IST date/time for India).
 * @returns {{ date: string, time: string, iso: string, dayJson: string, dayJsonl: string }}
 */
function nowParts() {
  const d = new Date();
  const iso = d.toISOString();

  let date = iso.slice(0, 10);
  let time = iso.slice(11, 19) + 'Z';
  try {
    const fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    });
    const parts = Object.fromEntries(fmt.formatToParts(d).map((p) => [p.type, p.value]));
    date = `${parts.year}-${parts.month}-${parts.day}`;
    time = `${parts.hour}:${parts.minute}:${parts.second} IST`;
  } catch (_) {
    /* keep ISO-derived fallback */
  }

  return {
    date,
    time,
    iso,
    dayJson: `errors-${date}.json`,
    dayJsonl: `errors-${date}.jsonl`
  };
}

/**
 * Normalize log fields into a plain JSON-friendly object (stable key order).
 * @param {object} fields
 * @param {{ date: string, time: string, iso: string }} when
 */
function buildJsonEntry(fields, when) {
  return {
    category: fields.category || 'ERROR',
    date: when.date,
    time: when.time,
    iso: when.iso,
    status: fields.status != null ? fields.status : 500,
    type: fields.type || 'Error',
    file: fields.file || '-',
    line: fields.line != null ? fields.line : null,
    process: fields.process || fields.checkpoint || '-',
    method: fields.method || '-',
    url: fields.url || '-',
    user: fields.user || fields.email || '-',
    message: String(fields.message || 'Unknown error').replace(/\s+/g, ' ').trim(),
    details: fields.details != null ? fields.details : null,
    stack: fields.stack ? String(fields.stack).trim() : null
  };
}

/**
 * Pretty JSON block for humans (VS Code / notepad).
 * Separated by a blank line so each error is one clear object.
 */
function formatPrettyJson(entry) {
  return `${JSON.stringify(entry, null, 2)}\n\n`;
}

/** Single-line JSON for jq / scripts (JSON Lines). */
function formatJsonLine(entry) {
  return `${JSON.stringify(entry)}\n`;
}

/**
 * Append text to one or more log files (sync — safe for crash paths).
 * @param {string[]} fileNames
 * @param {string} text
 */
/**
 * WHAT: Appends one log chunk to named files under backend/logs/.
 * WHY: Sync write survives process crashes better than async for error paths.
 */
function appendToFiles(fileNames, text) {
  try {
    ensureLogsDir();
    for (const name of fileNames) {
      const full = path.join(LOGS_DIR, name);
      fs.appendFileSync(full, text, 'utf8');
    }
  } catch (writeErr) {
    console.warn('[LOG_WRITE_ERROR] Failed to write error log file:', writeErr.message);
  }
}

/** Skip dev smoke-test lines unless LOG_TESTS=1. */
function shouldSkipLog(fields) {
  if (process.env.LOG_TESTS === '1') return false;
  const msg = String(fields.message || '').toLowerCase();
  return msg.includes('smoke test') || msg.includes('safe to ignore');
}

/**
 * Write structured error as JSON (pretty + jsonl) — no legacy error.log.
 * @returns {object|null}
 */
function writeErrorLog(fields = {}) {
  if (shouldSkipLog(fields)) return null;

  const when = nowParts();
  const entry = buildJsonEntry(fields, when);

  appendToFiles(['error.json', when.dayJson], formatPrettyJson(entry));
  appendToFiles(['error.jsonl', when.dayJsonl], formatJsonLine(entry));

  return entry;
}

/**
 * Failed / crashed process → also append to failed-process.json
 */
function writeFailedProcess(processName, err, meta = {}) {
  const message = err && err.message ? err.message : String(err || 'Unknown process failure');
  const stack = err && err.stack ? err.stack : null;

  const entry = writeErrorLog({
    category: 'FAILED_PROCESS',
    status: meta.status != null ? meta.status : 500,
    type: (err && (err.type || err.name)) || 'FailedProcess',
    file: meta.file || '-',
    line: meta.line != null ? meta.line : null,
    process: processName || 'unknown_process',
    method: meta.method || '-',
    url: meta.url || '-',
    user: meta.user || meta.email || 'system',
    message,
    stack,
    details: meta.details || null
  });

  try {
    ensureLogsDir();
    fs.appendFileSync(
      path.join(LOGS_DIR, 'failed-process.json'),
      formatPrettyJson(entry),
      'utf8'
    );
    fs.appendFileSync(
      path.join(LOGS_DIR, 'failed-process.jsonl'),
      formatJsonLine(entry),
      'utf8'
    );
  } catch (_) {}

  return entry;
}

/**
 * HTTP failure (4xx/5xx) when controllers skipped handleControllerError.
 */
function writeHttpFailure(req, statusCode, body = {}, meta = {}) {
  return writeErrorLog({
    category: statusCode >= 500 ? 'HTTP_ERROR' : 'HTTP_FAILED',
    status: statusCode,
    type: body?.checkpoint?.type || (statusCode >= 500 ? 'HttpError' : 'HttpFailed'),
    file: body?.checkpoint?.file || meta.file || 'server.js',
    line: body?.checkpoint?.line != null ? body.checkpoint.line : null,
    process: body?.checkpoint?.checkpoint || meta.process || 'httpResponse',
    method: req?.method || '-',
    url: req?.originalUrl || req?.url || '-',
    user: req?.user?.email || 'system',
    message: body?.error || body?.message || `HTTP ${statusCode}`,
    stack: meta.stack || null,
    details: meta.details || null
  });
}

module.exports = {
  LOGS_DIR,
  ensureLogsDir,
  nowParts,
  buildJsonEntry,
  formatPrettyJson,
  formatJsonLine,
  writeErrorLog,
  writeFailedProcess,
  writeHttpFailure
};
