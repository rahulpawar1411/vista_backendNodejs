#!/usr/bin/env node
/**
 * Move legacy text logs (error.log, errors-*.log) into logs/archive/
 * Run: node scripts/archive-error-logs.js
 */
const fs = require('fs');
const path = require('path');

const LOGS_DIR = path.join(__dirname, '..', 'logs');
const ARCHIVE_DIR = path.join(LOGS_DIR, 'archive');

/**
 * Moves old error.log / errors-*.log files into logs/archive/ so the active folder stays small.
 */
function archiveLegacyLogs() {
  if (!fs.existsSync(LOGS_DIR)) {
    console.log('No logs folder yet.');
    return { moved: 0 };
  }
  if (!fs.existsSync(ARCHIVE_DIR)) {
    fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  let moved = 0;

  for (const name of fs.readdirSync(LOGS_DIR)) {
    const full = path.join(LOGS_DIR, name);
    if (!fs.statSync(full).isFile()) continue;
    // Archive old text logs only — keep active JSON / JSONL
    const isLegacyText =
      name === 'error.log' ||
      (/^errors-\d{4}-\d{2}-\d{2}\.log$/.test(name) && !name.endsWith('.jsonl'));
    if (!isLegacyText) continue;

    const dest = path.join(ARCHIVE_DIR, `${stamp}_${name}`);
    try {
      fs.renameSync(full, dest);
      moved += 1;
      console.log(`Archived → archive/${path.basename(dest)}`);
    } catch (err) {
      console.warn(`Skip ${name}:`, err.message);
    }
  }

  return { moved };
}

if (require.main === module) {
  const { moved } = archiveLegacyLogs();
  console.log(moved ? `Done. ${moved} file(s) archived.` : 'Nothing to archive.');
}

module.exports = { archiveLegacyLogs, ARCHIVE_DIR, LOGS_DIR };
