const express = require('express');
const pool = require('../db/pool');
const { validateTrip } = require('../services/geofence');
const router = express.Router();

// POST /api/trips/validate - Validate a trip without creating it
router.post('/validate', async (req, res) => {
  try {
    const { pickup_lat, pickup_lng, dest_lat, dest_lng, service_type } = req.body;

    if (!pickup_lat || !pickup_lng || !dest_lat || !dest_lng) {
      return res.status(400).json({ error: 'pickup_lat, pickup_lng, dest_lat, dest_lng are required' });
    }

    const result = await validateTrip(
      parseFloat(pickup_lat), parseFloat(pickup_lng),
      parseFloat(dest_lat), parseFloat(dest_lng),
      service_type || 'ride'
    );

    res.json(result);
  } catch (err) {
    console.error('Error validating trip:', err);
    res.status(500).json({ error: 'Failed to validate trip' });
  }
});

// POST /api/trips - Create a trip request
router.post('/', async (req, res) => {
  try {
    const { pickup_lat, pickup_lng, dest_lat, dest_lng, service_type,
            customer_name, customer_phone } = req.body;

    if (!pickup_lat || !pickup_lng || !dest_lat || !dest_lng) {
      return res.status(400).json({ error: 'pickup and destination coordinates required' });
    }

    // Validate first
    const validation = await validateTrip(
      parseFloat(pickup_lat), parseFloat(pickup_lng),
      parseFloat(dest_lat), parseFloat(dest_lng),
      service_type || 'ride'
    );

    if (validation.status === 'rejected') {
      return res.status(403).json({
        error: 'Trip not allowed',
        reason: validation.reason,
        details: validation.details
      });
    }

    // Create the trip request
    const result = await pool.query(`
      INSERT INTO trip_requests (service_type, pickup_lat, pickup_lng, destination_lat, destination_lng,
                                 pickup_zone_id, destination_zone_id, status, customer_name, customer_phone,
                                 rejection_reason)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING *
    `, [
      service_type || 'ride',
      parseFloat(pickup_lat), parseFloat(pickup_lng),
      parseFloat(dest_lat), parseFloat(dest_lng),
      validation.details.pickup_zone_id || null,
      validation.details.destination_zone_id || null,
      validation.status,
      customer_name || null,
      customer_phone || null,
      validation.status !== 'approved' ? validation.reason : null
    ]);

    res.status(201).json({
      trip: result.rows[0],
      validation
    });
  } catch (err) {
    console.error('Error creating trip:', err);
    res.status(500).json({ error: 'Failed to create trip' });
  }
});

// GET /api/trips - List trip requests
router.get('/', async (req, res) => {
  try {
    const { status, limit = 50 } = req.query;
    let query = `
      SELECT tr.*, d.full_name as driver_name, d.phone as driver_phone, d.vehicle_type
      FROM trip_requests tr
      LEFT JOIN drivers d ON tr.driver_id = d.id
    `;
    const params = [];

    if (status) {
      params.push(status);
      query += ` WHERE tr.status = $${params.length}`;
    }

    query += ` ORDER BY tr.created_at DESC LIMIT $${params.length + 1}`;
    params.push(parseInt(limit));

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching trips:', err);
    res.status(500).json({ error: 'Failed to fetch trips' });
  }
});

// PATCH /api/trips/:id/approve - Approve a manual_review trip
router.patch('/:id/approve', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(`
      UPDATE trip_requests SET status = 'approved', updated_at = NOW()
      WHERE id = $1 AND status = 'manual_review'
      RETURNING *
    `, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Trip not found or not pending review' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to approve trip' });
  }
});

// PATCH /api/trips/:id/reject
router.patch('/:id/reject', async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;
    const result = await pool.query(`
      UPDATE trip_requests SET status = 'rejected', rejection_reason = $2, updated_at = NOW()
      WHERE id = $1 AND status = 'manual_review'
      RETURNING *
    `, [id, reason || 'Rejected by operator']);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Trip not found or not pending review' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to reject trip' });
  }
});

module.exports = router;
