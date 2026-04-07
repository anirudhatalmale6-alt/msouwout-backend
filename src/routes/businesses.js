const express = require('express');
const pool = require('../db/pool');
const router = express.Router();

// POST /api/businesses - Register a new business (public)
router.post('/', async (req, res) => {
  try {
    const { business_name, contact_name, phone, email, business_type,
            address, lat, lng, service_needed, estimated_daily_orders } = req.body;

    if (!business_name || !contact_name || !phone) {
      return res.status(400).json({ error: 'business_name, contact_name, and phone are required' });
    }

    // Check duplicate
    const existing = await pool.query(
      'SELECT id FROM businesses WHERE phone = $1 OR business_name = $2',
      [phone, business_name]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'A business with this name or phone already exists' });
    }

    // Find which zone the business is in
    let zone_id = null;
    if (lat && lng) {
      const zoneResult = await pool.query(`
        SELECT id FROM zones
        WHERE ST_Contains(geometry, ST_SetSRID(ST_MakePoint($1, $2), 4326))
          AND is_active = true AND zone_type = 'green'
        LIMIT 1
      `, [parseFloat(lng), parseFloat(lat)]);
      if (zoneResult.rows.length > 0) zone_id = zoneResult.rows[0].id;
    }

    const result = await pool.query(`
      INSERT INTO businesses (business_name, contact_name, phone, email, business_type,
                             address, lat, lng, preferred_zone_id, service_needed,
                             estimated_daily_orders, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'pending')
      RETURNING id, business_name, contact_name, phone, status, created_at
    `, [
      business_name, contact_name, phone, email || null,
      business_type || 'other', address || null,
      lat ? parseFloat(lat) : null, lng ? parseFloat(lng) : null,
      zone_id, service_needed || 'delivery',
      estimated_daily_orders ? parseInt(estimated_daily_orders) : null
    ]);

    res.status(201).json({
      message: 'Business registration submitted successfully. We will contact you for verification.',
      business: result.rows[0]
    });
  } catch (err) {
    console.error('Error registering business:', err);
    res.status(500).json({ error: 'Failed to register business' });
  }
});

// GET /api/businesses - List businesses (admin)
router.get('/', async (req, res) => {
  try {
    const { status } = req.query;
    let query = `
      SELECT b.*, z.name as zone_name
      FROM businesses b
      LEFT JOIN zones z ON b.preferred_zone_id = z.id
    `;
    const params = [];
    if (status) {
      params.push(status);
      query += ` WHERE b.status = $1`;
    }
    query += ' ORDER BY b.created_at DESC';

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching businesses:', err);
    res.status(500).json({ error: 'Failed to fetch businesses' });
  }
});

// GET /api/businesses/stats
router.get('/stats', async (req, res) => {
  try {
    const result = await pool.query('SELECT status, COUNT(*) as count FROM businesses GROUP BY status');
    const total = await pool.query('SELECT COUNT(*) as total FROM businesses');
    res.json({ total: parseInt(total.rows[0].total), by_status: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// PATCH /api/businesses/:id/approve
router.patch('/:id/approve', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(`
      UPDATE businesses SET status = 'approved', is_active = true,
             reviewed_at = NOW(), reviewed_by = 'admin'
      WHERE id = $1 AND status = 'pending'
      RETURNING id, business_name, status
    `, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Business not found or not pending' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to approve business' });
  }
});

// PATCH /api/businesses/:id/reject
router.patch('/:id/reject', async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;
    const result = await pool.query(`
      UPDATE businesses SET status = 'rejected', is_active = false,
             rejection_reason = $2, reviewed_at = NOW(), reviewed_by = 'admin'
      WHERE id = $1 AND status = 'pending'
      RETURNING id, business_name, status
    `, [id, reason || 'Application rejected']);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Business not found or not pending' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to reject business' });
  }
});

module.exports = router;
