// ====================================================================
// Master catalog — mounted at /api/masters (super_admin, sub_admin)
// --------------------------------------------------------------------
// GET/POST        /warehouses      — list / create warehouse_master
// PUT/DELETE      /warehouses/:id  — update / deactivate warehouse
// GET/POST        /clients         — list / create client_master
// PUT/DELETE      /clients/:id     — update / deactivate client
// (Daily DO tasks use /api/chambers assignments, not this catalog.)
// ====================================================================

const express = require('express');
const router = express.Router();
const masterController = require('../controllers/masterController');

// Warehouses (warehouse_master)
router.get('/warehouses', masterController.listWarehouses);
router.post('/warehouses', masterController.createWarehouse);
router.put('/warehouses/:id', masterController.updateWarehouse);
router.delete('/warehouses/:id', masterController.deleteWarehouse);

// Clients (client_master)
router.get('/clients', masterController.listClients);
router.post('/clients', masterController.createClient);
router.put('/clients/:id', masterController.updateClient);
router.delete('/clients/:id', masterController.deleteClient);

module.exports = router;
