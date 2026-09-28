// ====================================================================
// Database Connection Configuration (config/db.js)
// Uses mysql2 connection pooling for safe, high-performance DB queries.
// ====================================================================

const mysql = require('mysql2/promise');
const dotenv = require('dotenv');
const { backfillMasterData } = require('../utils/masterBackfill');

dotenv.config();

function isRunningOnRailway() {
  return Boolean(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_ENVIRONMENT_NAME);
}

/** Private Railway hostname only works inside Railway. Laptop uses DB_HOST. */
function usableDatabaseUrl() {
  const url = String(process.env.DATABASE_URL || '').trim();
  if (!url) return '';
  if (!isRunningOnRailway() && /railway\.internal/i.test(url)) {
    console.warn(
      '⚠️ Ignoring DATABASE_URL (mysql.railway.internal). Laptop uses DB_HOST public proxy.'
    );
    return '';
  }
  return url;
}

function describeDbTarget() {
  const url = usableDatabaseUrl();
  if (url) {
    try {
      const u = new URL(url.replace(/^mysql2?:\/\//i, 'http://'));
      const name = (u.pathname || '/railway').replace(/^\//, '').split('?')[0] || 'railway';
      const host = u.hostname || '';
      const kind = /railway\.internal/i.test(host)
        ? 'railway-internal'
        : /proxy\.rlwy\.net/i.test(host)
          ? 'railway-public'
          : 'url';
      return { host, port: u.port || '3306', name, kind };
    } catch (_) {
      return { host: 'DATABASE_URL', port: '', name: 'railway', kind: 'url' };
    }
  }
  const host = String(process.env.DB_HOST || 'localhost');
  const kind = /proxy\.rlwy\.net/i.test(host)
    ? 'railway-public'
    : /railway\.internal/i.test(host)
      ? 'railway-internal'
      : /localhost|127\.0\.0\.1/i.test(host)
        ? 'wamp-local'
        : 'custom';
  return {
    host,
    port: String(process.env.DB_PORT || 3306),
    name: process.env.DB_NAME || 'reeferon_crm_db',
    kind
  };
}

const dbTarget = describeDbTarget();
const dbHostHint = `${dbTarget.host} ${usableDatabaseUrl()}`.toLowerCase();
const isFreeSqlHost =
  dbHostHint.includes('freesqldatabase') || dbHostHint.includes('sql12.freesqldatabase');

if (dbTarget.kind === 'railway-internal' && !isRunningOnRailway()) {
  console.warn(
    '⚠️ mysql.railway.internal only works on Railway. Laptop must use *.proxy.rlwy.net'
  );
}

const poolOptions = {
  waitForConnections: true,
  // FreeSQL free tier often allows only 1–2 connections total across ALL clients
  connectionLimit: Number(process.env.DB_POOL_LIMIT) || (isFreeSqlHost ? 1 : 8),
  queueLimit: 50,
  connectTimeout: 15000,
  maxIdle: isFreeSqlHost ? 1 : 4,
  idleTimeout: 20000,
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000,
  timezone: '+05:30',
  dateStrings: true
};

console.log(
  `[SERVER] MySQL ${dbTarget.kind} ${dbTarget.host}:${dbTarget.port}/${dbTarget.name}` +
    `${isFreeSqlHost ? ' (FreeSQL safe)' : ''}`
);

function createMysqlPool() {
  const databaseUrl = usableDatabaseUrl();
  try {
    if (databaseUrl) {
      return mysql.createPool({ uri: databaseUrl, ...poolOptions });
    }
  } catch (urlErr) {
    console.warn('⚠️ DATABASE_URL invalid, falling back to DB_HOST:', urlErr.message);
  }
  return mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'reeferon_crm_db',
    port: process.env.DB_PORT || 3306,
    ...poolOptions
  });
}

const pool = createMysqlPool();

// Ensure connections are released even if callers forget (pool.query already does)
pool.on('connection', (connection) => {
  // pool 'connection' event gives the raw (non-promise) connection
  connection.query("SET time_zone = '+05:30'", () => {});
});

// Helper function to test DB connection when backend starts
async function testDbConnection() {
  try {
    // Use pool.query only (no held getConnection) so FreeSQL connection slots stay free
    await pool.query('SELECT 1');
    console.log('✅ Connected to MySQL Database:', dbTarget.name, `(${dbTarget.kind})`);

    // Fresh DB bootstrap: core auth + inward/outward log tables (must exist before ALTER migrations)
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS super_admin (
          id INT AUTO_INCREMENT PRIMARY KEY,
          email VARCHAR(150) NOT NULL,
          password VARCHAR(255) NOT NULL,
          full_name VARCHAR(150) DEFAULT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE KEY uq_super_admin_email (email)
        )
      `);
      console.log('🌱 Verified super_admin table is online.');
      const [existingAdmins] = await pool.query('SELECT id FROM super_admin LIMIT 1');
      if (existingAdmins.length === 0) {
        const bcrypt = require('bcryptjs');
        const hashedPass = await bcrypt.hash('admin123', 10);
        await pool.query(
          'INSERT INTO super_admin (email, password, full_name) VALUES (?, ?, ?)',
          ['admin@reeferon.com', hashedPass, 'Super Admin']
        );
        console.log('🌱 Default Super Admin seeded (admin@reeferon.com / admin123).');
      }
    } catch (superErr) {
      console.warn('⚠️ Table super_admin creation failed:', superErr.message);
    }

    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS do_operators (
          id INT AUTO_INCREMENT PRIMARY KEY,
          email VARCHAR(150) NOT NULL,
          password VARCHAR(255) NOT NULL,
          full_name VARCHAR(150) DEFAULT NULL,
          phone_no VARCHAR(50) DEFAULT NULL,
          warehouse_name VARCHAR(150) DEFAULT NULL,
          warehouse_code VARCHAR(50) DEFAULT NULL,
          chamber_limit INT DEFAULT 4,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE KEY uq_do_operators_email (email)
        )
      `);
      console.log('🌱 Verified do_operators table is online.');
    } catch (doErr) {
      console.warn('⚠️ Table do_operators creation failed:', doErr.message);
    }

    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS inward_temp_logs (
          inward_id INT AUTO_INCREMENT PRIMARY KEY,
          reference_no VARCHAR(50) DEFAULT NULL,
          inward_entry_date DATE NOT NULL,
          inward_vehicle_no VARCHAR(100) NOT NULL,
          inward_seal_no VARCHAR(100) DEFAULT NULL,
          inward_invoice_no VARCHAR(100) DEFAULT NULL,
          inward_mens_power INT DEFAULT NULL,
          inward_vehicle_temp DECIMAL(5,2) DEFAULT NULL,
          inward_material_temp DECIMAL(5,2) DEFAULT NULL,
          inward_transporter_name VARCHAR(150) DEFAULT NULL,
          inward_driver_name VARCHAR(150) DEFAULT NULL,
          inward_driver_no VARCHAR(50) DEFAULT NULL,
          inward_client_name VARCHAR(150) NOT NULL,
          inward_dock_no VARCHAR(50) DEFAULT NULL,
          inward_vehicle_reporting_time VARCHAR(100) DEFAULT NULL,
          inward_unloading_start_time VARCHAR(100) DEFAULT NULL,
          inward_unloading_duration_hours VARCHAR(20) DEFAULT NULL,
          inward_unloading_duration_mins VARCHAR(20) DEFAULT NULL,
          inward_unloading_end_time VARCHAR(100) DEFAULT NULL,
          inward_pallets_in_qty INT DEFAULT 0,
          inward_invoice_qty INT DEFAULT 0,
          inward_received_qty INT DEFAULT 0,
          inward_received_boxes_qty INT DEFAULT 0,
          inward_short_received_boxes_qty INT DEFAULT 0,
          inward_excess_received_boxes_qty INT DEFAULT 0,
          inward_damage_received_boxes_qty INT DEFAULT 0,
          inward_material_type VARCHAR(100) DEFAULT NULL,
          inward_unloading_supervisor_name VARCHAR(150) DEFAULT NULL,
          inward_remarks TEXT DEFAULT NULL,
          inward_invoice_photos TEXT DEFAULT NULL,
          inward_pod_photo VARCHAR(255) DEFAULT NULL,
          inward_vehicle_seal_photo VARCHAR(255) DEFAULT NULL,
          inward_vehicle_temp_photo VARCHAR(255) DEFAULT NULL,
          inward_material_temp_photo VARCHAR(255) DEFAULT NULL,
          inward_vehicle_back_side_photo VARCHAR(255) DEFAULT NULL,
          inward_vehicle_back_side_photo_with_material VARCHAR(255) DEFAULT NULL,
          inward_count_sheet_photo VARCHAR(255) DEFAULT NULL,
          inward_damage_boxes_photo VARCHAR(255) DEFAULT NULL,
          inward_created_at DATETIME DEFAULT NULL,
          inward_updated_at DATETIME DEFAULT NULL,
          warehouse_name VARCHAR(150) DEFAULT NULL,
          warehouse_code VARCHAR(50) DEFAULT NULL,
          inward_client_code VARCHAR(50) DEFAULT NULL,
          operator_email VARCHAR(150) DEFAULT NULL,
          photo_capture_metadata LONGTEXT DEFAULT NULL,
          client_submission_id VARCHAR(80) DEFAULT NULL,
          client_submitted_at VARCHAR(40) DEFAULT NULL,
          update_details TEXT DEFAULT NULL,
          update_count INT NOT NULL DEFAULT 0,
          UNIQUE KEY uk_inward_client_submission (client_submission_id),
          INDEX idx_inward_entry_date (inward_entry_date),
          INDEX idx_inward_client (inward_client_name),
          INDEX idx_inward_warehouse (warehouse_name),
          INDEX idx_inward_ref (reference_no)
        )
      `);
      console.log('🌱 Verified inward_temp_logs table is online.');
    } catch (inwardErr) {
      console.warn('⚠️ Table inward_temp_logs creation failed:', inwardErr.message);
    }

    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS outward_temp_logs (
          outward_id INT AUTO_INCREMENT PRIMARY KEY,
          reference_no VARCHAR(50) DEFAULT NULL,
          outward_entry_date DATE NOT NULL,
          outward_vehicle_no VARCHAR(100) NOT NULL,
          outward_seal_no VARCHAR(100) DEFAULT NULL,
          outward_invoice_no VARCHAR(100) DEFAULT NULL,
          outward_mens_power INT DEFAULT NULL,
          outward_vehicle_temp DECIMAL(5,2) DEFAULT NULL,
          outward_pre_vehicle_temp DECIMAL(5,2) DEFAULT NULL,
          outward_material_temp DECIMAL(5,2) DEFAULT NULL,
          outward_transporter_name VARCHAR(150) DEFAULT NULL,
          outward_driver_name VARCHAR(150) DEFAULT NULL,
          outward_driver_no VARCHAR(50) DEFAULT NULL,
          outward_client_name VARCHAR(150) NOT NULL,
          outward_dock_no VARCHAR(50) DEFAULT NULL,
          outward_vehicle_reporting_time VARCHAR(100) DEFAULT NULL,
          outward_loading_start_time VARCHAR(100) DEFAULT NULL,
          outward_loading_duration_hours VARCHAR(20) DEFAULT NULL,
          outward_loading_duration_mins VARCHAR(20) DEFAULT NULL,
          outward_loading_end_time VARCHAR(100) DEFAULT NULL,
          outward_pallets_in_qty INT DEFAULT 0,
          outward_invoice_qty INT DEFAULT 0,
          outward_received_qty INT DEFAULT 0,
          outward_received_boxes_qty INT DEFAULT 0,
          outward_short_received_boxes_qty INT DEFAULT 0,
          outward_excess_received_boxes_qty INT DEFAULT 0,
          outward_damage_received_boxes_qty INT DEFAULT 0,
          outward_material_type VARCHAR(100) DEFAULT NULL,
          outward_loading_supervisor_name VARCHAR(150) DEFAULT NULL,
          outward_remarks TEXT DEFAULT NULL,
          outward_invoice_photos TEXT DEFAULT NULL,
          outward_pod_photo VARCHAR(255) DEFAULT NULL,
          outward_vehicle_seal_photo VARCHAR(255) DEFAULT NULL,
          outward_vehicle_temp_photo VARCHAR(255) DEFAULT NULL,
          outward_pre_vehicle_temp_photo VARCHAR(255) DEFAULT NULL,
          outward_material_temp_photo VARCHAR(255) DEFAULT NULL,
          outward_vehicle_back_side_photo VARCHAR(255) DEFAULT NULL,
          outward_vehicle_back_side_photo_with_material VARCHAR(255) DEFAULT NULL,
          outward_count_sheet_photo VARCHAR(255) DEFAULT NULL,
          outward_damage_boxes_photo VARCHAR(255) DEFAULT NULL,
          outward_created_at DATETIME DEFAULT NULL,
          outward_updated_at DATETIME DEFAULT NULL,
          warehouse_name VARCHAR(150) DEFAULT NULL,
          warehouse_code VARCHAR(50) DEFAULT NULL,
          outward_client_code VARCHAR(50) DEFAULT NULL,
          operator_email VARCHAR(150) DEFAULT NULL,
          photo_capture_metadata LONGTEXT DEFAULT NULL,
          client_submission_id VARCHAR(80) DEFAULT NULL,
          client_submitted_at VARCHAR(40) DEFAULT NULL,
          update_details TEXT DEFAULT NULL,
          update_count INT NOT NULL DEFAULT 0,
          UNIQUE KEY uk_outward_client_submission (client_submission_id),
          INDEX idx_outward_entry_date (outward_entry_date),
          INDEX idx_outward_client (outward_client_name),
          INDEX idx_outward_warehouse (warehouse_name),
          INDEX idx_outward_ref (reference_no)
        )
      `);
      console.log('🌱 Verified outward_temp_logs table is online.');
    } catch (outwardErr) {
      console.warn('⚠️ Table outward_temp_logs creation failed:', outwardErr.message);
    }

    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS daily_chamber_temp_logs (
          id INT AUTO_INCREMENT PRIMARY KEY,
          entry_date DATE NOT NULL,
          client_name VARCHAR(150) NOT NULL,
          chamber_name VARCHAR(100) NOT NULL,
          chamber_id INT DEFAULT NULL,
          inspection_time VARCHAR(50) NOT NULL,
          box_temp DECIMAL(4,1) NOT NULL,
          monitor_supervisor_name VARCHAR(150) NOT NULL,
          temp_sensor_image VARCHAR(255) DEFAULT NULL,
          photo_capture_time VARCHAR(50) DEFAULT NULL,
          time_variance_minutes INT DEFAULT 0,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP NULL DEFAULT NULL,
          warehouse_name VARCHAR(150) DEFAULT NULL,
          operator_email VARCHAR(150) DEFAULT NULL,
          chamber_type VARCHAR(50) DEFAULT 'Frozen',
          overdue_time VARCHAR(100) DEFAULT 'same day'
        )
      `);
      console.log('🌱 Verified daily_chamber_temp_logs table is online.');
    } catch (chamberErr) {
      console.warn('⚠️ Table daily_chamber_temp_logs creation failed:', chamberErr.message);
    }
    
    // Auto migration: add columns to do_operators table if they don't exist
    try {
      const [columns] = await pool.query('SHOW COLUMNS FROM do_operators');
      const colNames = columns.map(c => c.Field);
      
      if (!colNames.includes('full_name')) {
        await pool.query('ALTER TABLE do_operators ADD COLUMN full_name VARCHAR(150) DEFAULT NULL');
        console.log('🌱 Added column full_name to do_operators.');
      }
      if (!colNames.includes('phone_no')) {
        await pool.query('ALTER TABLE do_operators ADD COLUMN phone_no VARCHAR(50) DEFAULT NULL');
        console.log('🌱 Added column phone_no to do_operators.');
      }
      if (!colNames.includes('warehouse_name')) {
        await pool.query('ALTER TABLE do_operators ADD COLUMN warehouse_name VARCHAR(150) DEFAULT NULL');
        console.log('🌱 Added column warehouse_name to do_operators.');
      }
      if (!colNames.includes('chamber_limit')) {
        await pool.query('ALTER TABLE do_operators ADD COLUMN chamber_limit INT DEFAULT 4');
        console.log('🌱 Added column chamber_limit to do_operators.');
      }
      if (!colNames.includes('warehouse_code')) {
        await pool.query('ALTER TABLE do_operators ADD COLUMN warehouse_code VARCHAR(50) DEFAULT NULL');
        console.log('🌱 Added column warehouse_code to do_operators.');
      }
      if (!colNames.includes('expo_push_token')) {
        await pool.query('ALTER TABLE do_operators ADD COLUMN expo_push_token VARCHAR(255) DEFAULT NULL');
        console.log('🌱 Added column expo_push_token to do_operators.');
      }
    } catch (tblErr) {
      console.warn('⚠️ Table do_operators verification skipped:', tblErr.message);
    }

    // Auto migration: legacy scoped accounts live in `customers`.
    // New mobile full-access Sub-Admins use a separate `sub_admins` table.
    try {
      const [tables] = await pool.query(
        `SELECT TABLE_NAME AS name FROM information_schema.TABLES
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('sub_admins', 'customers', 'app_sub_admins')`
      );
      const names = new Set(tables.map((t) => t.name));

      const subAdminsIsLegacyScoped = async () => {
        if (!names.has('sub_admins')) return false;
        const [cols] = await pool.query('SHOW COLUMNS FROM sub_admins');
        return cols.some((c) => c.Field === 'allowed_clients');
      };

      // Only rename/merge when old scoped sub_admins still exists
      if (names.has('sub_admins') && !names.has('customers') && (await subAdminsIsLegacyScoped())) {
        await pool.query('RENAME TABLE sub_admins TO customers');
        console.log('🌱 Renamed legacy scoped sub_admins → customers.');
        names.delete('sub_admins');
        names.add('customers');
      }

      if (names.has('sub_admins') && names.has('customers') && (await subAdminsIsLegacyScoped())) {
        const candidateCols = [
          'id', 'email', 'password', 'full_name', 'phone_no',
          'allowed_clients', 'allowed_warehouses', 'created_at', 'updated_at'
        ];
        const [custCols] = await pool.query('SHOW COLUMNS FROM customers');
        const [subCols] = await pool.query('SHOW COLUMNS FROM sub_admins');
        const custSet = new Set(custCols.map((c) => c.Field));
        const subSet = new Set(subCols.map((c) => c.Field));
        const shared = candidateCols.filter((c) => custSet.has(c) && subSet.has(c));
        if (shared.length > 0) {
          const colList = shared.map((c) => `\`${c}\``).join(', ');
          const [ins] = await pool.query(
            `INSERT IGNORE INTO customers (${colList}) SELECT ${colList} FROM sub_admins`
          );
          console.log(
            `🌱 Merged legacy sub_admins → customers; inserted ${ins?.affectedRows ?? 0} row(s).`
          );
        }
        await pool.query('DROP TABLE sub_admins');
        console.log('🌱 Dropped legacy scoped sub_admins.');
        names.delete('sub_admins');
      }

      await pool.query(`
        CREATE TABLE IF NOT EXISTS customers (
          id INT AUTO_INCREMENT PRIMARY KEY,
          email VARCHAR(150) NOT NULL UNIQUE,
          password VARCHAR(255) NOT NULL,
          full_name VARCHAR(150) DEFAULT NULL,
          phone_no VARCHAR(20) DEFAULT NULL,
          allowed_clients TEXT DEFAULT NULL,
          allowed_warehouses TEXT DEFAULT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP NULL DEFAULT NULL
        )
      `);

      const [subColumns] = await pool.query('SHOW COLUMNS FROM customers');
      const subColNames = subColumns.map(c => c.Field);

      if (!subColNames.includes('full_name')) {
        await pool.query('ALTER TABLE customers ADD COLUMN full_name VARCHAR(150) DEFAULT NULL');
        console.log('🌱 Added column full_name to customers.');
      }
      if (!subColNames.includes('phone_no')) {
        await pool.query('ALTER TABLE customers ADD COLUMN phone_no VARCHAR(20) DEFAULT NULL');
        console.log('🌱 Added column phone_no to customers.');
      }
      if (!subColNames.includes('allowed_clients')) {
        await pool.query('ALTER TABLE customers ADD COLUMN allowed_clients TEXT DEFAULT NULL');
        console.log('🌱 Added column allowed_clients to customers.');
      }
      if (!subColNames.includes('allowed_warehouses')) {
        await pool.query('ALTER TABLE customers ADD COLUMN allowed_warehouses TEXT DEFAULT NULL');
        console.log('🌱 Added column allowed_warehouses to customers.');
      }
      if (!subColNames.includes('updated_at')) {
        await pool.query('ALTER TABLE customers ADD COLUMN updated_at TIMESTAMP NULL DEFAULT NULL');
        console.log('🌱 Added column updated_at to customers.');
      }

      console.log('🌱 Verified customers table schema.');
    } catch (subErr) {
      console.warn('⚠️ Table customers verification skipped:', subErr.message);
    }

    // Mobile Sub-Admins — dedicated table (NOT customers)
    try {
      const [saTables] = await pool.query(
        `SELECT TABLE_NAME AS name FROM information_schema.TABLES
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('sub_admins', 'app_sub_admins')`
      );
      const saNames = new Set(saTables.map((t) => t.name));

      if (saNames.has('app_sub_admins') && !saNames.has('sub_admins')) {
        await pool.query('RENAME TABLE app_sub_admins TO sub_admins');
        console.log('🌱 Renamed app_sub_admins → sub_admins.');
      } else if (saNames.has('app_sub_admins') && saNames.has('sub_admins')) {
        await pool.query(`
          INSERT IGNORE INTO sub_admins (id, email, password, full_name, phone_no, created_at, updated_at)
          SELECT id, email, password, full_name, phone_no, created_at, updated_at FROM app_sub_admins
        `);
        await pool.query('DROP TABLE app_sub_admins');
        console.log('🌱 Merged app_sub_admins into sub_admins and dropped app_sub_admins.');
      }

      await pool.query(`
        CREATE TABLE IF NOT EXISTS sub_admins (
          id INT AUTO_INCREMENT PRIMARY KEY,
          email VARCHAR(150) NOT NULL UNIQUE,
          password VARCHAR(255) NOT NULL,
          full_name VARCHAR(150) DEFAULT NULL,
          phone_no VARCHAR(20) DEFAULT NULL,
          expo_push_token VARCHAR(255) DEFAULT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP NULL DEFAULT NULL
        )
      `);
      try {
        const [saCols] = await pool.query('SHOW COLUMNS FROM sub_admins');
        const saColNames = saCols.map((c) => c.Field);
        if (!saColNames.includes('expo_push_token')) {
          await pool.query(
            'ALTER TABLE sub_admins ADD COLUMN expo_push_token VARCHAR(255) DEFAULT NULL AFTER phone_no'
          );
          console.log('🌱 Added expo_push_token to sub_admins.');
        }
      } catch (colErr) {
        console.warn('⚠️ sub_admins expo_push_token column check skipped:', colErr.message);
      }
      console.log('🌱 Verified sub_admins table (mobile full-access, separate from customers).');
    } catch (saErr) {
      console.warn('⚠️ Table sub_admins verification skipped:', saErr.message);
    }

    // Checkpoint 1 foundation: Warehouse + Client masters with unique codes
    // Backward-compatible only: existing name-based flows remain unchanged.
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS warehouse_master (
          id INT AUTO_INCREMENT PRIMARY KEY,
          warehouse_code VARCHAR(50) NOT NULL UNIQUE,
          warehouse_name VARCHAR(150) NOT NULL,
          city VARCHAR(100) DEFAULT NULL,
          is_active TINYINT(1) NOT NULL DEFAULT 1,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP NULL DEFAULT NULL,
          INDEX idx_wh_name (warehouse_name),
          INDEX idx_wh_city (city),
          INDEX idx_wh_active (is_active)
        )
      `);

      const [whCols] = await pool.query('SHOW COLUMNS FROM warehouse_master');
      const whColNames = whCols.map((c) => c.Field);
      if (!whColNames.includes('city')) {
        await pool.query('ALTER TABLE warehouse_master ADD COLUMN city VARCHAR(100) DEFAULT NULL AFTER warehouse_name');
        console.log('🌱 Added city to warehouse_master.');
      }
      if (!whColNames.includes('is_active')) {
        await pool.query('ALTER TABLE warehouse_master ADD COLUMN is_active TINYINT(1) NOT NULL DEFAULT 1 AFTER city');
        console.log('🌱 Added is_active to warehouse_master.');
      }
      if (!whColNames.includes('updated_at')) {
        await pool.query('ALTER TABLE warehouse_master ADD COLUMN updated_at TIMESTAMP NULL DEFAULT NULL AFTER created_at');
        console.log('🌱 Added updated_at to warehouse_master.');
      }
      console.log('🌱 Verified warehouse_master table is online.');
    } catch (whErr) {
      console.warn('⚠️ warehouse_master verification skipped:', whErr.message);
    }

    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS client_master (
          id INT AUTO_INCREMENT PRIMARY KEY,
          client_code VARCHAR(50) NOT NULL UNIQUE,
          client_name VARCHAR(150) NOT NULL,
          warehouse_name VARCHAR(150) DEFAULT NULL,
          is_active TINYINT(1) NOT NULL DEFAULT 1,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP NULL DEFAULT NULL,
          INDEX idx_client_name (client_name),
          INDEX idx_client_wh_name (warehouse_name),
          INDEX idx_client_active (is_active)
        )
      `);

      const [clientCols] = await pool.query('SHOW COLUMNS FROM client_master');
      const clientColNames = clientCols.map((c) => c.Field);
      if (!clientColNames.includes('warehouse_name')) {
        await pool.query(
          'ALTER TABLE client_master ADD COLUMN warehouse_name VARCHAR(150) DEFAULT NULL AFTER client_name'
        );
        console.log('🌱 Added warehouse_name to client_master.');
      }
      if (!clientColNames.includes('is_active')) {
        await pool.query('ALTER TABLE client_master ADD COLUMN is_active TINYINT(1) NOT NULL DEFAULT 1 AFTER client_name');
        console.log('🌱 Added is_active to client_master.');
      }
      if (!clientColNames.includes('updated_at')) {
        await pool.query('ALTER TABLE client_master ADD COLUMN updated_at TIMESTAMP NULL DEFAULT NULL AFTER created_at');
        console.log('🌱 Added updated_at to client_master.');
      }
      console.log('🌱 Verified client_master table is online.');
    } catch (clientErr) {
      console.warn('⚠️ client_master verification skipped:', clientErr.message);
    }

    // Auto migration: create daily_temp_logs table if not exists
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS daily_temp_logs (
          id INT AUTO_INCREMENT PRIMARY KEY,
          entry_type VARCHAR(50) NOT NULL,
          container_number VARCHAR(50) NOT NULL,
          client_name VARCHAR(150) NOT NULL,
          cargo_type VARCHAR(100) DEFAULT 'Cold Cargo',
          target_temp DECIMAL(5,2) NOT NULL,
          actual_temp DECIMAL(5,2) NOT NULL,
          temp_variance DECIMAL(5,2) DEFAULT 0.0,
          status VARCHAR(50) DEFAULT 'Normal',
          location_dock VARCHAR(100) DEFAULT 'Bay 1',
          driver_name VARCHAR(100) DEFAULT NULL,
          driver_phone VARCHAR(50) DEFAULT NULL,
          seal_number VARCHAR(100) DEFAULT NULL,
          genset_status VARCHAR(50) DEFAULT 'Running',
          fuel_level VARCHAR(50) DEFAULT '100%',
          operator_name VARCHAR(150) DEFAULT NULL,
          remarks TEXT DEFAULT NULL,
          warehouse_name VARCHAR(150) DEFAULT NULL,
          operator_email VARCHAR(150) DEFAULT NULL,
          recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
      console.log('🌱 Verified daily_temp_logs table is online.');
    } catch (tblErr) {
      console.warn('⚠️ Table daily_temp_logs creation failed:', tblErr.message);
    }

    // Auto migration: add warehouse_name column to log tables if they don't exist
    const logTables = ['daily_chamber_temp_logs', 'inward_temp_logs', 'outward_temp_logs', 'daily_temp_logs'];
    for (const table of logTables) {
      try {
        const [columns] = await pool.query(`SHOW COLUMNS FROM ${table}`);
        const colNames = columns.map(c => c.Field);
        if (!colNames.includes('warehouse_name')) {
          await pool.query(`ALTER TABLE ${table} ADD COLUMN warehouse_name VARCHAR(150) DEFAULT NULL`);
          console.log(`🌱 Added column warehouse_name to ${table}.`);
        }
        if (!colNames.includes('operator_email')) {
          await pool.query(`ALTER TABLE ${table} ADD COLUMN operator_email VARCHAR(150) DEFAULT NULL`);
          console.log(`🌱 Added column operator_email to ${table}.`);
        }
        if (!colNames.includes('update_details') && table !== 'daily_temp_logs') {
          await pool.query(`ALTER TABLE ${table} ADD COLUMN update_details TEXT DEFAULT NULL`);
          console.log(`🌱 Added column update_details to ${table}.`);
        }
        if (!colNames.includes('update_count') && table !== 'daily_temp_logs') {
          await pool.query(`ALTER TABLE ${table} ADD COLUMN update_count INT NOT NULL DEFAULT 0`);
          console.log(`🌱 Added column update_count to ${table}.`);
          // Legacy rows that already have edit history → count at least 1
          await pool.query(
            `UPDATE ${table} SET update_count = 1 WHERE update_details IS NOT NULL AND TRIM(update_details) <> '' AND (update_count IS NULL OR update_count = 0)`
          );
        }
      } catch (tblErr) {
        console.warn(`⚠️ Table ${table} verification skipped or failed:`, tblErr.message);
      }
    }

    // Auto migration: add reference_no column to inward_temp_logs, outward_temp_logs and daily_chamber_temp_logs
    const tablesForRef = ['inward_temp_logs', 'outward_temp_logs', 'daily_chamber_temp_logs'];
    for (const table of tablesForRef) {
      try {
        const [columns] = await pool.query(`SHOW COLUMNS FROM ${table}`);
        const colNames = columns.map(c => c.Field);
        if (!colNames.includes('reference_no')) {
          await pool.query(`ALTER TABLE ${table} ADD COLUMN reference_no VARCHAR(50) DEFAULT NULL`);
          console.log(`🌱 Added column reference_no to ${table}.`);
        }
      } catch (tblErr) {
        console.warn(`⚠️ Table ${table} reference_no verification failed:`, tblErr.message);
      }
    }

    // Backfill existing rows with formatted reference numbers
    try {
      await pool.query(`
        UPDATE inward_temp_logs 
        SET reference_no = CONCAT('RF-IN-26-', LPAD(inward_id, 4, '0')) 
        WHERE reference_no IS NULL
      `);
      console.log('🌱 Populated reference_no for existing inward logs.');
    } catch (err) {
      console.warn('⚠️ Failed to populate reference_no for inward logs:', err.message);
    }

    try {
      await pool.query(`
        UPDATE outward_temp_logs 
        SET reference_no = CONCAT('RF-OUT-26-', LPAD(outward_id, 4, '0')) 
        WHERE reference_no IS NULL
      `);
      console.log('🌱 Populated reference_no for existing outward logs.');
    } catch (err) {
      console.warn('⚠️ Failed to populate reference_no for outward logs:', err.message);
    }

    try {
      await pool.query(`
        UPDATE daily_chamber_temp_logs 
        SET reference_no = CONCAT('RF-CH-26-', LPAD(id, 4, '0')) 
        WHERE reference_no IS NULL
      `);
      console.log('🌱 Populated reference_no for existing daily chamber logs.');
    } catch (err) {
      console.warn('⚠️ Failed to populate reference_no for daily chamber logs:', err.message);
    }

    // Auto migration: add outward_pre_vehicle_temp column to outward_temp_logs if they don't exist
    try {
      const [columns] = await pool.query('SHOW COLUMNS FROM outward_temp_logs');
      const colNames = columns.map(c => c.Field);
      if (!colNames.includes('outward_pre_vehicle_temp')) {
        await pool.query('ALTER TABLE outward_temp_logs ADD COLUMN outward_pre_vehicle_temp DECIMAL(5,2) DEFAULT NULL');
        console.log('🌱 Added column outward_pre_vehicle_temp to outward_temp_logs.');
      }
      if (!colNames.includes('outward_pre_vehicle_temp_photo')) {
        await pool.query('ALTER TABLE outward_temp_logs ADD COLUMN outward_pre_vehicle_temp_photo VARCHAR(255) DEFAULT NULL');
        console.log('🌱 Added column outward_pre_vehicle_temp_photo to outward_temp_logs.');
      }
      if (!colNames.includes('outward_count_sheet_photo')) {
        await pool.query('ALTER TABLE outward_temp_logs ADD COLUMN outward_count_sheet_photo VARCHAR(255) DEFAULT NULL');
        console.log('🌱 Added column outward_count_sheet_photo to outward_temp_logs.');
      }
      if (!colNames.includes('outward_invoice_no')) {
        await pool.query('ALTER TABLE outward_temp_logs ADD COLUMN outward_invoice_no VARCHAR(100) DEFAULT NULL');
        console.log('🌱 Added column outward_invoice_no to outward_temp_logs.');
      }
      if (!colNames.includes('outward_mens_power')) {
        await pool.query('ALTER TABLE outward_temp_logs ADD COLUMN outward_mens_power INT DEFAULT NULL');
        console.log('🌱 Added column outward_mens_power to outward_temp_logs.');
      }
    } catch (tblErr) {
      console.warn('⚠️ Table outward_temp_logs columns verification failed:', tblErr.message);
    }

    // Auto migration: inward count-sheet photo (app list/create expects this column)
    try {
      const [columns] = await pool.query('SHOW COLUMNS FROM inward_temp_logs');
      const colNames = columns.map(c => c.Field);
      if (!colNames.includes('inward_count_sheet_photo')) {
        await pool.query('ALTER TABLE inward_temp_logs ADD COLUMN inward_count_sheet_photo VARCHAR(255) DEFAULT NULL');
        console.log('🌱 Added column inward_count_sheet_photo to inward_temp_logs.');
      }
      if (!colNames.includes('inward_invoice_no')) {
        await pool.query('ALTER TABLE inward_temp_logs ADD COLUMN inward_invoice_no VARCHAR(100) DEFAULT NULL');
        console.log('🌱 Added column inward_invoice_no to inward_temp_logs.');
      }
      if (!colNames.includes('inward_mens_power')) {
        await pool.query('ALTER TABLE inward_temp_logs ADD COLUMN inward_mens_power INT DEFAULT NULL');
        console.log('🌱 Added column inward_mens_power to inward_temp_logs.');
      }
    } catch (tblErr) {
      console.warn('⚠️ Table inward_temp_logs columns verification failed:', tblErr.message);
    }

    // Auto migration: create do_operator_activities table if not exists
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS do_operator_activities (
          id INT AUTO_INCREMENT PRIMARY KEY,
          operator_email VARCHAR(150) NOT NULL,
          action VARCHAR(50) NOT NULL,
          log_type VARCHAR(50) NOT NULL,
          description TEXT DEFAULT NULL,
          remark TEXT DEFAULT NULL,
          permission_req INT DEFAULT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
      console.log('🌱 Verified do_operator_activities table is online.');

      // Check and add permission_req dynamically if table already exists
      const [columns] = await pool.query('SHOW COLUMNS FROM do_operator_activities');
      const colNames = columns.map(c => c.Field);
      if (!colNames.includes('permission_req')) {
        await pool.query('ALTER TABLE do_operator_activities ADD COLUMN permission_req INT DEFAULT NULL');
      }
      if (!colNames.includes('do_action_completed_at')) {
        await pool.query(
          'ALTER TABLE do_operator_activities ADD COLUMN do_action_completed_at TIMESTAMP NULL DEFAULT NULL'
        );
        console.log('🌱 Added column do_action_completed_at to do_operator_activities.');
      }
      if (!colNames.includes('remark')) {
        await pool.query(
          'ALTER TABLE do_operator_activities ADD COLUMN remark TEXT DEFAULT NULL'
        );
        console.log('🌱 Added column remark to do_operator_activities.');
      }

      // Clean up deprecated do_permission_requests table if it exists
      await pool.query('DROP TABLE IF EXISTS do_permission_requests');
      console.log('🌱 Dropped deprecated do_permission_requests table.');
    } catch (actErr) {
      console.warn('⚠️ Table do_operator_activities verification failed:', actErr.message);
    }

    // Auto migration: create leads table if not exists
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS leads (
          id INT AUTO_INCREMENT PRIMARY KEY,
          name VARCHAR(150) NOT NULL,
          company VARCHAR(150) DEFAULT NULL,
          email VARCHAR(100) DEFAULT NULL,
          phone VARCHAR(20) NOT NULL,
          status VARCHAR(50) DEFAULT 'New',
          source VARCHAR(100) DEFAULT 'Direct',
          value DECIMAL(10,2) DEFAULT 0.00,
          notes TEXT DEFAULT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
      console.log('🌱 Verified leads table is online.');
    } catch (leadsErr) {
      console.warn('⚠️ Table leads creation failed:', leadsErr.message);
    }

    // Auto migration: customer issue reports (dedicated table for customer portal)
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS customer_reports (
          id INT AUTO_INCREMENT PRIMARY KEY,
          customer_id INT DEFAULT NULL,
          customer_email VARCHAR(150) NOT NULL,
          customer_name VARCHAR(150) DEFAULT NULL,
          customer_phone VARCHAR(20) DEFAULT NULL,
          allowed_clients TEXT DEFAULT NULL,
          allowed_warehouses TEXT DEFAULT NULL,
          reference_no VARCHAR(100) NOT NULL,
          message TEXT NOT NULL,
          status VARCHAR(50) DEFAULT 'Open',
          reviewed_by_email VARCHAR(150) DEFAULT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP NULL DEFAULT NULL,
          resolved_at TIMESTAMP NULL DEFAULT NULL,
          INDEX idx_customer_reports_ref (reference_no),
          INDEX idx_customer_reports_email (customer_email),
          INDEX idx_customer_reports_status (status),
          INDEX idx_customer_reports_customer_id (customer_id)
        )
      `);

      const [crCols] = await pool.query('SHOW COLUMNS FROM customer_reports');
      const crNames = crCols.map((c) => c.Field);
      const crAlters = [
        ['customer_id', 'ADD COLUMN customer_id INT DEFAULT NULL AFTER id'],
        ['customer_phone', 'ADD COLUMN customer_phone VARCHAR(20) DEFAULT NULL AFTER customer_name'],
        ['allowed_clients', 'ADD COLUMN allowed_clients TEXT DEFAULT NULL AFTER customer_phone'],
        ['allowed_warehouses', 'ADD COLUMN allowed_warehouses TEXT DEFAULT NULL AFTER allowed_clients'],
        ['reviewed_by_email', 'ADD COLUMN reviewed_by_email VARCHAR(150) DEFAULT NULL AFTER status'],
        ['updated_at', 'ADD COLUMN updated_at TIMESTAMP NULL DEFAULT NULL AFTER created_at'],
        ['resolved_at', 'ADD COLUMN resolved_at TIMESTAMP NULL DEFAULT NULL AFTER updated_at']
      ];
      for (const [col, ddl] of crAlters) {
        if (!crNames.includes(col)) {
          await pool.query(`ALTER TABLE customer_reports ${ddl}`);
          console.log(`🌱 Added column ${col} to customer_reports.`);
        }
      }
      console.log('🌱 Verified customer_reports table is online.');
    } catch (reportErr) {
      console.warn('⚠️ Table customer_reports creation failed:', reportErr.message);
    }

    // Auto migration: Super Admin ↔ Customer notes / chat updates
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS customer_admin_notes (
          id INT AUTO_INCREMENT PRIMARY KEY,
          customer_id INT DEFAULT NULL,
          customer_email VARCHAR(150) NOT NULL,
          customer_name VARCHAR(150) DEFAULT NULL,
          author_role VARCHAR(50) NOT NULL,
          author_email VARCHAR(150) NOT NULL,
          author_name VARCHAR(150) DEFAULT NULL,
          message TEXT NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_can_email (customer_email),
          INDEX idx_can_customer_id (customer_id),
          INDEX idx_can_created (created_at)
        )
      `);
      console.log('🌱 Verified customer_admin_notes table is online.');
    } catch (notesErr) {
      console.warn('⚠️ Table customer_admin_notes creation failed:', notesErr.message);
    }

    // daily_chamber_temp_logs — created in fresh-DB bootstrap (before log ALTER migrations)

    // Auto migration: login lockout tracking (5 fails / 1h → 30 min lock)
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS login_security (
          id INT AUTO_INCREMENT PRIMARY KEY,
          email VARCHAR(150) NOT NULL,
          role VARCHAR(50) DEFAULT NULL,
          failed_count INT NOT NULL DEFAULT 0,
          window_started_at DATETIME DEFAULT NULL,
          last_failed_at DATETIME DEFAULT NULL,
          locked_until DATETIME DEFAULT NULL,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          unique key uniq_login_security_email (email)
        )
      `);
      console.log('🌱 Verified login_security table is online.');
    } catch (loginSecErr) {
      console.warn('⚠️ Table login_security creation failed:', loginSecErr.message);
    }

    // Auto migration: Chambers and Client Assignments Daily Task Module
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS chambers (
          id INT AUTO_INCREMENT PRIMARY KEY,
          name VARCHAR(100) NOT NULL UNIQUE,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);
      console.log('🌱 Verified chambers table is online.');

      // Auto-migrate: check and add chamber_type column
      try {
        const [chCols] = await pool.query('SHOW COLUMNS FROM chambers');
        const chColNames = chCols.map((c) => c.Field);
        if (!chColNames.includes('chamber_type')) {
          await pool.query("ALTER TABLE chambers ADD COLUMN chamber_type VARCHAR(50) DEFAULT 'Frozen'");
          console.log('🌱 Added column chamber_type to chambers table.');
        }
        if (!chColNames.includes('warehouse_name')) {
          await pool.query(
            'ALTER TABLE chambers ADD COLUMN warehouse_name VARCHAR(150) DEFAULT NULL AFTER name'
          );
          console.log('🌱 Added column warehouse_name to chambers table.');
        }
      } catch (migrateErr) {
        console.warn('⚠️ chambers table migration failed:', migrateErr.message);
      }

      // total_clients removed — completion = Master Setup client count per chamber
      try {
        const [chCols] = await pool.query('SHOW COLUMNS FROM chambers');
        const chColNames = chCols.map((c) => c.Field);
        if (chColNames.includes('total_clients')) {
          await pool.query('ALTER TABLE chambers DROP COLUMN total_clients');
          console.log('🧹 Dropped column total_clients from chambers.');
        }
      } catch (colErr) {
        console.warn('⚠️ chambers.total_clients drop skipped:', colErr.message);
      }
      // No default chamber seed — keep empty until Super Admin / DO adds real data
    } catch (chErr) {
      console.warn('⚠️ Table chambers creation failed:', chErr.message);
    }

    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS chamber_client_assignments (
          id INT AUTO_INCREMENT PRIMARY KEY,
          chamber_id INT NOT NULL,
          client_name VARCHAR(150) NOT NULL,
          warehouse_name VARCHAR(150) DEFAULT NULL,
          client_code VARCHAR(50) DEFAULT NULL,
          warehouse_code VARCHAR(50) DEFAULT NULL,
          remark TEXT DEFAULT NULL,
          status VARCHAR(50) DEFAULT 'active',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP NULL DEFAULT NULL,
          FOREIGN KEY (chamber_id) REFERENCES chambers(id) ON DELETE CASCADE,
          UNIQUE KEY uq_chamber_client_wh (chamber_id, client_name, warehouse_name),
          INDEX idx_cca_client_code (client_code),
          INDEX idx_cca_warehouse_code (warehouse_code)
        )
      `);
      console.log('🌱 Verified chamber_client_assignments table is online.');

      // Check and add warehouse_name dynamically if table already exists
      const [columns] = await pool.query('SHOW COLUMNS FROM chamber_client_assignments');
      const colNames = columns.map(c => c.Field);
      
      if (!colNames.includes('warehouse_name')) {
        await pool.query('ALTER TABLE chamber_client_assignments ADD COLUMN warehouse_name VARCHAR(150) DEFAULT NULL');
        console.log('🌱 Added column warehouse_name to chamber_client_assignments.');
        
        // Also drop old unique key if it exists
        try {
          await pool.query('ALTER TABLE chamber_client_assignments DROP INDEX uq_chamber_client');
          console.log('🌱 Dropped deprecated unique index uq_chamber_client.');
        } catch (idxErr) {}
        
        // And add new unique constraint
        try {
          await pool.query('ALTER TABLE chamber_client_assignments ADD UNIQUE KEY uq_chamber_client_wh (chamber_id, client_name, warehouse_name)');
          console.log('🌱 Added unique index uq_chamber_client_wh.');
        } catch (idxErr) {}
      }
      
      if (!colNames.includes('chamber_type')) {
        await pool.query("ALTER TABLE chamber_client_assignments ADD COLUMN chamber_type VARCHAR(50) DEFAULT 'Frozen'");
        console.log('🌱 Added column chamber_type to chamber_client_assignments.');
      }

      if (!colNames.includes('remark')) {
        await pool.query('ALTER TABLE chamber_client_assignments ADD COLUMN remark TEXT DEFAULT NULL');
        console.log('🌱 Added column remark to chamber_client_assignments.');
      }

      if (!colNames.includes('status')) {
        await pool.query("ALTER TABLE chamber_client_assignments ADD COLUMN status VARCHAR(50) DEFAULT 'active'");
        console.log('🌱 Added column status to chamber_client_assignments.');
      }

      if (!colNames.includes('updated_at')) {
        await pool.query('ALTER TABLE chamber_client_assignments ADD COLUMN updated_at TIMESTAMP NULL DEFAULT NULL');
        console.log('🌱 Added column updated_at to chamber_client_assignments.');
      }

      if (!colNames.includes('client_code')) {
        await pool.query('ALTER TABLE chamber_client_assignments ADD COLUMN client_code VARCHAR(50) DEFAULT NULL AFTER warehouse_name');
        console.log('🌱 Added column client_code to chamber_client_assignments.');
      }
      if (!colNames.includes('warehouse_code')) {
        await pool.query('ALTER TABLE chamber_client_assignments ADD COLUMN warehouse_code VARCHAR(50) DEFAULT NULL AFTER client_code');
        console.log('🌱 Added column warehouse_code to chamber_client_assignments.');
      }
      try {
        await pool.query('ALTER TABLE chamber_client_assignments ADD UNIQUE KEY uq_chamber_client_wh_codes (chamber_id, client_code, warehouse_code)');
        console.log('🌱 Added unique index uq_chamber_client_wh_codes.');
      } catch (_) {}

      // Backfill code references for legacy assignments by matching master names.
      try {
        await pool.query(`
          UPDATE chamber_client_assignments cca
          JOIN warehouse_master wm
            ON LOWER(TRIM(wm.warehouse_name)) = LOWER(TRIM(COALESCE(cca.warehouse_name, '')))
          SET cca.warehouse_code = wm.warehouse_code
          WHERE (cca.warehouse_code IS NULL OR TRIM(cca.warehouse_code) = '')
        `);
      } catch (_) {}
      try {
        await pool.query(`
          UPDATE chamber_client_assignments cca
          JOIN client_master cm
            ON LOWER(TRIM(cm.client_name)) = LOWER(TRIM(cca.client_name))
           AND LOWER(TRIM(COALESCE(cm.warehouse_name, ''))) = LOWER(TRIM(COALESCE(cca.warehouse_name, '')))
          SET cca.client_code = cm.client_code
          WHERE (cca.client_code IS NULL OR TRIM(cca.client_code) = '')
        `);
      } catch (_) {}
      // No default Amul/HyFun/etc. assignment seed — keep empty for live data only
    } catch (assErr) {
      console.warn('⚠️ Table chamber_client_assignments creation failed:', assErr.message);
    }

    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS do_daily_inspections (
          id INT AUTO_INCREMENT PRIMARY KEY,
          operator_name VARCHAR(150) NOT NULL,
          chamber_id INT NOT NULL,
          client_name VARCHAR(150) NOT NULL,
          entry_date DATE NOT NULL,
          entry_time VARCHAR(50) NOT NULL,
          temperature DECIMAL(5,2) NOT NULL,
          photo_url VARCHAR(255) DEFAULT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (chamber_id) REFERENCES chambers(id) ON DELETE CASCADE,
          UNIQUE KEY uq_date_chamber_client (entry_date, chamber_id, client_name)
        )
      `);
      console.log('🌱 Verified do_daily_inspections table is online.');
    } catch (inspErr) {
      console.warn('⚠️ Table do_daily_inspections creation failed:', inspErr.message);
    }


    // Auto migration: Add is_native to daily_chamber_temp_logs for native logs segregation
    try {
      await pool.query('ALTER TABLE daily_chamber_temp_logs ADD COLUMN is_native INT DEFAULT 0');
      console.log('🌱 Added is_native column to daily_chamber_temp_logs.');
    } catch (colErr) {
      // Ignored if column already exists
    }

    // Auto migration: Add box_count to daily_chamber_temp_logs
    try {
      await pool.query('ALTER TABLE daily_chamber_temp_logs ADD COLUMN box_count INT DEFAULT NULL');
      console.log('🌱 Added box_count column to daily_chamber_temp_logs.');
    } catch (colErr) {
      // Ignored if column already exists
    }

    // Auto migration: Add chamber_type to daily_chamber_temp_logs
    try {
      await pool.query("ALTER TABLE daily_chamber_temp_logs ADD COLUMN chamber_type VARCHAR(50) DEFAULT 'Frozen'");
      console.log('🌱 Added chamber_type column to daily_chamber_temp_logs.');
    } catch (colErr) {
      // Ignored if column already exists
    }

    // Auto migration: Add overdue_time to daily_chamber_temp_logs
    try {
      await pool.query("ALTER TABLE daily_chamber_temp_logs ADD COLUMN overdue_time VARCHAR(100) DEFAULT 'same day'");
      console.log('🌱 Added overdue_time column to daily_chamber_temp_logs.');
    } catch (colErr) {
      // Ignored if column already exists
    }

    // Auto migration: Add warehouse_name to daily_chamber_temp_logs
    try {
      await pool.query('ALTER TABLE daily_chamber_temp_logs ADD COLUMN warehouse_name VARCHAR(150) DEFAULT NULL');
      console.log('🌱 Added warehouse_name column to daily_chamber_temp_logs.');
    } catch (colErr) {
      // Ignored if column already exists
    }

    // Auto migration: Add shift to daily_chamber_temp_logs
    try {
      const [columns] = await pool.query("SHOW COLUMNS FROM daily_chamber_temp_logs LIKE 'shift'");
      if (columns.length === 0) {
        await pool.query("ALTER TABLE daily_chamber_temp_logs ADD COLUMN shift VARCHAR(50) DEFAULT 'Morning'");
        console.log('🌱 Added shift column to daily_chamber_temp_logs.');
      }
      // Backfill empty shift from slot time / created hour
      const [backfill] = await pool.query(`
        UPDATE daily_chamber_temp_logs
        SET shift = CASE
          WHEN inspection_time LIKE '10:00%' OR inspection_time IN ('10:00 AM', '10:00') THEN 'Morning'
          WHEN inspection_time LIKE '16:00%' OR inspection_time LIKE '18:00%'
            OR inspection_time IN ('16:00', '18:00', '04:00 PM', '06:00 PM') THEN 'Evening'
          WHEN HOUR(COALESCE(created_at, updated_at, NOW())) < 14 THEN 'Morning'
          ELSE 'Evening'
        END
        WHERE shift IS NULL OR TRIM(shift) = '' OR LOWER(TRIM(shift)) NOT IN ('morning', 'evening')
      `);
      if (backfill?.affectedRows > 0) {
        console.log(`🌱 Backfilled shift on ${backfill.affectedRows} chamber log(s).`);
      }
    } catch (colErr) {
      console.warn('⚠️ Failed to migrate shift column:', colErr.message);
    }

    // Auto migration: Add remarks to daily_chamber_temp_logs
    try {
      const [columns] = await pool.query("SHOW COLUMNS FROM daily_chamber_temp_logs LIKE 'remarks'");
      if (columns.length === 0) {
        await pool.query("ALTER TABLE daily_chamber_temp_logs ADD COLUMN remarks TEXT DEFAULT NULL");
        console.log('🌱 Added remarks column to daily_chamber_temp_logs.');
      }
    } catch (colErr) {
      console.warn('⚠️ Failed to migrate remarks column:', colErr.message);
    }

    // Auto migration: Rename chamber_temp to box_temp in daily_chamber_temp_logs
    try {
      const [columns] = await pool.query("SHOW COLUMNS FROM daily_chamber_temp_logs LIKE 'chamber_temp'");
      if (columns.length > 0) {
        await pool.query('ALTER TABLE daily_chamber_temp_logs CHANGE COLUMN chamber_temp box_temp DECIMAL(4,1) NOT NULL');
        console.log('🌱 Successfully renamed daily_chamber_temp_logs.chamber_temp to box_temp.');
      }
    } catch (colErr) {
      console.warn('⚠️ Failed to rename chamber_temp column:', colErr.message);
    }

    // Auto migration: Add chamber_id to daily_chamber_temp_logs
    try {
      const [columns] = await pool.query("SHOW COLUMNS FROM daily_chamber_temp_logs LIKE 'chamber_id'");
      if (columns.length === 0) {
        await pool.query('ALTER TABLE daily_chamber_temp_logs ADD COLUMN chamber_id INT DEFAULT NULL');
        console.log('🌱 Added chamber_id column to daily_chamber_temp_logs.');
      }
    } catch (colErr) {
      console.warn('⚠️ Failed to migrate chamber_id column:', colErr.message);
    }

    // Auto migration: photo capture GPS on chamber daily logs
    try {
      const [chamberCols] = await pool.query('SHOW COLUMNS FROM daily_chamber_temp_logs');
      const chamberColNames = chamberCols.map((c) => c.Field);
      if (!chamberColNames.includes('photo_capture_latitude')) {
        await pool.query('ALTER TABLE daily_chamber_temp_logs ADD COLUMN photo_capture_latitude DECIMAL(10,7) DEFAULT NULL');
        console.log('🌱 Added photo_capture_latitude to daily_chamber_temp_logs.');
      }
      if (!chamberColNames.includes('photo_capture_longitude')) {
        await pool.query('ALTER TABLE daily_chamber_temp_logs ADD COLUMN photo_capture_longitude DECIMAL(10,7) DEFAULT NULL');
        console.log('🌱 Added photo_capture_longitude to daily_chamber_temp_logs.');
      }
      if (!chamberColNames.includes('photo_capture_accuracy')) {
        await pool.query('ALTER TABLE daily_chamber_temp_logs ADD COLUMN photo_capture_accuracy DECIMAL(8,2) DEFAULT NULL');
        console.log('🌱 Added photo_capture_accuracy to daily_chamber_temp_logs.');
      }
    } catch (colErr) {
      console.warn('⚠️ Failed to migrate chamber photo GPS columns:', colErr.message);
    }

    // Auto migration: per-photo capture time + GPS JSON on inward/outward logs
    for (const table of ['inward_temp_logs', 'outward_temp_logs']) {
      try {
        const [columns] = await pool.query(`SHOW COLUMNS FROM ${table}`);
        const colNames = columns.map((c) => c.Field);
        if (!colNames.includes('photo_capture_metadata')) {
          await pool.query(`ALTER TABLE ${table} ADD COLUMN photo_capture_metadata LONGTEXT DEFAULT NULL`);
          console.log(`🌱 Added photo_capture_metadata to ${table}.`);
        }
        if (!colNames.includes('client_submission_id')) {
          await pool.query(`ALTER TABLE ${table} ADD COLUMN client_submission_id VARCHAR(80) DEFAULT NULL`);
          console.log(`🌱 Added client_submission_id to ${table}.`);
        }
        if (!colNames.includes('client_submitted_at')) {
          await pool.query(`ALTER TABLE ${table} ADD COLUMN client_submitted_at VARCHAR(40) DEFAULT NULL`);
          console.log(`🌱 Added client_submitted_at to ${table}.`);
        }
        const submissionKey =
          table === 'inward_temp_logs' ? 'uk_inward_client_submission' : 'uk_outward_client_submission';
        try {
          const [idxRows] = await pool.query(`SHOW INDEX FROM ${table} WHERE Key_name = ?`, [submissionKey]);
          if (!idxRows.length) {
            await pool.query(`ALTER TABLE ${table} ADD UNIQUE KEY ${submissionKey} (client_submission_id)`);
            console.log(`🌱 Added unique ${submissionKey} on ${table}.`);
          }
        } catch (idxErr) {
          console.warn(`⚠️ Unique ${submissionKey} skipped:`, idxErr.message);
        }
      } catch (colErr) {
        console.warn(`⚠️ Failed to migrate photo_capture_metadata on ${table}:`, colErr.message);
      }
    }


    // Checkpoint 2: backfill warehouse/client masters from existing name-based data
    try {
      await backfillMasterData(pool);
    } catch (backfillErr) {
      console.warn('⚠️ Master backfill skipped:', backfillErr.message);
    }

    // Checkpoint 5: warehouse_code / client_code on log tables
    const logCodeMigrations = [
      { table: 'daily_chamber_temp_logs', clientCodeCol: 'client_code' },
      { table: 'inward_temp_logs', clientCodeCol: 'inward_client_code' },
      { table: 'outward_temp_logs', clientCodeCol: 'outward_client_code' },
      { table: 'daily_temp_logs', clientCodeCol: 'client_code' }
    ];
    for (const { table, clientCodeCol } of logCodeMigrations) {
      try {
        const [columns] = await pool.query(`SHOW COLUMNS FROM ${table}`);
        const colNames = columns.map((c) => c.Field);
        if (!colNames.includes('warehouse_code')) {
          await pool.query(`ALTER TABLE ${table} ADD COLUMN warehouse_code VARCHAR(50) DEFAULT NULL`);
          console.log(`🌱 Added warehouse_code to ${table}.`);
        }
        if (!colNames.includes(clientCodeCol)) {
          await pool.query(`ALTER TABLE ${table} ADD COLUMN ${clientCodeCol} VARCHAR(50) DEFAULT NULL`);
          console.log(`🌱 Added ${clientCodeCol} to ${table}.`);
        }
      } catch (colErr) {
        console.warn(`⚠️ Failed to add code columns to ${table}:`, colErr.message);
      }
    }

    // Backfill log codes from master tables (idempotent)
    const logCodeBackfills = [
      `UPDATE daily_chamber_temp_logs d
       INNER JOIN warehouse_master wm ON LOWER(TRIM(wm.warehouse_name)) = LOWER(TRIM(d.warehouse_name))
       SET d.warehouse_code = wm.warehouse_code
       WHERE (d.warehouse_code IS NULL OR TRIM(d.warehouse_code) = '')
         AND d.warehouse_name IS NOT NULL AND TRIM(d.warehouse_name) != ''`,
      `UPDATE daily_chamber_temp_logs d
       INNER JOIN client_master cm
         ON LOWER(TRIM(cm.client_name)) = LOWER(TRIM(d.client_name))
        AND LOWER(TRIM(COALESCE(cm.warehouse_name, ''))) = LOWER(TRIM(COALESCE(d.warehouse_name, '')))
       SET d.client_code = cm.client_code
       WHERE (d.client_code IS NULL OR TRIM(d.client_code) = '')
         AND d.client_name IS NOT NULL AND TRIM(d.client_name) != ''`,
      `UPDATE inward_temp_logs d
       INNER JOIN warehouse_master wm ON LOWER(TRIM(wm.warehouse_name)) = LOWER(TRIM(d.warehouse_name))
       SET d.warehouse_code = wm.warehouse_code
       WHERE (d.warehouse_code IS NULL OR TRIM(d.warehouse_code) = '')
         AND d.warehouse_name IS NOT NULL AND TRIM(d.warehouse_name) != ''`,
      `UPDATE inward_temp_logs d
       INNER JOIN client_master cm
         ON LOWER(TRIM(cm.client_name)) = LOWER(TRIM(d.inward_client_name))
        AND LOWER(TRIM(COALESCE(cm.warehouse_name, ''))) = LOWER(TRIM(COALESCE(d.warehouse_name, '')))
       SET d.inward_client_code = cm.client_code
       WHERE (d.inward_client_code IS NULL OR TRIM(d.inward_client_code) = '')
         AND d.inward_client_name IS NOT NULL AND TRIM(d.inward_client_name) != ''`,
      `UPDATE outward_temp_logs d
       INNER JOIN warehouse_master wm ON LOWER(TRIM(wm.warehouse_name)) = LOWER(TRIM(d.warehouse_name))
       SET d.warehouse_code = wm.warehouse_code
       WHERE (d.warehouse_code IS NULL OR TRIM(d.warehouse_code) = '')
         AND d.warehouse_name IS NOT NULL AND TRIM(d.warehouse_name) != ''`,
      `UPDATE outward_temp_logs d
       INNER JOIN client_master cm
         ON LOWER(TRIM(cm.client_name)) = LOWER(TRIM(d.outward_client_name))
        AND LOWER(TRIM(COALESCE(cm.warehouse_name, ''))) = LOWER(TRIM(COALESCE(d.warehouse_name, '')))
       SET d.outward_client_code = cm.client_code
       WHERE (d.outward_client_code IS NULL OR TRIM(d.outward_client_code) = '')
         AND d.outward_client_name IS NOT NULL AND TRIM(d.outward_client_name) != ''`,
      `UPDATE daily_temp_logs d
       INNER JOIN warehouse_master wm ON LOWER(TRIM(wm.warehouse_name)) = LOWER(TRIM(d.warehouse_name))
       SET d.warehouse_code = wm.warehouse_code
       WHERE (d.warehouse_code IS NULL OR TRIM(d.warehouse_code) = '')
         AND d.warehouse_name IS NOT NULL AND TRIM(d.warehouse_name) != ''`,
      `UPDATE daily_temp_logs d
       INNER JOIN client_master cm
         ON LOWER(TRIM(cm.client_name)) = LOWER(TRIM(d.client_name))
        AND LOWER(TRIM(COALESCE(cm.warehouse_name, ''))) = LOWER(TRIM(COALESCE(d.warehouse_name, '')))
       SET d.client_code = cm.client_code
       WHERE (d.client_code IS NULL OR TRIM(d.client_code) = '')
         AND d.client_name IS NOT NULL AND TRIM(d.client_name) != ''`
    ];
    for (const sql of logCodeBackfills) {
      try {
        await pool.query(sql);
      } catch (bfErr) {
        console.warn('⚠️ Log code backfill step skipped:', bfErr.message);
      }
    }
    console.log('🌱 Log table code backfill completed.');

    try {
      await pool.query(`
        UPDATE do_operators d
        INNER JOIN warehouse_master wm ON LOWER(TRIM(wm.warehouse_name)) = LOWER(TRIM(d.warehouse_name))
        SET d.warehouse_code = wm.warehouse_code
        WHERE (d.warehouse_code IS NULL OR TRIM(d.warehouse_code) = '')
          AND d.warehouse_name IS NOT NULL AND TRIM(d.warehouse_name) != ''
      `);
    } catch (opWhErr) {
      console.warn('⚠️ DO warehouse_code backfill skipped:', opWhErr.message);
    }

    // Log successful server startup process
    try {
      await pool.query(
        'INSERT INTO do_operator_activities (operator_email, action, log_type, description) VALUES (?, ?, ?, ?)',
        ['system', 'SERVER_STARTUP', 'SYSTEM', 'ReeferON CRM API Backend server initialized. Database connections, auto-migrations, and table schemas verified successfully.']
      );
    } catch (logErr) {
      console.warn('⚠️ Failed to write server startup log:', logErr.message);
    }
  } catch (error) {
    console.warn('⚠️ Warning: MySQL database connection failed:', error.message);
    console.warn('💡 Tip: FreeSQL max connections exceeded? Restart backend once and wait ~30s, or switch DB_HOST to localhost.');
    pool._dbConnected = false;
    pool._dbLastError = error.message;
  }
}

/** Quick health probe for /api/health (no migrations). */
async function getDbHealth() {
  try {
    await pool.query('SELECT 1');
    pool._dbConnected = true;
    pool._dbLastError = null;
    return { connected: true, ...describeDbTarget() };
  } catch (error) {
    pool._dbConnected = false;
    pool._dbLastError = error.message;
    return { connected: false, error: error.message, ...describeDbTarget() };
  }
}

pool.getDbHealth = getDbHealth;

// Run connection check once when file is required
testDbConnection();

module.exports = pool;
