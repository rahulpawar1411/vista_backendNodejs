// ====================================================================
// Mobile Sub-Admins — mounted at /api/sub-admins (Super Admin only)
// --------------------------------------------------------------------
// GET    /       — list sub_admins table
// POST   /       — create full-access mobile Sub-Admin
// PUT    /:id    — update profile / password
// DELETE /:id    — delete Sub-Admin
// ====================================================================

const express = require('express');
const router = express.Router();
const appSubAdminController = require('../controllers/appSubAdminController');

router.get('/', appSubAdminController.listSubAdmins);
router.post('/', appSubAdminController.createSubAdmin);
router.put('/:id', appSubAdminController.updateSubAdmin);
router.delete('/:id', appSubAdminController.deleteSubAdmin);

module.exports = router;
