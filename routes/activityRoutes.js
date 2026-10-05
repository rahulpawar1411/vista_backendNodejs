// ====================================================================
// Activity audit — mounted at /api/operator-activities
// --------------------------------------------------------------------
// GET  / — paginated activity/security/system logs (Super Admin / Sub-Admin)
// POST / — record an activity row (from app or system)
// ====================================================================

const express = require('express');
const router = express.Router();
const activityController = require('../controllers/activityController');
const { requireRole } = require('../middleware/auth');

router.get('/', requireRole(['super_admin', 'sub_admin']), activityController.getActivityLogs);
router.post('/', activityController.createActivityLog);

module.exports = router;
