// ====================================================================
// Quick DB sanity check (scripts/check-db.js)
// Connects with .env credentials and prints table list + row counts.
// Run: node scripts/check-db.js
// ====================================================================

require('dotenv').config();
const mysql = require('mysql2/promise');

(async () => {
  try {
    const c = await mysql.createConnection({
      host: process.env.DB_HOST,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      port: Number(process.env.DB_PORT) || 3306,
      connectTimeout: 20000,
    });
    const [tables] = await c.query('SHOW TABLES');
    const key = `Tables_in_${process.env.DB_NAME}`;
    const names = tables.map((t) => t[key] || Object.values(t)[0]);
    console.log('Connected OK. Tables:', names.length);
    console.log(names.join(', '));
    for (const t of [
      'super_admin',
      'sub_admins',
      'customers',
      'do_operators',
      'inward_logs',
      'outward_logs',
    ]) {
      if (names.includes(t)) {
        const [r] = await c.query(`SELECT COUNT(*) AS c FROM \`${t}\``);
        console.log(`${t}:`, r[0].c);
      }
    }
    await c.end();
  } catch (e) {
    console.error('FAIL:', e.message);
    process.exit(1);
  }
})();
