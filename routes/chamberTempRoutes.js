// ====================================================================
// Chamber temp logs — mounted at /api/chamber-temp
// --------------------------------------------------------------------
// GET    /       — list daily chamber box temperature logs
// POST   /       — create log + sensor photo upload
// PUT    /:id    — update log
// DELETE /:id    — delete log
// ====================================================================

const express = require('express');
const router = express.Router();
const { createUploader } = require('../config/multer');
const controller = require('../controllers/chamberTempController');

const upload = createUploader('daily_temp_monitor_images', 'sensor-temp');

router.get('/', controller.getChamberLogs);
router.post('/', upload.single('temp_sensor_image'), controller.addChamberLog);
router.put('/:id', upload.single('temp_sensor_image'), controller.updateChamberLog);
router.delete('/:id', controller.deleteChamberLog);

module.exports = router;
