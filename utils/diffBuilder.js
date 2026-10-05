// ====================================================================
// Edit diff text for inward/outward update_details (utils/diffBuilder.js)
// ====================================================================

/**
 * Converts DB values (including Date) to comparable strings for change detection.
 */
function valueToString(val) {
  if (val instanceof Date) {
    const yyyy = val.getFullYear();
    const mm = String(val.getMonth() + 1).padStart(2, '0');
    const dd = String(val.getDate()).padStart(2, '0');
    const hh = String(val.getHours()).padStart(2, '0');
    const min = String(val.getMinutes()).padStart(2, '0');
    const ss = String(val.getSeconds()).padStart(2, '0');
    
    // If it's a pure date without time components, just return the date portion
    if (hh === '00' && min === '00' && ss === '00') {
      return `${yyyy}-${mm}-${dd}`;
    }
    return `${yyyy}-${mm}-${dd} ${hh}:${min}:${ss}`;
  }
  return val === null || val === undefined ? '' : String(val).trim();
}

/**
 * WHAT: Builds "Label: old ➔ new" text for fields that actually changed.
 * WHY: Super Admin audit trail shows what the DO edited without storing full JSON blobs.
 * HOW: Loops fieldMapping; skips unchanged values and numeric formatting noise.
 */
exports.buildDiffString = (current, updated, fieldMapping) => {
  const changes = [];
  
  for (const [col, label] of Object.entries(fieldMapping)) {
    // If field is not specified in updated, it's not being modified
    if (!(col in updated)) {
      continue;
    }
    
    const oldVal = current[col];
    const newVal = updated[col];
    
    const oldStr = valueToString(oldVal);
    const newStr = valueToString(newVal);
    
    // Number checks to ignore formatting noise (e.g. 4.5 vs 4.50)
    const isOldNum = !isNaN(oldStr) && oldStr !== '';
    const isNewNum = !isNaN(newStr) && newStr !== '';
    if (isOldNum && isNewNum) {
      if (parseFloat(oldStr) === parseFloat(newStr)) {
        continue;
      }
    } else if (oldStr === newStr) {
      continue;
    }
    
    const displayOld = oldStr || 'N/A';
    const displayNew = newStr || 'N/A';
    changes.push(`${label}: ${displayOld} ➔ ${displayNew}`);
  }
  
  return changes.join(', ');
};
