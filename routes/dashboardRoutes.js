// ====================================================================
// Dashboard Routes — mounted at /api/dashboard (token + role in server.js)
// --------------------------------------------------------------------
// GET /stats, /                     — summary counts
// GET /access-options               — client/warehouse lists for customer scope
// GET /inventory-filter-options     — warehouse → client filter dropdowns
// GET /inventory-reconciliation     — box in/out balance report
// GET /daily-inventory-deltas       — day-by-day box changes
// GET /client-month-box-sheet       — one client monthly export data
// GET /do-task-overview             — DO daily task completion status
// GET /customers                    — portal customer accounts
// GET /do-operators                 — DO list + IO counts
// GET /do-operators/:email/io-counts — inward/outward counts per DO
// ====================================================================

const express = require('express');
const router = express.Router();
const dashboardController = require('../controllers/dashboardController');

// GET /api/dashboard/stats - Fetch aggregated stats
router.get('/stats', dashboardController.getDashboardStats);
router.get('/', dashboardController.getDashboardStats);

// GET /api/dashboard/access-options - Fetch distinct clients & warehouses for customer scope
router.get('/access-options', dashboardController.getAccessScopeOptions);

// GET /api/dashboard/inventory-filter-options - Live warehouse → client lists from DB
router.get('/inventory-filter-options', dashboardController.getInventoryFilterOptions);

// GET /api/dashboard/inventory-reconciliation - Fetch inventory box calculations and discrepancies
router.get('/inventory-reconciliation', dashboardController.getInventoryReconciliation);

// GET /api/dashboard/daily-inventory-deltas - Fetch daily inventory box comparisons (deltas)
router.get('/daily-inventory-deltas', dashboardController.getDailyInventoryDeltas);

// GET /api/dashboard/client-month-box-sheet - 1-month Excel sheet for one client lot
router.get('/client-month-box-sheet', dashboardController.getClientMonthBoxSheet);

// GET /api/dashboard/do-task-overview - Warehouse-wise DO completed / pending / overdue
router.get('/do-task-overview', dashboardController.getDoTaskOverview);

// GET /api/dashboard/customers - Portal customer accounts (customers table)
router.get('/customers', dashboardController.getPortalCustomers);

// GET /api/dashboard/do-operators - Data Operator accounts list
router.get('/do-operators', dashboardController.getDoOperatorsList);

// GET /api/dashboard/do-operator-io-counts?email= - one DO inward/outward totals
router.get('/do-operator-io-counts', dashboardController.getDoOperatorIoCounts);

module.exports = router;
