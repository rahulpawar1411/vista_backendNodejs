// ====================================================================
// One-off data fix: Bhopal Railway warehouse (hosted DB).
// Run manually when reactivating that site — not part of normal API startup.
// ====================================================================

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mysql = require('mysql2/promise');

(async () => {
  const c = await mysql.createConnection({
    host: 'reseau.proxy.rlwy.net',
    port: 24485,
    user: 'root',
    password: 'QAHXaSuMOKUFjpPnbQDRwwTLZunEbzec',
    database: 'railway',
    connectTimeout: 15000,
  });

  const [before] = await c.query(
    `SELECT id, warehouse_code, warehouse_name, is_active
     FROM warehouse_master
     WHERE LOWER(warehouse_name) LIKE '%bhopal%'
        OR warehouse_code LIKE '%BHOPAL%'`
  );
  console.log('Railway before:', before);

  const [result] = await c.query(
    `UPDATE warehouse_master
     SET is_active = 1, updated_at = NOW()
     WHERE LOWER(warehouse_name) LIKE '%bhopal%'
        OR warehouse_code LIKE '%BHOPAL%'`
  );
  console.log('Rows updated:', result.affectedRows);

  const [after] = await c.query(
    `SELECT id, warehouse_code, warehouse_name, is_active
     FROM warehouse_master
     WHERE LOWER(warehouse_name) LIKE '%bhopal%'
        OR warehouse_code LIKE '%BHOPAL%'`
  );
  console.log('Railway after:', after);
  await c.end();
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
