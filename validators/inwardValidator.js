// ====================================================================
// Inward log validation — mirrors web InwardMonitor.jsx rules
// ====================================================================

const REQUIRED_FIELDS = [
  ['inward_entry_date', 'Entry Date'],
  ['inward_client_name', 'Client Name'],
  ['inward_dock_no', 'Dock No.'],
  ['inward_material_type', 'Material Type'],
  ['inward_vehicle_no', 'Vehicle No.'],
  ['inward_invoice_no', 'Invoice No.'],
  ['inward_transporter_name', 'Transporter Name'],
  ['inward_driver_name', 'Driver Name'],
  ['inward_driver_no', 'Driver Phone No.'],
  ['inward_vehicle_reporting_time', 'Vehicle Reporting Time'],
  ['inward_unloading_start_time', 'Unloading Start Time'],
  ['inward_unloading_end_time', 'Unloading End Time'],
  ['inward_unloading_duration_hours', 'Unloading Duration Hours'],
  ['inward_unloading_duration_mins', 'Unloading Duration Mins'],
  ['inward_vehicle_temp', 'Vehicle Temp'],
  ['inward_material_temp', 'Material Temp'],
  ['inward_pallets_in_qty', 'Pallets In Qty'],
  ['inward_invoice_qty', 'Invoice Boxes Qty'],
  ['inward_received_boxes_qty', 'Boxes Received Qty'],
  ['inward_unloading_supervisor_name', 'Unloading Supervisor Name'],
];

const PHOTO_RULES = [
  { fileField: 'inward_invoice_photos', recordField: 'inward_invoice_photos', label: 'Invoice Photo', multi: true },
  { fileField: 'inward_vehicle_temp_photo', recordField: 'inward_vehicle_temp_photo', label: 'Vehicle Temp Photo', multi: false },
  { fileField: 'inward_material_temp_photo', recordField: 'inward_material_temp_photo', label: 'Material Temp Photo', multi: false },
  { fileField: 'inward_vehicle_back_side_photo', recordField: 'inward_vehicle_back_side_photo', label: 'Vehicle Back Photo', multi: false },
  { fileField: 'inward_vehicle_back_side_photo_with_material', recordField: 'inward_vehicle_back_side_photo_with_material', label: 'Vehicle Back Photo With Material', multi: false },
  { fileField: 'inward_count_sheet_photo', recordField: 'inward_count_sheet_photo', label: 'Count Sheet Photo', multi: true },
];

/** True when a required form field is empty or whitespace. */
function isBlank(v) {
  return v === null || v === undefined || String(v).trim() === '';
}

/** Converts UI date strings (ISO or DD-MM-YYYY) to YYYY-MM-DD for MySQL. */
function normalizeEntryDate(val) {
  if (val === null || val === undefined || val === '') return null;
  if (val instanceof Date && !Number.isNaN(val.getTime())) {
    const yyyy = val.getFullYear();
    const mm = String(val.getMonth() + 1).padStart(2, '0');
    const dd = String(val.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }

  const s = String(val).trim();
  const isoMatch = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;

  const dmMatch = s.match(/^(\d{2})-(\d{2})-(\d{4})/);
  if (dmMatch) return `${dmMatch[3]}-${dmMatch[2]}-${dmMatch[1]}`;

  const parsed = new Date(s);
  if (!Number.isNaN(parsed.getTime())) {
    const yyyy = parsed.getFullYear();
    const mm = String(parsed.getMonth() + 1).padStart(2, '0');
    const dd = String(parsed.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }

  return null;
}

function cleanTimePart(t) {
  if (!t) return '';
  const s = String(t).trim();
  return s.includes(' ') ? s.split(/\s+/).pop() : s;
}

function extractDateAndTime(timeVal, fallbackEntryDate) {
  if (isBlank(timeVal)) return { date: null, time: null };

  const s = String(timeVal).trim();
  const dmMatch = s.match(/^(\d{2})-(\d{2})-(\d{4})\s+(\d{1,2}:\d{2}(?::\d{2})?)/);
  if (dmMatch) {
    return {
      date: `${dmMatch[3]}-${dmMatch[2]}-${dmMatch[1]}`,
      time: dmMatch[4].slice(0, 5),
    };
  }

  const isoMatch = s.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}:\d{2}(?::\d{2})?)/);
  if (isoMatch) {
    return {
      date: `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`,
      time: isoMatch[4].slice(0, 5),
    };
  }

  const fallbackDate = normalizeEntryDate(fallbackEntryDate);
  return { date: fallbackDate, time: cleanTimePart(s).slice(0, 5) };
}

