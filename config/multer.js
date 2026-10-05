// ====================================================================
// File upload middleware (config/multer.js)
// Saves photos to Cloudinary or local disk under uploads/crm/<folder>/.
// ====================================================================

const path = require('path');
const fs = require('fs');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const { getUploadFolderPath, ensureUploadFolders, toDbRelPath } = require('../utils/uploadsDir');

ensureUploadFolders();

// Configure Cloudinary (optional — only used when UPLOAD_TO_CLOUDINARY=true)
if (process.env.CLOUDINARY_CLOUD_NAME) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
  });
}

/**
 * Uploads a file buffer directly to Cloudinary using the official SDK.
 * @param {Buffer} buffer - The file buffer in memory
 * @param {string} folder - The destination folder name
 * @param {string} publicId - Generated public ID for the file
 */
const uploadBuffer = (buffer, folder, publicId) => {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder: `crm/${folder}`,
        public_id: publicId,
        resource_type: 'auto'
      },
      (error, result) => {
        if (error) return reject(error);
        resolve(result);
      }
    );
    uploadStream.end(buffer);
  });
};

/**
 * Upload middleware.
 *
 * UPLOAD_TO_CLOUDINARY=true  → Cloudinary only; DB stores https://res.cloudinary.com/...
 * UPLOAD_TO_CLOUDINARY=false → disk only under uploads/crm/<folder>/.
 */
/**
 * Returns multer middleware (single / fields) for one log type folder.
 * HOW: Reads UPLOAD_TO_CLOUDINARY — cloud uploads use memory buffer then SDK stream.
 */
const createUploader = (folderName, filePrefix) => {
  const uploadToCloudinary = process.env.UPLOAD_TO_CLOUDINARY === 'true';

  if (uploadToCloudinary && process.env.CLOUDINARY_CLOUD_NAME) {
    const memoryMulter = multer({ storage: multer.memoryStorage() });

    return {
      single: (fieldName) => {
        const parse = memoryMulter.single(fieldName);
        return (req, res, next) => {
          parse(req, res, async (err) => {
            if (err) return next(err);
            if (!req.file) return next();

            try {
              const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
              const filename = `${filePrefix}-${fieldName}-${uniqueSuffix}`;
              const result = await uploadBuffer(req.file.buffer, folderName, filename);
              req.file.path = result.secure_url;
              req.file.filename = filename;
              next();
            } catch (uploadErr) {
              next(uploadErr);
            }
          });
        };
      },

      fields: (fieldsArray) => {
        const parse = memoryMulter.fields(fieldsArray);
        return (req, res, next) => {
          parse(req, res, async (err) => {
            if (err) return next(err);
            if (!req.files) return next();

            try {
              const uploadPromises = [];
              for (const fieldName of Object.keys(req.files)) {
                const filesList = req.files[fieldName];
                for (let i = 0; i < filesList.length; i++) {
                  const file = filesList[i];
                  const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
                  const filename = `${filePrefix}-${fieldName}-${uniqueSuffix}`;
                  file.filename = filename;
                  uploadPromises.push(
                    uploadBuffer(file.buffer, folderName, filename).then((result) => {
                      file.path = result.secure_url;
                    })
                  );
                }
              }
              await Promise.all(uploadPromises);
              next();
            } catch (uploadErr) {
              next(uploadErr);
            }
          });
        };
      }
    };
  } else {
    // Disk only — Cloudinary layout: uploads/crm/<folder>/<public_id>.jpg
    const uploadDir = getUploadFolderPath(folderName);
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }

    const storage = multer.diskStorage({
      destination: (req, file, cb) => {
        cb(null, uploadDir);
      },
      filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const ext = path.extname(file.originalname) || '.jpg';
        cb(null, `${filePrefix}-${file.fieldname || 'photo'}-${uniqueSuffix}${ext}`);
      }
    });

    const diskMulter = multer({ storage });
    return {
      single: (fieldName) => diskMulter.single(fieldName),
      fields: (fieldsArray) => diskMulter.fields(fieldsArray)
    };
  }
};

/**
 * Helper to get the saved path for database storage.
 * Returns the Cloudinary HTTP URL if uploaded to Cloud,
 * or the local relative path (e.g., uploads/folderName/filename) if stored locally.
 */
const getSavedFilePath = (file, folderName) => {
  if (!file) return null;
  if (file.path && /^https?:\/\//i.test(file.path)) {
    return file.path;
  }
  if (file.filename) {
    const name = String(file.filename);
    if (name.includes('/') || name.startsWith('http')) {
      /* fall through */
    } else {
      return toDbRelPath(folderName, name);
    }
  }
  if (file.path && /^https?:\/\//i.test(file.path)) {
    return file.path;
  }
  if (file.path && !/^https?:\/\//i.test(file.path)) {
    const normalized = String(file.path).replace(/\\/g, '/');
    const idx = normalized.lastIndexOf('/uploads/');
    if (idx >= 0) return normalized.slice(idx + 1);
    if (normalized.includes(`uploads/crm/${folderName}/`) || normalized.includes(`uploads/${folderName}/`)) {
      return normalized.slice(normalized.indexOf('uploads/'));
    }
  }
  return file.filename ? toDbRelPath(folderName, file.filename) : null;
};

module.exports = {
  createUploader,
  getSavedFilePath,
  cloudinary
};
