#!/usr/bin/env node
/**
 * MySQL backup → backend/backups/reeferon-YYYY-MM-DD_HH-mm.sql
 * Uses mysqldump when available; otherwise writes a JSON snapshot of all tables.
 *
 * Run: npm run db:backup
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const BACKUP_DIR = path.join(__dirname, '..', 'backups');

/** File-safe timestamp string for backup filenames. */
function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}`;
}

async function backupViaMysqlDump(outFile) {
  const host = process.env.DB_HOST || 'localhost';
  const user = process.env.DB_USER || 'root';
  const password = process.env.DB_PASSWORD || '';
  const database = process.env.DB_NAME || 'reeferon_crm_db';
  const port = process.env.DB_PORT || '3306';

  const args = [
    '-h', host,
    '-P', String(port),
    '-u', user,
    `--result-file=${outFile}`,
    '--single-transaction',
    '--routines',
    '--triggers',
    database
  ];
  if (password) args.unshift(`--password=${password}`);

  const result = spawnSync('mysqldump', args, { encoding: 'utf8', shell: process.platform === 'win32' });
  if (result.error || result.status !== 0) {
    throw new Error(result.stderr || result.error?.message || 'mysqldump failed');
  }
  return 'mysqldump';
}

async function backupViaNode(outFile) {
  const mysql = require('mysql2/promise');
  const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'reeferon_crm_db',
    port: Number(process.env.DB_PORT) || 3306,
    connectionLimit: 2
  });

  const snapshot = { exportedAt: new Date().toISOString(), database: process.env.DB_NAME, tables: {} };
  const [tables] = await pool.query('SHOW TABLES');
  const tableKey = Object.keys(tables[0] || {})[0] || 'Tables_in_db';

  for (const row of tables) {
    const tableName = row[tableKey];
    const [rows] = await pool.query(`SELECT * FROM \`${tableName}\``);
    snapshot.tables[tableName] = rows;
  }

  await pool.end();
  fs.writeFileSync(outFile.replace(/\.sql$/, '.json'), JSON.stringify(snapshot, null, 2), 'utf8');
  return 'json';
}

async function main() {
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

  const base = `reeferon-${timestamp()}`;
  const sqlFile = path.join(BACKUP_DIR, `${base}.sql`);

  let method;
  try {
    method = await backupViaMysqlDump(sqlFile);
    console.log(`✅ SQL backup: backups/${path.basename(sqlFile)} (${method})`);
  } catch (dumpErr) {
    console.warn('mysqldump unavailable:', dumpErr.message);
    console.log('Falling back to JSON snapshot…');
    method = await backupViaNode(sqlFile);
    console.log(`✅ JSON backup: backups/${base}.json (${method})`);
  }

  // Keep last 14 backup files
  const files = fs.readdirSync(BACKUP_DIR).sort().reverse();
  for (const f of files.slice(14)) {
    try {
      fs.unlinkSync(path.join(BACKUP_DIR, f));
      console.log(`Removed old backup: ${f}`);
    } catch (_) {}
  }
}

main().catch((err) => {
  console.error('Backup failed:', err.message);
  process.exit(1);
});
