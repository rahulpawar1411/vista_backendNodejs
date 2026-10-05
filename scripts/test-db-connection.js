// ====================================================================
// DB connection smoke test (scripts/test-db-connection.js)
// Prints success or the exact MySQL error from .env credentials.
// Run: node scripts/test-db-connection.js
// ====================================================================

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mysql = require('mysql2/promise');

(async () => {
  const cfg = {
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME,
    port: Number(process.env.DB_PORT) || 3306,
    connectTimeout: 12000,
  };

  console.log('Active credentials:');
  console.log('  DB_HOST:', cfg.host);
  console.log('  DB_USER:', cfg.user);
  console.log('  DB_NAME:', cfg.database);
  console.log('  DB_PORT:', cfg.port);
  console.log('  DB_PASSWORD:', cfg.password ? '(set)' : '(empty)');

  if (String(cfg.host || '').includes('.internal')) {
    console.log('\nWARNING: *.internal host only works inside Railway network.');
    console.log('Local PC / local npm start usually CANNOT reach this host.');
  }

  try {
    const c = await mysql.createConnection(cfg);
    const [r] = await c.query('SELECT 1 AS ok, DATABASE() AS db');
    console.log('\nCONNECT: OK');
    console.log('  database:', r[0].db);

    const [tables] = await c.query('SHOW TABLES');
    console.log('  tables:', tables.length);

    await c.end();
    process.exit(0);
  } catch (e) {
    console.log('\nCONNECT: FAIL');
    console.log('  error:', e.code || '', e.message);
    process.exit(1);
  }
})();
