// ====================================================================
// Master table recovery (scripts/recover-masters.js)
// Rebuilds missing warehouse/client master rows from log table names.
// Run: node scripts/recover-masters.js
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

  const [beforeWh] = await c.query(
    'SELECT id, warehouse_code, warehouse_name, is_active FROM warehouse_master ORDER BY id'
  );
  console.log('Warehouses before:', beforeWh);

  const [whResult] = await c.query(
    `UPDATE warehouse_master
     SET is_active = 1, updated_at = NOW()
     WHERE is_active = 0`
  );
  console.log('Warehouses reactivated:', whResult.affectedRows);

  const [inactiveCl] = await c.query(
    'SELECT id, client_code, client_name, warehouse_name, is_active FROM client_master WHERE is_active = 0 ORDER BY id'
  );
  console.log('Inactive clients (not auto-changed):', inactiveCl);

  // Optional: node scripts/recover-masters.js --clients
  if (process.argv.includes('--clients') && inactiveCl.length) {
    const [clResult] = await c.query(
      `UPDATE client_master
       SET is_active = 1, updated_at = NOW()
       WHERE is_active = 0`
    );
    console.log('Clients reactivated:', clResult.affectedRows);
  }

  const [afterWh] = await c.query(
    'SELECT id, warehouse_code, warehouse_name, is_active FROM warehouse_master ORDER BY id'
  );
  console.log('Warehouses after:', afterWh);

  await c.end();
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
