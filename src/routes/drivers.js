const express = require('express');
const pool = require('../db/pool');
const router = express.Router();

// POST /api/drivers - Register a new driver (public)
router.post('/', async (req, res) => {
  try {
    const { full_name, phone, email, vehicle_type, license_plate,
            license_number, preferred_zones, preferred_service } = req.body;

    if (!full_name || !phone || !vehicle_type) {
      return res.status(400).json({ error: 'full_name, phone, and vehicle_type are required' });
    }

    // Check for duplicate phone
    const existing = await pool.query('SELECT id FROM drivers WHERE phone = $1', [phone]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'A driver with this phone number already exists' });
    }

    const result = await pool.query(`
      INSERT INTO drivers (full_name, phone, email, vehicle_type, license_plate,
                          license_number, preferred_zones, preferred_service, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending')
      RETURNING id, full_name, phone, vehicle_type, status, created_at
    `, [
      full_name, phone, email || null, vehicle_type,
      license_plate || null, license_number || null,
      preferred_zones || null, preferred_service || 'both'
    ]);

    res.status(201).json({
      message: 'Driver registration submitted successfully. You will be contacted for verification.',
      driver: result.rows[0]
    });
  } catch (err) {
    console.error('Error registering driver:', err);
    res.status(500).json({ error: 'Failed to register driver' });
  }
});

// GET /api/drivers - List drivers (admin)
router.get('/', async (req, res) => {
  try {
    const { status, verified } = req.query;
    let query = 'SELECT id, full_name, phone, email, vehicle_type, license_plate, license_number, preferred_service, status, is_verified, is_active, created_at, reviewed_at FROM drivers';
    const conditions = [];
    const params = [];

    if (status) {
      params.push(status);
      conditions.push(`status = $${params.length}`);
    }
    if (verified !== undefined) {
      params.push(verified === 'true');
      conditions.push(`is_verified = $${params.length}`);
    }

    if (conditions.length > 0) query += ' WHERE ' + conditions.join(' AND ');
    query += ' ORDER BY created_at DESC';

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching drivers:', err);
    res.status(500).json({ error: 'Failed to fetch drivers' });
  }
});

// GET /api/drivers/stats
router.get('/stats', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT status, COUNT(*) as count FROM drivers GROUP BY status
    `);
    const total = await pool.query('SELECT COUNT(*) as total FROM drivers');
    res.json({ total: parseInt(total.rows[0].total), by_status: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// PATCH /api/drivers/:id/approve
router.patch('/:id/approve', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(`
      UPDATE drivers SET status = 'approved', is_verified = true,
             reviewed_at = NOW(), reviewed_by = 'admin'
      WHERE id = $1 AND status = 'pending'
      RETURNING id, full_name, phone, status, is_verified
    `, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Driver not found or not pending' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to approve driver' });
  }
});

// PATCH /api/drivers/:id/reject
router.patch('/:id/reject', async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;
    const result = await pool.query(`
      UPDATE drivers SET status = 'rejected', is_verified = false,
             rejection_reason = $2, reviewed_at = NOW(), reviewed_by = 'admin'
      WHERE id = $1 AND status = 'pending'
      RETURNING id, full_name, phone, status
    `, [id, reason || 'Application rejected']);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Driver not found or not pending' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to reject driver' });
  }
});

// PATCH /api/drivers/:id/suspend
router.patch('/:id/suspend', async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;
    const result = await pool.query(`
      UPDATE drivers SET status = 'suspended', is_active = false,
             rejection_reason = $2
      WHERE id = $1
      RETURNING id, full_name, status
    `, [id, reason || 'Suspended by admin']);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Driver not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to suspend driver' });
  }
});

module.exports = router;
