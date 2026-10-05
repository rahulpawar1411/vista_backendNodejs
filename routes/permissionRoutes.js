// ====================================================================
// Permission workflow — mounted at /api/permission-requests
// --------------------------------------------------------------------
// GET    /config              — read DO edit/delete policy toggles
// POST   /config              — Super Admin update policy
// GET    /check               — DO: is this record approved to edit?
// GET    /                    — list requests (all for admin, own for DO)
// GET    /record-history      — approval trail for one log id
// POST   /                    — DO submits edit/delete request
// PUT    /:id                 — Super Admin approve or deny
// PATCH  /:id/complete        — DO marks notification handled
// ====================================================================

const express = require('express');
const router = express.Router();
const permissionController = require('../controllers/permissionController');
const { verifyToken, requireRole } = require('../middleware/auth');

// 1. Get system-wide permissions config settings
router.get('/config', verifyToken, permissionController.getSystemConfig);

// 2. Update system-wide permissions config settings (Super Admin only)
router.post('/config', verifyToken, requireRole(['super_admin']), permissionController.updateSystemConfig);

// 3. Check if permission is approved for a specific record (DO Operator)
router.get('/check', verifyToken, permissionController.checkPermission);

// 4. Get permission requests (All for Super Admin, User-specific for Operator)
router.get('/', verifyToken, permissionController.getPermissionRequests);

// 5. Structured Super Allow / request history for a specific log record
router.get(
  '/record-history',
  verifyToken,
  requireRole(['super_admin', 'customer', 'sub_admin']),
  permissionController.getRecordPermissionHistory
);

// 6. Request edit permission (DO Operator)
router.post('/', verifyToken, permissionController.createPermissionRequest);

// 7. Approve or deny permission request (Super Admin / Sub-Admin)
router.put('/:id', verifyToken, requireRole(['super_admin', 'sub_admin']), permissionController.updatePermissionRequestStatus);

// 8. DO marks notification as handled (Completed section)
router.patch(
  '/:id/complete',
  verifyToken,
  requireRole(['do_operator', 'super_admin']),
  permissionController.markPermissionActionComplete
);

module.exports = router;
