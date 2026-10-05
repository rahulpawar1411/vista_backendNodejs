/** Parse optional GPS / photo metadata from multipart or JSON bodies. */

/** Converts GPS or accuracy strings from multipart forms into numbers or null. */
function parseOptionalFloat(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

/** Reads per-photo capture time/GPS JSON from body fields (string or object). */
function parsePhotoCaptureMetadata(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/** Stores metadata object as JSON text for MySQL LONGTEXT columns. */
function serializePhotoCaptureMetadata(meta) {
  if (!meta || typeof meta !== 'object') return null;
  try {
    return JSON.stringify(meta);
  } catch {
    return null;
  }
}

module.exports = {
  parseOptionalFloat,
  parsePhotoCaptureMetadata,
  serializePhotoCaptureMetadata,
};
