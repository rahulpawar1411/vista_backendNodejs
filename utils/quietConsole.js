// ====================================================================
// Quiet terminal logger — only server status, errors, and HTTP status codes
// ====================================================================

const orig = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console)
};

let quietEnabled = true;

/** Hides noisy console.log in dev unless the line looks like server status or a real warning. */
function enableQuietConsole() {
  quietEnabled = true;

  console.log = (...args) => {
    if (!quietEnabled) return orig.log(...args);
    const msg = args.map(String).join(' ');
    // Allow explicit server-running lines only
    if (
      /server running/i.test(msg) ||
      /listening on/i.test(msg) ||
      /^\[SERVER\]/.test(msg) ||
      /^\[STATUS\]/.test(msg)
    ) {
      orig.log(...args);
    }
  };

  console.warn = (...args) => {
    if (!quietEnabled) return orig.warn(...args);
    const msg = args.map(String).join(' ');
    // Surface real failures / connection problems
    if (
      /fail/i.test(msg) ||
      /error/i.test(msg) ||
      /unable/i.test(msg) ||
      /cannot/i.test(msg) ||
      /^\[ERROR\]/.test(msg) ||
      /^\[WARN\]/.test(msg)
    ) {
      orig.warn(...args);
    }
  };

  console.error = (...args) => {
    // Always show errors
    orig.error(...args);
  };
}

/** Restores normal console.log / warn behavior (useful when debugging). */
function disableQuietConsole() {
  quietEnabled = false;
  console.log = orig.log;
  console.warn = orig.warn;
  console.error = orig.error;
}

/** Prints the canonical “server listening” line used after bind. */
function serverRunning(port) {
  orig.log(`[SERVER] listening on 0.0.0.0:${port}`);
}

/** One-line HTTP log for 4xx/5xx (or all statuses when LOG_ALL_STATUS=1). */
function statusLine(method, url, statusCode) {
  const tag = statusCode >= 500 ? 'ERROR' : statusCode >= 400 ? 'WARN' : 'STATUS';
  const line = `[${tag}] ${statusCode} ${method} ${url}`;
  if (statusCode >= 400) orig.error(line);
  else orig.log(line);
}

/** Always prints [ERROR] lines — never filtered by quiet mode. */
function errorLine(message, extra) {
  if (extra !== undefined) orig.error(`[ERROR] ${message}`, extra);
  else orig.error(`[ERROR] ${message}`);
}

module.exports = {
  enableQuietConsole,
  disableQuietConsole,
  serverRunning,
  statusLine,
  errorLine,
  raw: orig
};
