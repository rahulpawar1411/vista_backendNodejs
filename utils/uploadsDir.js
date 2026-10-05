/**
 * Photos on disk use the same layout as Cloudinary public_ids:
 *   Cloudinary:  crm/<folder>/<public_id>
 *   Server:      uploads/crm/<folder>/<public_id>.jpg
 *
 * Later you can upload this tree to Cloudinary (folder crm/<folder>,
 * public_id = filename without extension) and flip UPLOAD_TO_CLOUDINARY=true.
 *
 * Railway: mount a Volume and set UPLOADS_DIR=/data/uploads
 */
const path = require('path');
const fs = require('fs');

const CRM_PREFIX = 'crm';
const UPLOAD_FOLDERS = [
  'inward_images',
  'outward_images',
  'daily_temp_monitor_images',
];

/** Root folder for on-disk photos; UPLOADS_DIR env overrides default backend/uploads. */
function getUploadsRoot() {
  const fromEnv = String(process.env.UPLOADS_DIR || '').trim();
  if (fromEnv) return path.resolve(fromEnv);
  return path.join(__dirname, '..', 'uploads');
}

/** Cloudinary-style folder: uploads/crm/inward_images */
function getUploadFolderPath(folderName) {
  return path.join(getUploadsRoot(), CRM_PREFIX, folderName);
}

/** Older local path without crm/: uploads/inward_images */
function getLegacyUploadFolderPath(folderName) {
  return path.join(getUploadsRoot(), folderName);
}

function toDbRelPath(folderName, filename) {
  return `uploads/${CRM_PREFIX}/${folderName}/${filename}`;
}

/**
 * Creates crm/ and legacy folder trees on disk.
 * WHY: Multer and static /uploads need writable paths before first photo upload.
 */
function ensureUploadFolders() {
  const tryMake = (root) => {
    fs.mkdirSync(root, { recursive: true });
    for (const folder of UPLOAD_FOLDERS) {
      fs.mkdirSync(path.join(root, CRM_PREFIX, folder), { recursive: true });
      fs.mkdirSync(path.join(root, folder), { recursive: true });
    }
    return root;
  };

  try {
    return tryMake(getUploadsRoot());
  } catch (err) {
    const fallback = path.join(require('os').tmpdir(), 'reeferon-uploads');
    console.warn('⚠️ UPLOADS_DIR not writable, using', fallback, '-', err.message);
    process.env.UPLOADS_DIR = fallback;
    return tryMake(fallback);
  }
}

module.exports = {
  CRM_PREFIX,
  UPLOAD_FOLDERS,
  getUploadsRoot,
  getUploadFolderPath,
  getLegacyUploadFolderPath,
  toDbRelPath,
  ensureUploadFolders,
};
