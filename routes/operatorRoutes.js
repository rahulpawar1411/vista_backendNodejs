// ====================================================================
// DO operators — mounted at /api/do-operators (Super Admin / Sub-Admin)
// --------------------------------------------------------------------
// GET    /       — list DO accounts + warehouse/chamber_limit
// POST   /       — create DO login
// PUT    /:id    — update DO profile or warehouse
// DELETE /:id    — delete DO account
// ====================================================================

const express = require('express');
const router = express.Router();
const operatorController = require('../controllers/operatorController');

// All endpoints are managed under Super Admin scope in server.js
router.get('/', operatorController.getOperators);
router.post('/', operatorController.createOperator);
router.put('/:id', operatorController.updateOperator);
router.delete('/:id', operatorController.deleteOperator);

module.exports = router;
