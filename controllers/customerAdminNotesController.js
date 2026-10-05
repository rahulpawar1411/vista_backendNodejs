// ====================================================================
// Customer Admin Notes Controller
// Super Admin posts notes/updates to a customer (chat-style).
// Customer can read + reply on their own thread.
// Table: customer_admin_notes
// ====================================================================

const db = require('../config/db');
const { logActivity } = require('../utils/logger');
const { handleControllerError } = require('../utils/errorHandler');

/** Finds customer id and display name for note threads (customers table first). */
async function loadCustomerIdentity(email) {
  const clean = String(email || '').trim().toLowerCase();
  if (!clean) return null;
  try {
    const [rows] = await db.query(
      `SELECT id, email, full_name, phone_no
       FROM customers WHERE email = ? LIMIT 1`,
      [clean]
    );
    return rows[0] || null;
  } catch (err) {
    if (err.code === 'ER_NO_SUCH_TABLE') {
      const [rows] = await db.query(
        `SELECT id, email, full_name, phone_no
         FROM sub_admins WHERE email = ? LIMIT 1`,
        [clean]
      );
      return rows[0] || null;
    }
    throw err;
  }
}

/**
 * Chat-style messages for one customer (or all threads for Super Admin).
 * WHY: Customers see updates; Super Admin can search and filter by email.
 */
