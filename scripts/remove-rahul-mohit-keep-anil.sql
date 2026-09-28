-- Remove Rahul (Bhopal) + Mohit sir (Bhiwandi) data only.
-- KEEP Anil sir / Bengaluru / WH-BENGALUR-01 untouched.
-- Chambers 1–6 are shared naming — do NOT delete chambers rows.
--
-- Run (WAMP):
--   C:\wamp64\bin\mysql\mysql8.4.7\bin\mysql.exe -u root reeferon_crm_db < remove-rahul-mohit-keep-anil.sql

START TRANSACTION;

-- Temp / task logs
DELETE FROM daily_chamber_temp_logs
WHERE warehouse_code IN ('WH-BHOPAL-01', 'WH-BHIWANDI-01')
   OR LOWER(IFNULL(warehouse_name, '')) IN ('bhopal', 'bhiwandi')
   OR operator_email IN ('r@r.com', 'mohit@reeferon.com');

DELETE FROM daily_temp_logs
WHERE warehouse_code IN ('WH-BHOPAL-01', 'WH-BHIWANDI-01')
   OR LOWER(IFNULL(warehouse_name, '')) IN ('bhopal', 'bhiwandi')
   OR operator_email IN ('r@r.com', 'mohit@reeferon.com');

-- Inward / outward
DELETE FROM inward_temp_logs
WHERE warehouse_code IN ('WH-BHOPAL-01', 'WH-BHIWANDI-01')
   OR LOWER(IFNULL(warehouse_name, '')) IN ('bhopal', 'bhiwandi')
   OR operator_email IN ('r@r.com', 'mohit@reeferon.com');

DELETE FROM outward_temp_logs
WHERE warehouse_code IN ('WH-BHOPAL-01', 'WH-BHIWANDI-01')
   OR LOWER(IFNULL(warehouse_name, '')) IN ('bhopal', 'bhiwandi')
   OR operator_email IN ('r@r.com', 'mohit@reeferon.com');

-- Assignments + client master for those warehouses only
DELETE FROM chamber_client_assignments
WHERE warehouse_code IN ('WH-BHOPAL-01', 'WH-BHIWANDI-01')
   OR LOWER(IFNULL(warehouse_name, '')) IN ('bhopal', 'bhiwandi');

DELETE FROM client_master
WHERE LOWER(IFNULL(warehouse_name, '')) IN ('bhopal', 'bhiwandi');

-- Operator activity + login + accounts (not Anil)
DELETE FROM do_operator_activities
WHERE operator_email IN ('r@r.com', 'mohit@reeferon.com');

DELETE FROM login_security
WHERE email IN ('r@r.com', 'mohit@reeferon.com');

DELETE FROM do_operators
WHERE email IN ('r@r.com', 'mohit@reeferon.com');

-- Warehouses (not Bengaluru)
DELETE FROM warehouse_master
WHERE warehouse_code IN ('WH-BHOPAL-01', 'WH-BHIWANDI-01')
   OR LOWER(warehouse_name) IN ('bhopal', 'bhiwandi');

-- Sanity checks (should show Anil only + zero leftovers)
SELECT email, full_name, warehouse_name, warehouse_code FROM do_operators;
SELECT warehouse_code, warehouse_name FROM warehouse_master;
SELECT COUNT(*) AS leftover_target_daily
FROM daily_chamber_temp_logs
WHERE operator_email IN ('r@r.com', 'mohit@reeferon.com')
   OR warehouse_code IN ('WH-BHOPAL-01', 'WH-BHIWANDI-01');
SELECT COUNT(*) AS anil_daily_kept
FROM daily_chamber_temp_logs
WHERE warehouse_code = 'WH-BENGALUR-01' OR operator_email = 'anil@reeferon.com';

COMMIT;
