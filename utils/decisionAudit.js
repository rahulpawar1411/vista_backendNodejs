/**
 * Parse permission decision audit fields from activity description text.
 *
 * Decision rows store: "… · Admin remark: … · Decided by: Sub-Admin Name (email)"
 * Used by Super Admin web Role & Permission + Activity columns
 * (decided_by_name / decided_by_email / admin_remark).
 */

function parseDecisionAudit(description, remark = null) {
  const desc = String(description || '');
  const decidedMatch = desc.match(/Decided by:\s*(.+?)\s*$/i);
  const adminRemarkMatch =
    desc.match(/Admin remark:\s*(.+?)(?:\s*·\s*Decided by:|$)/i) ||
    desc.match(/SA remark:\s*(.+?)(?:\s*·\s*Decided by:|$)/i);

  let decided_by = decidedMatch ? String(decidedMatch[1] || '').trim() : null;
  let decided_by_name = null;
  let decided_by_email = null;
  let decided_by_role = null;

  if (decided_by) {
    const labeled = decided_by.match(
      /^(Sub-Admin|Super Admin|Customer|DO Operator)\s*(.*?)\s*\(([^)]+)\)\s*$/i
    );
    if (labeled) {
      decided_by_role = labeled[1];
      decided_by_name = String(labeled[2] || '').trim() || null;
      decided_by_email = String(labeled[3] || '').trim() || null;
    } else {
      const emailOnly = decided_by.match(/\(([^)]+@[^)]+)\)/);
      decided_by_email = emailOnly ? String(emailOnly[1]).trim() : null;
      decided_by_name = decided_by.replace(/\s*\([^)]*\)\s*$/, '').trim() || null;
      if (/sub-?admin/i.test(decided_by)) decided_by_role = 'Sub-Admin';
      else if (/super\s*admin/i.test(decided_by)) decided_by_role = 'Super Admin';
    }
  }

  const fromRemarkCol = remark != null ? String(remark).trim() : '';
  const admin_remark = String(adminRemarkMatch?.[1] || fromRemarkCol || '').trim() || null;

  return {
    decided_by,
    decided_by_name,
    decided_by_email,
    decided_by_role,
    admin_remark
  };
}

/** Adds decided_by_* and admin_remark fields onto one activity row for the admin UI. */
function enrichActivityWithDecisionAudit(row) {
  if (!row) return row;
  const audit = parseDecisionAudit(row.description, row.remark);
  return { ...row, ...audit };
}

module.exports = {
  parseDecisionAudit,
  enrichActivityWithDecisionAudit
};
