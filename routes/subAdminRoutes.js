// ====================================================================
// Customer portal accounts — mounted at /api/customers
// --------------------------------------------------------------------
// GET    /       — list scoped customers (allowed clients/warehouses)
// POST   /       — create customer login
// PUT    /:id    — update customer + scope
// DELETE /:id    — delete customer
// ====================================================================

const express = require('express');
const router = express.Router();
const subAdminController = require('../controllers/subAdminController');

router.get('/', subAdminController.getSubAdmins);
router.post('/', subAdminController.createSubAdmin);
router.put('/:id', subAdminController.updateSubAdmin);
router.delete('/:id', subAdminController.deleteSubAdmin);

module.exports = router;
