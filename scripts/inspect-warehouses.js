// ====================================================================
// Warehouse inspector (scripts/inspect-warehouses.js)
// Prints warehouse_master and related assignment rows for debugging.
// Run: node scripts/inspect-warehouses.js
// ====================================================================

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mysql = require('mysql2/promise');

(async () => {
  const c = await mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME,
  });

  const [w] = await c.query('SELECT * FROM warehouse_master ORDER BY id');
  console.log('warehouse_master now:', JSON.stringify(w, null, 2));

  const [d] = await c.query(`
    SELECT DISTINCT warehouse_name, warehouse_code FROM do_operators
    WHERE warehouse_name IS NOT NULL AND TRIM(warehouse_name) <> ''`);
  console.log('from do_operators:', JSON.stringify(d, null, 2));

  const [a] = await c.query(`
    SELECT DISTINCT warehouse_name, warehouse_code FROM chamber_client_assignments
    WHERE warehouse_name IS NOT NULL AND TRIM(warehouse_name) <> ''`);
  console.log('from assignments:', JSON.stringify(a, null, 2));

  const [l] = await c.query(`
    SELECT DISTINCT warehouse_name, warehouse_code FROM daily_chamber_temp_logs
    WHERE warehouse_name IS NOT NULL AND TRIM(warehouse_name) <> ''`);
  console.log('from logs:', JSON.stringify(l, null, 2));

  await c.end();
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
