// ====================================================================
// Authentication Routes — mounted at /api/auth
// --------------------------------------------------------------------
// POST   /login              — email/password login (returns JWT)
// POST   /logout             — clear session cookie
// GET    /me                 — current user profile (needs token)
// POST   /verify-profile-access — Super Admin secure window check
// POST   /change-password    — Super Admin password change
// POST   /push-token         — save Expo push token (Sub-Admin / DO)
// DELETE /push-token         — remove Expo push token
// ====================================================================

const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const { verifyToken, requireRole } = require('../middleware/auth');

// 1. PUBLIC ENDPOINTS
router.post('/login', authController.login);
router.post('/logout', authController.logout);

// 2. PROTECTED ENDPOINTS (Session Profile Check)
router.get('/me', verifyToken, authController.getMe);
router.post(
  '/verify-profile-access',
  verifyToken,
  requireRole(['super_admin']),
  authController.verifySuperAdminProfileAccess
);
router.post(
  '/change-password',
  verifyToken,
  requireRole(['super_admin']),
  authController.changeSuperAdminPassword
);

// Sub-Admin Expo push token (permission alerts when app is closed)
router.post('/push-token', verifyToken, requireRole(['sub_admin', 'do_operator']), authController.registerPushToken);
router.delete('/push-token', verifyToken, requireRole(['sub_admin', 'do_operator']), authController.clearPushToken);

module.exports = router;
