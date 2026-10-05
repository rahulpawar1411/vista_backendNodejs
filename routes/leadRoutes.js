// ====================================================================
// Sales leads — mounted at /api/leads
// --------------------------------------------------------------------
// GET    /       — all leads (?status, ?search)
// GET    /:id    — one lead
// POST   /       — create lead
// PUT    /:id    — update lead
// DELETE /:id    — delete lead
// ====================================================================

const express = require('express');
const router = express.Router();
const leadController = require('../controllers/leadController');

// GET /api/leads - Fetch all leads (with optional ?status= & ?search=)
router.get('/', leadController.getAllLeads);

// GET /api/leads/:id - Fetch single lead by ID
router.get('/:id', leadController.getLeadById);

// POST /api/leads - Create new lead
router.post('/', leadController.createLead);

// PUT /api/leads/:id - Update existing lead
router.put('/:id', leadController.updateLead);

// DELETE /api/leads/:id - Delete lead
router.delete('/:id', leadController.deleteLead);

module.exports = router;
