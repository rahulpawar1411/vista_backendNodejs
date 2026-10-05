// ====================================================================
// Lead Controller (controllers/leadController.js)
// Handles all CRUD business logic for Leads table in reeferon_crm_db
// ====================================================================

const db = require('../config/db');

/**
 * Lists sales leads for the CRM pipeline (newest first).
 * HOW: Optional ?status= and ?search= narrow the MySQL query.
 */
exports.getAllLeads = async (req, res) => {
  try {
    const { status, search } = req.query;
    let sql = 'SELECT * FROM leads WHERE 1=1';
    let params = [];

    // Filter by status if provided in query string
    if (status && status !== 'All') {
      sql += ' AND status = ?';
      params.push(status);
    }

    // Search by name, company, or phone if provided
    if (search) {
      sql += ' AND (name LIKE ? OR company LIKE ? OR phone LIKE ?)';
      const searchPattern = `%${search}%`;
      params.push(searchPattern, searchPattern, searchPattern);
    }

    // Order by newest created lead first
    sql += ' ORDER BY created_at DESC';

    const [rows] = await db.query(sql, params);

    return res.status(200).json({
      success: true,
      count: rows.length,
      data: rows
    });
  } catch (error) {
    console.error('Error fetching leads:', error);
    return res.status(500).json({
      success: false,
      message: 'Server error while fetching leads from database.',
      error: error.message
    });
  }
};

/** Returns one lead row for detail screens. */
exports.getLeadById = async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await db.query('SELECT * FROM leads WHERE id = ?', [id]);

    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: `Lead with ID ${id} not found.`
      });
    }

    return res.status(200).json({
      success: true,
      data: rows[0]
    });
  } catch (error) {
    console.error('Error fetching lead details:', error);
    return res.status(500).json({
      success: false,
      message: 'Server error while fetching lead details.',
      error: error.message
    });
  }
};

/** Adds a prospect to the leads table (name + phone required). */
exports.createLead = async (req, res) => {
  try {
    const { name, company, phone, email, status, source, value, notes } = req.body;

    // Basic Validation: Name and Phone are mandatory
    if (!name || !phone) {
      return res.status(400).json({
        success: false,
        message: 'Lead name and phone number are required fields.'
      });
    }

    const sql = `
      INSERT INTO leads (name, company, phone, email, status, source, value, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `;

    const params = [
      name,
      company || '',
      phone,
      email || '',
      status || 'New',
      source || 'Direct',
      parseFloat(value) || 0.00,
      notes || ''
    ];

    const [result] = await db.query(sql, params);

    return res.status(201).json({
      success: true,
      message: 'New lead added successfully!',
      leadId: result.insertId
    });
  } catch (error) {
    console.error('Error creating lead:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to create new lead in database.',
      error: error.message
    });
  }
};

/** Updates lead status, value, or contact info after follow-up calls. */
exports.updateLead = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, company, phone, email, status, source, value, notes } = req.body;

    const sql = `
      UPDATE leads 
      SET name = ?, company = ?, phone = ?, email = ?, status = ?, source = ?, value = ?, notes = ?
      WHERE id = ?
    `;

    const params = [
      name,
      company,
      phone,
      email,
      status,
      source,
      parseFloat(value) || 0.00,
      notes,
      id
    ];

    const [result] = await db.query(sql, params);

    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        message: `Lead with ID ${id} not found.`
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Lead updated successfully!'
    });
  } catch (error) {
    console.error('Error updating lead:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to update lead details.',
      error: error.message
    });
  }
};

/** Permanently deletes a lead record by id. */
exports.deleteLead = async (req, res) => {
  try {
    const { id } = req.params;
    const [result] = await db.query('DELETE FROM leads WHERE id = ?', [id]);

    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        message: `Lead with ID ${id} not found.`
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Lead deleted successfully.'
    });
  } catch (error) {
    console.error('Error deleting lead:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to delete lead from database.',
      error: error.message
    });
  }
};
