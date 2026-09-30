/**
 * Hide Super Admin / edit-audit metadata from Customer app responses.
 * Operational field values (temps, counts, dates of the log itself) stay intact.
 * Super Admin / Sub-Admin / DO keep full audit fields.
 */

const EDIT_AUDIT_KEYS = [
  'update_details',
  'update_count',
  'remarks',
  'updated_at',
  'inward_updated_at',
  'outward_updated_at'
];

function isCustomerRole(userOrRole) {
  const role =
    typeof userOrRole === 'string'
      ? userOrRole
      : userOrRole?.role || userOrRole?.user_role || '';
  return String(role).toLowerCase() === 'customer';
}

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
