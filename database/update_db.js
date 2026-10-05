// ====================================================================
// One-off DB setup script (database/update_db.js)
// Creates inward/outward tables and seeds demo data on older installs.
// Run: node database/update_db.js
// ====================================================================

const db = require('../config/db');
const bcrypt = require('bcryptjs');

async function run() {
  try {
    // 1. Create inward table if not exists with all required fields
    await db.query(`
      CREATE TABLE IF NOT EXISTS inward_temp_logs (
        inward_id INT AUTO_INCREMENT PRIMARY KEY,
        inward_entry_date DATE NOT NULL,
        inward_vehicle_no VARCHAR(50) NOT NULL,
        inward_seal_no VARCHAR(100) DEFAULT NULL,
        inward_vehicle_temp DECIMAL(5,2) DEFAULT NULL,
        inward_material_temp DECIMAL(5,2) DEFAULT NULL,
        inward_transporter_name VARCHAR(150) DEFAULT NULL,
        inward_driver_name VARCHAR(150) DEFAULT NULL,
        inward_driver_no VARCHAR(50) DEFAULT NULL,
        inward_client_name VARCHAR(150) NOT NULL,
        inward_dock_no VARCHAR(50) DEFAULT NULL,
        inward_vehicle_reporting_time VARCHAR(50) DEFAULT NULL,
        inward_unloading_start_time VARCHAR(50) DEFAULT NULL,
        inward_unloading_duration_hours VARCHAR(50) DEFAULT NULL,
        inward_unloading_duration_mins VARCHAR(50) DEFAULT NULL,
        inward_unloading_end_time VARCHAR(50) DEFAULT NULL,
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
        inward_invoice_photos VARCHAR(255) DEFAULT NULL,
        inward_pod_photo VARCHAR(255) DEFAULT NULL,
        inward_vehicle_seal_photo VARCHAR(255) DEFAULT NULL,
        inward_vehicle_temp_photo VARCHAR(255) DEFAULT NULL,
        inward_material_temp_photo VARCHAR(255) DEFAULT NULL,
        inward_vehicle_back_side_photo VARCHAR(255) DEFAULT NULL,
        inward_vehicle_back_side_photo_with_material VARCHAR(255) DEFAULT NULL,
        inward_damage_boxes_photo TEXT DEFAULT NULL,
        update_details TEXT DEFAULT NULL,
        inward_created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        inward_updated_at TIMESTAMP NULL DEFAULT NULL
      )
    `);
    console.log("✅ inward_temp_logs table verified/created successfully.");

    // Create outward table if not exists with all required fields (loading, outward prefix)
    await db.query(`
      CREATE TABLE IF NOT EXISTS outward_temp_logs (
        outward_id INT AUTO_INCREMENT PRIMARY KEY,
        outward_entry_date DATE NOT NULL,
        outward_vehicle_no VARCHAR(50) NOT NULL,
        outward_seal_no VARCHAR(100) DEFAULT NULL,
        outward_vehicle_temp DECIMAL(5,2) DEFAULT NULL,
        outward_pre_vehicle_temp DECIMAL(5,2) DEFAULT NULL,
        outward_material_temp DECIMAL(5,2) DEFAULT NULL,
        outward_transporter_name VARCHAR(150) DEFAULT NULL,
        outward_driver_name VARCHAR(150) DEFAULT NULL,
        outward_driver_no VARCHAR(50) DEFAULT NULL,
        outward_client_name VARCHAR(150) NOT NULL,
        outward_dock_no VARCHAR(50) DEFAULT NULL,
        outward_vehicle_reporting_time VARCHAR(50) DEFAULT NULL,
        outward_loading_start_time VARCHAR(50) DEFAULT NULL,
        outward_loading_duration_hours VARCHAR(50) DEFAULT NULL,
        outward_loading_duration_mins VARCHAR(50) DEFAULT NULL,
        outward_loading_end_time VARCHAR(50) DEFAULT NULL,
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
        outward_invoice_photos VARCHAR(255) DEFAULT NULL,
        outward_pod_photo VARCHAR(255) DEFAULT NULL,
        outward_vehicle_seal_photo VARCHAR(255) DEFAULT NULL,
        outward_vehicle_temp_photo VARCHAR(255) DEFAULT NULL,
        outward_pre_vehicle_temp_photo VARCHAR(255) DEFAULT NULL,
        outward_material_temp_photo VARCHAR(255) DEFAULT NULL,
        outward_vehicle_back_side_photo VARCHAR(255) DEFAULT NULL,
        outward_vehicle_back_side_photo_with_material VARCHAR(255) DEFAULT NULL,
        outward_damage_boxes_photo TEXT DEFAULT NULL,
        update_details TEXT DEFAULT NULL,
        outward_created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        outward_updated_at TIMESTAMP NULL DEFAULT NULL
      )
    `);
    console.log("✅ outward_temp_logs table verified/created successfully.");

    // 2. Ensure vehicle_temp and material_temp columns exist if the table was previously created without them
    const [columns] = await db.query("SHOW COLUMNS FROM inward_temp_logs");
    const columnNames = columns.map(c => c.Field);
    
    if (!columnNames.includes('vehicle_temp')) {
      await db.query("ALTER TABLE inward_temp_logs ADD COLUMN vehicle_temp DECIMAL(4,1) DEFAULT NULL");
      console.log("➕ Added vehicle_temp column to inward_temp_logs.");
    } else {
      console.log("ℹ️ vehicle_temp column already exists.");
    }
    
    if (!columnNames.includes('material_temp')) {
      await db.query("ALTER TABLE inward_temp_logs ADD COLUMN material_temp DECIMAL(4,1) DEFAULT NULL");
      console.log("➕ Added material_temp column to inward_temp_logs.");
    } else {
      console.log("ℹ️ material_temp column already exists.");
    }

    // 3. Create DO Operators, Super Admin, and Customers tables
    await db.query(`
      CREATE TABLE IF NOT EXISTS do_operators (
        id INT AUTO_INCREMENT PRIMARY KEY,
        email VARCHAR(150) NOT NULL UNIQUE,
        password VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log("✅ do_operators table verified/created successfully.");

    await db.query(`
      CREATE TABLE IF NOT EXISTS super_admin (
        id INT AUTO_INCREMENT PRIMARY KEY,
        email VARCHAR(150) NOT NULL UNIQUE,
        password VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log("✅ super_admin table verified/created successfully.");

    // Rename legacy sub_admins → customers before CREATE (avoid empty customers blocking rename)
    try {
      const [tables] = await db.query(
        `SELECT TABLE_NAME AS name FROM information_schema.TABLES
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('sub_admins', 'customers')`
      );
      const names = new Set(tables.map((t) => t.name));
      if (names.has('sub_admins') && !names.has('customers')) {
        await db.query('RENAME TABLE sub_admins TO customers');
        console.log('↪ Renamed sub_admins → customers');
      }
    } catch (renameErr) {
      console.warn('⚠️ sub_admins rename skipped:', renameErr.message);
    }

    await db.query(`
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
    console.log("✅ customers table verified/created successfully.");

    const [subCols] = await db.query('SHOW COLUMNS FROM customers');
    const subColNames = subCols.map((c) => c.Field);
    const subAlters = [
      { name: 'full_name', sql: 'ALTER TABLE customers ADD COLUMN full_name VARCHAR(150) DEFAULT NULL' },
      { name: 'phone_no', sql: 'ALTER TABLE customers ADD COLUMN phone_no VARCHAR(20) DEFAULT NULL' },
      { name: 'allowed_clients', sql: 'ALTER TABLE customers ADD COLUMN allowed_clients TEXT DEFAULT NULL' },
      { name: 'allowed_warehouses', sql: 'ALTER TABLE customers ADD COLUMN allowed_warehouses TEXT DEFAULT NULL' },
      { name: 'updated_at', sql: 'ALTER TABLE customers ADD COLUMN updated_at TIMESTAMP NULL DEFAULT NULL' }
    ];
    for (const { name, sql } of subAlters) {
      if (!subColNames.includes(name)) {
        await db.query(sql);
        console.log(`➕ Added ${name} column to customers.`);
      }
    }

    // 4. Seed Super Admin only if table is empty (never overwrite existing credentials)
    const salt = await bcrypt.genSalt(10);
    const [superAdmins] = await db.query("SELECT * FROM super_admin");
    if (superAdmins.length === 0) {
      const hashedPass = await bcrypt.hash("admin123", salt);
      await db.query("INSERT INTO super_admin (email, password) VALUES (?, ?)", ["admin@reeferon.com", hashedPass]);
      console.log("🌱 Default Super Admin user seeded (admin@reeferon.com / admin123).");
    }
    // No default Customer / DO Operator seed — create those from Super Admin UI
    
    console.log("🎉 Database schema verification completed successfully!");
    process.exit(0);
  } catch (err) {
    console.error("❌ Error running database migration:", err);
    process.exit(1);
  }
}

run();
