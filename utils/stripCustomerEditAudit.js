// ====================================================================
// Customer response sanitizer (utils/stripCustomerEditAudit.js)
// ====================================================================

/**
 * Customer API responses must not show Super Admin edit metadata
 * (who updated a log, update time, internal remarks).
 * DO / Sub-Admin / Super Admin still get full fields.
 */

/** Field names we remove only for the customer role. */
const EDIT_AUDIT_KEYS = [
  'update_details',
  'update_count',
  'remarks',
  'updated_at',
  'inward_updated_at',
  'outward_updated_at'
];

/**
 * Returns true when the logged-in user is a Customer.
 * Accepts either a user object from JWT or a plain role string.
 */
function isCustomerRole(userOrRole) {
  const role =
    typeof userOrRole === 'string'
      ? userOrRole
      : userOrRole?.role || userOrRole?.user_role || '';
  return String(role).toLowerCase() === 'customer';
}

/**
 * Removes audit keys from one log row (shallow copy so we do not mutate DB objects).
 */
function stripOne(row) {
  if (!row || typeof row !== 'object') return row;
  const out = { ...row };
  for (const key of EDIT_AUDIT_KEYS) {
    if (Object.prototype.hasOwnProperty.call(out, key)) {
      delete out[key];
    }
  }
  return out;
}

/**
 * Main helper: strip audit fields from a list (or single object) for Customer only.
 * Other roles get the original data unchanged.
 */
function stripCustomerEditAudit(items, userOrRole) {
  if (!isCustomerRole(userOrRole)) return items;
  if (!Array.isArray(items)) return stripOne(items);
  return items.map(stripOne);
}

module.exports = {
  isCustomerRole,
  stripCustomerEditAudit,
  EDIT_AUDIT_KEYS
};
