// ====================================================================
// Outward Routes — mounted at /api/outward-logs
// --------------------------------------------------------------------
// GET    /              — list outward loading logs
// POST   /              — create log + photos
// PUT    /:id           — update log
// PUT    /:id/pod-photo — POD photo only
// DELETE /:id           — delete log
// ====================================================================

const express = require('express');
const router = express.Router();
const { createUploader } = require('../config/multer');
const controller = require('../controllers/outwardController');

const upload = createUploader('outward_images', 'outward');

// Define multi-field uploads layout
const uploadFields = upload.fields([
  { name: 'outward_invoice_photos', maxCount: 10 }, 
  { name: 'outward_pod_photo', maxCount: 1 },
  { name: 'outward_vehicle_seal_photo', maxCount: 1 },
  { name: 'outward_vehicle_temp_photo', maxCount: 1 },
  { name: 'outward_pre_vehicle_temp_photo', maxCount: 1 },
  { name: 'outward_material_temp_photo', maxCount: 1 },
  { name: 'outward_vehicle_back_side_photo', maxCount: 1 },
  { name: 'outward_vehicle_back_side_photo_with_material', maxCount: 1 },
  { name: 'outward_count_sheet_photo', maxCount: 10 },
  { name: 'outward_damage_boxes_photo', maxCount: 10 }
]);

router.get('/', controller.getOutwardLogs);
router.post('/', uploadFields, controller.addOutwardLog);
router.put('/:id', uploadFields, controller.updateOutwardLog);
router.put(
  '/:id/pod-photo',
  upload.single('outward_pod_photo'),
  controller.updateOutwardPodPhoto
);
router.delete('/:id', controller.deleteOutwardLog);

module.exports = router;
