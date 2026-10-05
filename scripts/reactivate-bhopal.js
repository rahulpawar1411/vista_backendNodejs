// ====================================================================
// One-off data fix: reactivate Bhopal warehouse rows in master tables.
// Run manually for ops cleanup — not used by the running server.
// ====================================================================

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mysql = require('mysql2/promise');

(async () => {
  const c = await mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME,
    port: Number(process.env.DB_PORT) || 3306,
  });

  const [before] = await c.query(
    `SELECT id, warehouse_code, warehouse_name, is_active
     FROM warehouse_master
     WHERE LOWER(warehouse_name) LIKE '%bhopal%'
        OR LOWER(warehouse_code) LIKE '%bhopal%'`
  );
  console.log('Before:', before);

  const [result] = await c.query(
    `UPDATE warehouse_master
     SET is_active = 1, updated_at = NOW()
     WHERE LOWER(warehouse_name) LIKE '%bhopal%'
        OR LOWER(warehouse_code) LIKE '%bhopal%'`
  );
  console.log('Rows updated:', result.affectedRows);

  const [after] = await c.query(
    `SELECT id, warehouse_code, warehouse_name, is_active
     FROM warehouse_master
     WHERE LOWER(warehouse_name) LIKE '%bhopal%'
        OR LOWER(warehouse_code) LIKE '%bhopal%'`
  );
  console.log('After:', after);

  await c.end();
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
