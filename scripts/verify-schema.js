// ====================================================================
// Schema verification (scripts/verify-schema.js)
// Checks that required CRM tables and columns exist in MySQL.
// Run: node scripts/verify-schema.js
// ====================================================================

require('dotenv').config();
const mysql = require('mysql2/promise');

const REQUIRED = {
  super_admin: ['email', 'password', 'full_name'],
  sub_admins: ['email', 'password', 'full_name', 'phone_no'],
  customers: ['email', 'password', 'allowed_clients', 'allowed_warehouses'],
  do_operators: ['email', 'password', 'warehouse_name', 'warehouse_code', 'chamber_limit'],
  daily_chamber_temp_logs: [
    'box_temp',
    'box_count',
    'shift',
    'warehouse_name',
    'operator_email',
    'client_code',
    'warehouse_code',
  ],
  chamber_client_assignments: ['client_code', 'warehouse_code', 'warehouse_name', 'status'],
  do_operator_activities: ['permission_req', 'remark', 'do_action_completed_at'],
};

(async () => {
  const c = await mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: Number(process.env.DB_PORT) || 3306,
  });

  let ok = true;
  for (const [table, cols] of Object.entries(REQUIRED)) {
    const [rows] = await c.query(`SHOW COLUMNS FROM \`${table}\``);
    const have = new Set(rows.map((r) => r.Field));
    const missing = cols.filter((col) => !have.has(col));
    if (missing.length) {
      ok = false;
      console.log(`MISSING ${table}: ${missing.join(', ')}`);
    } else {
      console.log(`OK ${table}`);
    }
  }

  const [locks] = await c.query(
    'SELECT email, role, failed_count, locked_until FROM login_security WHERE locked_until IS NOT NULL AND locked_until > NOW()'
  );
  if (locks.length) {
    console.log('\nLocked accounts:');
    locks.forEach((r) => console.log(`  ${r.email} (${r.role}) until ${r.locked_until}`));
  } else {
    console.log('\nNo locked login accounts.');
  }

  const [users] = await c.query(`
    SELECT email, 'super_admin' AS role FROM super_admin
    UNION SELECT email, 'sub_admin' FROM sub_admins
    UNION SELECT email, 'customer' FROM customers
    UNION SELECT email, 'do_operator' FROM do_operators
  `);
  console.log('\nLogin accounts in DB:');
  users.forEach((u) => console.log(`  ${u.role}: ${u.email}`));

  await c.end();
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