exports.listNotes = async (req, res) => {
  try {
    const role = req.user?.role;
    if (role !== 'super_admin' && role !== 'customer') {
      return res.status(403).json({ error: 'Access denied.' });
    }

    const conditions = [];
    const params = [];

    if (role === 'customer') {
      const email = String(req.user?.email || '')
        .trim()
        .toLowerCase();
      conditions.push('customer_email = ?');
      params.push(email);
    } else {
      const customerEmail = String(req.query.customer_email || '')
        .trim()
        .toLowerCase();
      const search = String(req.query.search || '').trim();
      if (customerEmail) {
        conditions.push('customer_email = ?');
        params.push(customerEmail);
      }
      if (search) {
        const q = `%${search}%`;
        conditions.push(
          `(customer_email LIKE ? OR customer_name LIKE ? OR message LIKE ? OR author_email LIKE ?)`
        );
        params.push(q, q, q, q);
      }
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const [rows] = await db.query(
      `SELECT id, customer_id, customer_email, customer_name, author_role, author_email,
              author_name, message, created_at
       FROM customer_admin_notes
       ${where}
       ORDER BY created_at ASC, id ASC
       LIMIT 500`,
      params
    );

    return res.status(200).json({ success: true, items: rows || [] });
  } catch (err) {
    return handleControllerError(res, err, {
      checkpoint: 'listCustomerAdminNotes',
      req,
      clientMessage: 'Failed to load notes.'
    });
  }
};

/** Super Admin sidebar: one row per customer with last message preview. */
exports.listThreads = async (req, res) => {
  try {
    if (req.user?.role !== 'super_admin') {
      return res.status(403).json({ error: 'Only Super Admin can list note threads.' });
    }

    const [rows] = await db.query(
      `SELECT n.customer_email, n.customer_name, n.customer_id,
              MAX(n.created_at) AS last_at,
              SUBSTRING_INDEX(GROUP_CONCAT(n.message ORDER BY n.created_at DESC, n.id DESC SEPARATOR '\\n'), '\\n', 1) AS last_message,
              COUNT(*) AS message_count
       FROM customer_admin_notes n
       GROUP BY n.customer_email, n.customer_name, n.customer_id
       ORDER BY last_at DESC
       LIMIT 200`
    );

    return res.status(200).json({ success: true, items: rows || [] });
  } catch (err) {
    return handleControllerError(res, err, {
      checkpoint: 'listCustomerNoteThreads',
      req,
      clientMessage: 'Failed to load note threads.'
    });
  }
};

/**
 * Super Admin sends a note to one customer or broadcasts to every customer.
 * HOW: broadcast=true inserts one row per customer email in customer_admin_notes.
 */
exports.createNote = async (req, res) => {
  try {
    const role = req.user?.role;
    if (role !== 'super_admin') {
      return res.status(403).json({ error: 'Only Super Admin can send notes. Customers can only read updates.' });
    }

    const message = String(req.body.message || '').trim();
    if (!message) {
      return res.status(400).json({ error: 'Please type a note message.' });
    }
    if (message.length > 4000) {
      return res.status(400).json({ error: 'Message is too long (max 4000 characters).' });
    }

    const author_email = String(req.user?.email || '')
      .trim()
      .toLowerCase();
    const author_name = req.user?.full_name || author_email || null;

    const broadcastRaw = req.body.broadcast;
    const broadcast =
      broadcastRaw === true ||
      broadcastRaw === 1 ||
      String(broadcastRaw || '').toLowerCase() === 'true' ||
      String(req.body.customer_email || '')
        .trim()
        .toLowerCase() === 'all';

    // --- Broadcast to all customer accounts ---
    if (broadcast) {
      let customers = [];
      try {
        const [rows] = await db.query(
          `SELECT id, email, full_name FROM customers
           WHERE email IS NOT NULL AND TRIM(email) != ''
           ORDER BY full_name ASC, email ASC`
        );
        customers = rows || [];
      } catch (err) {
        if (err.code === 'ER_NO_SUCH_TABLE') {
          const [rows] = await db.query(
            `SELECT id, email, full_name FROM sub_admins
             WHERE email IS NOT NULL AND TRIM(email) != ''
             ORDER BY full_name ASC, email ASC`
          );
          customers = rows || [];
        } else {
          throw err;
        }
      }

      if (!customers.length) {
        return res.status(404).json({ error: 'No customers found to send this note.' });
      }

      const values = [];
      const placeholders = [];
      for (const c of customers) {
        const email = String(c.email || '')
          .trim()
          .toLowerCase();
        if (!email) continue;
        placeholders.push('(?, ?, ?, ?, ?, ?, ?)');
        values.push(
          c.id || null,
          email,
          c.full_name || email,
          role,
          author_email,
          author_name,
          message
        );
      }

      if (!placeholders.length) {
        return res.status(404).json({ error: 'No valid customer emails found.' });
      }

      const [result] = await db.query(
        `INSERT INTO customer_admin_notes
          (customer_id, customer_email, customer_name, author_role, author_email, author_name, message)
         VALUES ${placeholders.join(', ')}`,
        values
      );

      await logActivity(
        author_email,
        'CUSTOMER_NOTE_BROADCAST',
        'SYSTEM',
        `Super Admin broadcast note to ${placeholders.length} customer(s): ${message.slice(0, 200)}`
      );

      return res.status(201).json({
        success: true,
        broadcast: true,
        count: placeholders.length,
        insertId: result.insertId,
        message: `Note sent to ${placeholders.length} customer(s).`
      });
    }

    const customer_email = String(req.body.customer_email || '')
      .trim()
      .toLowerCase();
    if (!customer_email || customer_email === 'all') {
      return res.status(400).json({ error: 'Select a customer email.' });
    }
    const profile = await loadCustomerIdentity(customer_email);
    if (!profile) {
      return res.status(404).json({ error: 'Customer account not found.' });
    }
    const customer_id = profile.id;
    const customer_name = profile.full_name || customer_email;

    const [result] = await db.query(
      `INSERT INTO customer_admin_notes
        (customer_id, customer_email, customer_name, author_role, author_email, author_name, message)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [customer_id, customer_email, customer_name, role, author_email, author_name, message]
    );

    await logActivity(
      author_email,
      'CUSTOMER_NOTE',
      'SYSTEM',
      `super_admin note #${result.insertId} for ${customer_name || customer_email}: ${message.slice(0, 200)}`
    );

    return res.status(201).json({
      success: true,
      id: result.insertId,
      message: 'Note saved.'
    });
  } catch (err) {
    return handleControllerError(res, err, {
      checkpoint: 'createCustomerAdminNote',
      req,
      clientMessage: 'Failed to save note.'
    });
  }
};

/** Super Admin deletes one note message by id. */
exports.deleteNote = async (req, res) => {
  try {
    if (req.user?.role !== 'super_admin') {
      return res.status(403).json({ error: 'Only Super Admin can delete notes.' });
    }
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: 'Invalid note id.' });
    }
    await db.query('DELETE FROM customer_admin_notes WHERE id = ?', [id]);
    return res.status(200).json({ success: true, message: 'Note deleted.' });
  } catch (err) {
    return handleControllerError(res, err, {
      checkpoint: 'deleteCustomerAdminNote',
      req,
      clientMessage: 'Failed to delete note.'
    });
  }
};
