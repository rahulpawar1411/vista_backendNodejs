// ====================================================================
// Chambers — mounted at /api/chambers
// --------------------------------------------------------------------
// GET    /                    — list chambers
// POST   /                    — create chamber
// PUT    /:id                 — update chamber
// DELETE /:id                 — delete chamber
// GET    /assignments         — chamber ↔ client assignments
// POST   /assignments         — add assignment
// DELETE /assignments         — remove assignment
// GET    /inspections         — list daily inspections
// POST   /inspections         — add inspection (+ photo)
// DELETE /inspections/:id     — delete inspection
// ====================================================================

const express = require('express');
const router = express.Router();
const { createUploader } = require('../config/multer');
const controller = require('../controllers/chamberController');

const upload = createUploader('daily_temp_monitor_images', 'sensor-temp');

// Define Chamber and Client assignment routes
router.get('/', controller.getChambers);
router.post('/', controller.createChamber);
router.get('/assignments', controller.getAssignments);
router.post('/assignments', controller.addAssignment);
router.delete('/assignments', controller.deleteAssignment);
router.put('/:id', controller.updateChamber);
router.delete('/:id', controller.deleteChamber);
router.post('/inspections', upload.single('sensor_photo'), controller.addInspection);
router.get('/inspections', controller.getInspections);
router.delete('/inspections/:id', controller.deleteInspection);

module.exports = router;