function buildDateTime(dateStr, timeStr) {
  const date = normalizeEntryDate(dateStr);
  const time = cleanTimePart(timeStr);
  if (!date || !time) return null;

  const normalized = time.length === 5 ? `${time}:00` : time;
  const d = new Date(`${date}T${normalized}`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function getExpectedPhoneDigits(countryCode) {
  if (countryCode === '+91') return 10;
  if (['+971', '+966', '+61'].includes(countryCode)) return 9;
  if (countryCode === '+65') return 8;
  return 10;
}

function validateDriverPhone(driverNo) {
  const s = String(driverNo).trim();
  let countryCode = '+91';
  let digits = s.replace(/\D/g, '');

  const codeMatch = s.match(/^(\+\d{1,3})\s*(.*)$/);
  if (codeMatch) {
    countryCode = codeMatch[1];
    digits = codeMatch[2].replace(/\D/g, '');
  }

  const expectedDigits = getExpectedPhoneDigits(countryCode);
  if (digits.length < expectedDigits) {
    return `Invalid Phone Number: Please enter a valid ${expectedDigits}-digit mobile number for country code ${countryCode}.`;
  }

  return null;
}

function hasUploadedPhoto(files, fileField) {
  return !!(files && files[fileField] && files[fileField].length > 0);
}

function hasStoredPhoto(record, recordField) {
  const val = record ? record[recordField] : null;
  return !isBlank(val);
}

function hasPhoto(files, fileField, record, recordField) {
  return hasUploadedPhoto(files, fileField) || hasStoredPhoto(record, recordField);
}

function resolveReceivedBoxesQty(record) {
  if (!isBlank(record.inward_received_boxes_qty)) return record.inward_received_boxes_qty;
  if (!isBlank(record.inward_received_qty)) return record.inward_received_qty;
  return null;
}

function buildValidationFailure(missing, missingKeys, message) {
  return {
    error: 'Validation failed',
    message: message || 'Please fill all required fields.',
    missing,
    missingKeys,
  };
}

/**
 * Validate inward payload (create or merged update state).
 * @param {object} record - body fields or merged record values
 * @param {object} [options]
 * @param {object} [options.files] - multer files map (create / update with new uploads)
 */
function validateInwardRecord(record, options = {}) {
  const { files = {} } = options;
  const missing = [];
  const missingKeys = [];

  const normalizedRecord = {
    ...record,
    inward_entry_date: normalizeEntryDate(record.inward_entry_date),
    inward_received_boxes_qty: resolveReceivedBoxesQty(record),
  };

  for (const [key, label] of REQUIRED_FIELDS) {
    if (key === 'inward_client_name') {
      const hasClient =
        !isBlank(normalizedRecord.inward_client_name) ||
        !isBlank(normalizedRecord.inward_client_code) ||
        !isBlank(normalizedRecord.client_code);
      if (!hasClient) {
        missingKeys.push(key);
        missing.push(label);
      }
      continue;
    }
    if (isBlank(normalizedRecord[key])) {
      missingKeys.push(key);
      missing.push(label);
    }
  }

  for (const rule of PHOTO_RULES) {
    if (!hasPhoto(files, rule.fileField, normalizedRecord, rule.recordField)) {
      missingKeys.push(rule.fileField);
      missing.push(rule.label);
    }
  }

  const damageQty = parseInt(normalizedRecord.inward_damage_received_boxes_qty, 10) || 0;
  if (damageQty > 0 && !hasPhoto(files, 'inward_damage_boxes_photo', normalizedRecord, 'inward_damage_boxes_photo')) {
    missingKeys.push('inward_damage_boxes_photo');
    missing.push('Damage Boxes Photo');
  }

  if (missing.length > 0) {
    return buildValidationFailure(missing, missingKeys);
  }

  const phoneError = validateDriverPhone(normalizedRecord.inward_driver_no);
  if (phoneError) {
    return buildValidationFailure([phoneError], ['inward_driver_no'], phoneError);
  }

  const entryDate = normalizedRecord.inward_entry_date;
  const startDate =
    normalizeEntryDate(normalizedRecord.inward_unloading_start_date) ||
    extractDateAndTime(normalizedRecord.inward_unloading_start_time, entryDate).date ||
    entryDate;
  const endDate =
    normalizeEntryDate(normalizedRecord.inward_unloading_end_date) ||
    extractDateAndTime(normalizedRecord.inward_unloading_end_time, entryDate).date ||
    entryDate;

  const reportingTime = cleanTimePart(normalizedRecord.inward_vehicle_reporting_time);
  const startTime = extractDateAndTime(normalizedRecord.inward_unloading_start_time, entryDate).time;
  const endTime = extractDateAndTime(normalizedRecord.inward_unloading_end_time, entryDate).time;

  if (entryDate && startDate === entryDate && reportingTime && startTime && startTime <= reportingTime) {
    const message = `Unloading Start Time must be later than Vehicle Reporting Time. Reporting: ${reportingTime}, Start: ${startTime}`;
    return buildValidationFailure([message], ['inward_unloading_start_time'], message);
  }

  const startDateTime = buildDateTime(startDate, startTime);
  const endDateTime = buildDateTime(endDate, endTime);
  if (startDateTime && endDateTime && endDateTime.getTime() <= startDateTime.getTime()) {
    const message =
      startDate === endDate
        ? `Unloading End Time must be later than Unloading Start Time. Start: ${startTime}, End: ${endTime}`
        : 'Unloading End Date/Time must be later than Unloading Start Date/Time.';
    return buildValidationFailure([message], ['inward_unloading_end_time'], message);
  }

  return null;
}

/** Runs full inward rules on a new create payload (body + multer files). */
function validateInwardCreate(data, files = {}) {
  return validateInwardRecord(data, { files });
}

/** Same rules as create, but on merged DB row + update body (edit flow). */
function validateInwardUpdate(mergedRecord, files = {}) {
  return validateInwardRecord(mergedRecord, { files });
}

module.exports = {
  validateInwardCreate,
  validateInwardUpdate,
  validateInwardRecord,
};
