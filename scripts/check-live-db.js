// ====================================================================
// Live database probe (scripts/check-live-db.js)
// Tests connection to production/hosted MySQL using .env settings.
// Run: node scripts/check-live-db.js
// ====================================================================

require('dotenv').config();
const mysql = require('mysql2/promise');

(async () => {
  const cfg = {
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME,
    port: Number(process.env.DB_PORT || 3306),
    connectTimeout: 15000,
  };
  console.log('CONNECT_TARGET', cfg.host, cfg.database, 'port', cfg.port);
  const p = await mysql.createConnection(cfg);
  console.log('CONNECTED_OK');

  const requiredTables = [
    'super_admin',
    'do_operators',
    'sub_admins',
    'customers',
    'chambers',
    'chamber_client_assignments',
    'daily_chamber_temp_logs',
    'daily_temp_logs',
    'do_daily_inspections',
    'inward_temp_logs',
    'outward_temp_logs',
    'do_operator_activities',
    'leads',
    'login_security',
    'customer_reports',
    'customer_admin_notes',
  ];
  const [tables] = await p.query('SHOW TABLES');
  const names = tables.map((t) => Object.values(t)[0]);
  console.log('\nTABLES_PRESENT', names.length);
  for (const t of requiredTables) {
    console.log(names.includes(t) ? 'OK_TABLE ' + t : 'MISSING_TABLE ' + t);
  }

  const requiredCols = {
    do_operators: ['email', 'password', 'full_name', 'phone_no', 'warehouse_name', 'chamber_limit'],
    chambers: ['id', 'name', 'chamber_type'],
    chamber_client_assignments: [
      'chamber_id',
      'client_name',
      'warehouse_name',
      'remark',
      'status',
      'chamber_type',
    ],
    daily_chamber_temp_logs: [
      'entry_date',
      'client_name',
      'chamber_name',
      'chamber_id',
      'box_temp',
      'monitor_supervisor_name',
      'temp_sensor_image',
      'warehouse_name',
      'operator_email',
      'shift',
      'reference_no',
      'update_details',
      'update_count',
      'box_count',
      'chamber_type',
      'overdue_time',
      'is_native',
      'remarks',
    ],
    inward_temp_logs: [
      'inward_id',
      'reference_no',
      'inward_entry_date',
      'inward_client_name',
      'inward_pod_photo',
      'inward_count_sheet_photo',
      'warehouse_name',
      'operator_email',
      'update_details',
      'update_count',
    ],
    outward_temp_logs: [
      'outward_id',
      'reference_no',
      'outward_entry_date',
      'outward_client_name',
      'outward_pod_photo',
      'outward_count_sheet_photo',
      'outward_pre_vehicle_temp',
      'outward_pre_vehicle_temp_photo',
      'warehouse_name',
      'operator_email',
      'update_details',
      'update_count',
    ],
  };

  console.log('\nCOLUMN_CHECK');
  for (const [table, cols] of Object.entries(requiredCols)) {
    if (!names.includes(table)) {
      console.log('SKIP ' + table);
      continue;
    }
    const [c] = await p.query('SHOW COLUMNS FROM `' + table + '`');
    const have = new Set(c.map((x) => x.Field));
    const missing = cols.filter((x) => !have.has(x));
    if (missing.length) console.log('MISSING_COLS ' + table + ': ' + missing.join(', '));
    else console.log('OK_COLS ' + table);
  }

  console.log('\nROW_COUNTS');
  for (const t of requiredTables) {
    if (!names.includes(t)) continue;
    const [r] = await p.query('SELECT COUNT(*) AS n FROM `' + t + '`');
    console.log(t + ': ' + r[0].n);
  }

  console.log('\nSAMPLE_OPS');
  const [ops] = await p.query(
    'SELECT id, email, full_name, warehouse_name, chamber_limit FROM do_operators LIMIT 10'
  );
  console.log('DO_OPERATORS', JSON.stringify(ops));
  const [ch] = await p.query('SELECT id, name, chamber_type FROM chambers ORDER BY id LIMIT 20');
  console.log('CHAMBERS', JSON.stringify(ch));
  const [asg] = await p.query(
    "SELECT COUNT(*) n, COUNT(DISTINCT warehouse_name) wh FROM chamber_client_assignments WHERE status IS NULL OR status = 'active'"
  );
  console.log('ACTIVE_ASSIGNMENTS', JSON.stringify(asg[0]));

  const [logsToday] = await p.query(
    'SELECT COUNT(*) n FROM daily_chamber_temp_logs WHERE entry_date = CURDATE()'
  );
  const [logsYday] = await p.query(
    'SELECT COUNT(*) n FROM daily_chamber_temp_logs WHERE entry_date = DATE_SUB(CURDATE(), INTERVAL 1 DAY)'
  );
  const [logs3] = await p.query(
    'SELECT entry_date, COUNT(*) n FROM daily_chamber_temp_logs GROUP BY entry_date ORDER BY entry_date DESC LIMIT 5'
  );
  console.log('LOGS_TODAY', logsToday[0].n, 'LOGS_YDAY', logsYday[0].n);
  console.log('LOGS_BY_DATE', JSON.stringify(logs3));

  const [inw] = await p.query('SELECT COUNT(*) n FROM inward_temp_logs');
  const [outw] = await p.query('SELECT COUNT(*) n FROM outward_temp_logs');
  console.log('INWARD', inw[0].n, 'OUTWARD', outw[0].n);

  console.log('\nSMOKE_QUERIES');
  try {
    await p.query(
      'SELECT outward_id, outward_count_sheet_photo, outward_pod_photo, warehouse_name, operator_email FROM outward_temp_logs LIMIT 1'
    );
    console.log('OK_QUERY outward list columns');
  } catch (e) {
    console.log('FAIL_QUERY outward:', e.message);
  }
  try {
    await p.query(
      'SELECT inward_id, inward_count_sheet_photo, inward_pod_photo, warehouse_name, operator_email FROM inward_temp_logs LIMIT 1'
    );
    console.log('OK_QUERY inward list columns');
  } catch (e) {
    console.log('FAIL_QUERY inward:', e.message);
  }
  try {
    await p.query(
      `SELECT id, entry_date, client_name, chamber_name, chamber_id, box_temp, shift, warehouse_name, operator_email, reference_no
       FROM daily_chamber_temp_logs
       WHERE entry_date >= DATE_SUB(CURDATE(), INTERVAL 2 DAY)
       ORDER BY id DESC LIMIT 5`
    );
    console.log('OK_QUERY chamber-temp pull window');
  } catch (e) {
    console.log('FAIL_QUERY chamber-temp:', e.message);
  }

  await p.end();
  console.log('\nDONE');
})().catch((e) => {
  console.error('FATAL', e.message);
  process.exit(1);
});
