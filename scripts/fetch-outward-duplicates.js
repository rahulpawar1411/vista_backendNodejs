// ====================================================================
// Outward duplicate finder (scripts/fetch-outward-duplicates.js)
// Lists outward rows that share the same vehicle/date (data cleanup aid).
// Run: node scripts/fetch-outward-duplicates.js
// ====================================================================

require('dotenv').config();
const mysql = require('mysql2/promise');

(async () => {
  const db = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
  });

  const [cols] = await db.query('SHOW COLUMNS FROM outward_temp_logs');
  const names = cols.map((c) => c.Field);
  const hasSubmission = names.includes('client_submission_id');

  const [all] = await db.query(`
    SELECT outward_id, reference_no,
           DATE_FORMAT(outward_entry_date,'%Y-%m-%d') entry_date,
           outward_vehicle_no vehicle,
           outward_client_name client,
           warehouse_name warehouse,
           operator_email operator,
           outward_dock_no dock,
           outward_invoice_qty invoice_qty,
           outward_created_at created_at
           ${hasSubmission ? ', client_submission_id, client_submitted_at' : ''}
    FROM outward_temp_logs
    ORDER BY outward_id
  `);

  const [pairs] = await db.query(`
    SELECT a.outward_id keep_id, b.outward_id extra_id,
           a.reference_no keep_ref, b.reference_no extra_ref,
           DATE_FORMAT(a.outward_entry_date,'%Y-%m-%d') entry_date,
           a.outward_vehicle_no vehicle,
           a.outward_client_name client,
           a.warehouse_name warehouse,
           a.operator_email operator,
           a.outward_created_at keep_at,
           b.outward_created_at extra_at,
           TIMESTAMPDIFF(SECOND, a.outward_created_at, b.outward_created_at) seconds_apart
    FROM outward_temp_logs a
    JOIN outward_temp_logs b
      ON a.outward_id < b.outward_id
     AND a.outward_entry_date = b.outward_entry_date
     AND TRIM(LOWER(a.outward_vehicle_no)) = TRIM(LOWER(b.outward_vehicle_no))
     AND TRIM(LOWER(IFNULL(a.warehouse_name,''))) = TRIM(LOWER(IFNULL(b.warehouse_name,'')))
     AND TRIM(LOWER(IFNULL(a.outward_client_name,''))) = TRIM(LOWER(IFNULL(b.outward_client_name,'')))
     AND TRIM(LOWER(IFNULL(a.operator_email,''))) = TRIM(LOWER(IFNULL(b.operator_email,'')))
     AND ABS(TIMESTAMPDIFF(MINUTE, a.outward_created_at, b.outward_created_at)) <= 10
    ORDER BY a.outward_id
  `);

  const [sameDayVehicle] = await db.query(`
    SELECT DATE_FORMAT(outward_entry_date,'%Y-%m-%d') entry_date,
           MIN(outward_vehicle_no) vehicle,
           MIN(outward_client_name) client,
           MIN(warehouse_name) warehouse,
           COUNT(*) cnt,
           GROUP_CONCAT(CONCAT(outward_id, ':', IFNULL(reference_no,'')) ORDER BY outward_id) ids
    FROM outward_temp_logs
    GROUP BY outward_entry_date, TRIM(LOWER(outward_vehicle_no)),
             TRIM(LOWER(IFNULL(warehouse_name,''))),
             TRIM(LOWER(IFNULL(outward_client_name,'')))
    HAVING COUNT(*) > 1
    ORDER BY cnt DESC
  `);

  console.log(JSON.stringify({
    host: process.env.DB_HOST,
    db: process.env.DB_NAME,
    total: all.length,
    close_time_pairs: pairs,
    same_day_vehicle_client: sameDayVehicle,
    all
  }, null, 2));

  await db.end();
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
