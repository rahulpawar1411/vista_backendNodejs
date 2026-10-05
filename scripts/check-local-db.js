// ====================================================================
// Local WAMP/MySQL check (scripts/check-local-db.js)
// Connects to localhost DB from .env and prints basic stats.
// Run: node scripts/check-local-db.js
// ====================================================================

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mysql = require('mysql2/promise');

(async () => {
  const c = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'reeferon_crm_db',
    port: Number(process.env.DB_PORT) || 3306,
  });

  console.log('Target:', process.env.DB_HOST, process.env.DB_NAME);

  const [tables] = await c.query('SHOW TABLES');
  const key = Object.keys(tables[0] || { Tables_in_x: 1 })[0];
  const names = tables.map((t) => t[key]);
  console.log('Tables (' + names.length + '):', names.join(', ') || '(none)');

  const important = [
    'super_admin',
    'sub_admins',
    'customers',
    'do_operators',
    'chambers',
    'chamber_client_assignments',
    'warehouse_master',
    'client_master',
    'daily_chamber_temp_logs',
    'inward_temp_logs',
    'outward_temp_logs',
    'do_operator_activities',
    'login_security',
  ];

  for (const t of important) {
    if (!names.includes(t)) {
      console.log('MISSING:', t);
      continue;
    }
    const [r] = await c.query(`SELECT COUNT(*) AS c FROM \`${t}\``);
    console.log(`${t}: ${r[0].c}`);
  }

  await c.end();
})().catch((e) => {
  console.error('FAIL:', e.message);
  process.exit(1);
});
