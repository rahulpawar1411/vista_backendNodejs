// ====================================================================
// GPS column check (scripts/check-gps-cols.js)
// Verifies photo_capture_latitude/longitude exist on log tables.
// Run: node scripts/check-gps-cols.js
// ====================================================================

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mysql = require('mysql2/promise');

(async () => {
  const c = await mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });

  for (const table of ['daily_chamber_temp_logs', 'inward_temp_logs', 'outward_temp_logs']) {
    try {
      const [cols] = await c.query(`SHOW COLUMNS FROM \`${table}\``);
      const gps = cols.filter((r) => /lat|lng|long|accuracy|photo_capture/i.test(r.Field)).map((r) => r.Field);
      console.log(`${table} gps-ish cols:`, gps.join(', ') || '(none)');
    } catch (e) {
      console.log(`${table}:`, e.message);
    }
  }

  const [r] = await c.query(
    'SELECT COUNT(*) AS c FROM daily_chamber_temp_logs WHERE photo_capture_latitude IS NOT NULL'
  );
  console.log('chamber logs with lat:', r[0].c);

  const [sample] = await c.query(
    `SELECT id, chamber_name, photo_capture_latitude, photo_capture_longitude, photo_capture_accuracy
     FROM daily_chamber_temp_logs
     WHERE photo_capture_latitude IS NOT NULL
     LIMIT 3`
  );
  console.log('sample:', JSON.stringify(sample, null, 2));
  await c.end();
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
