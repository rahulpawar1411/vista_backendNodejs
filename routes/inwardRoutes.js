// ====================================================================
// Inward Routes — mounted at /api/inward-logs
// --------------------------------------------------------------------
// GET    /              — list inward unloading logs (paginated)
// POST   /              — create log + photo uploads
// PUT    /:id           — update log (may need permission)
// PUT    /:id/pod-photo — replace POD photo only
// DELETE /:id           — delete log (may need permission)
// ====================================================================

const express = require('express');
const router = express.Router();
const { createUploader } = require('../config/multer');
const controller = require('../controllers/inwardController');

const upload = createUploader('inward_images', 'inward');

// Define multi-field uploads layout
const uploadFields = upload.fields([
  { name: 'inward_invoice_photos', maxCount: 10 }, 
  { name: 'inward_pod_photo', maxCount: 1 },
  { name: 'inward_vehicle_seal_photo', maxCount: 1 },
  { name: 'inward_vehicle_temp_photo', maxCount: 1 },
  { name: 'inward_material_temp_photo', maxCount: 1 },
  { name: 'inward_vehicle_back_side_photo', maxCount: 1 },
  { name: 'inward_vehicle_back_side_photo_with_material', maxCount: 1 },
  { name: 'inward_count_sheet_photo', maxCount: 10 },
  { name: 'inward_damage_boxes_photo', maxCount: 10 }
]);

router.get('/', controller.getInwardLogs);
router.post('/', uploadFields, controller.addInwardLog);
router.put('/:id', uploadFields, controller.updateInwardLog);
// POD-only (no full-edit permission). PUT for broad client/proxy support.
router.put(
  '/:id/pod-photo',
  upload.single('inward_pod_photo'),
  controller.updateInwardPodPhoto
);
router.delete('/:id', controller.deleteInwardLog);

module.exports = router;
