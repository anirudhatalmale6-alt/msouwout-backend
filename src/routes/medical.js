const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { v4: uuidv4 } = require('uuid');

// GET /api/medical/dashboard — Admin dashboard: total fees, DASH vs MsouWout split
router.get('/dashboard', async (req, res) => {
  try {
    const totals = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE medical_protection = true) AS total_protected_rides,
        COALESCE(SUM(medical_fee) FILTER (WHERE medical_protection = true), 0) AS total_medical_fees,
        COALESCE(SUM(dash_fee) FILTER (WHERE medical_protection = true), 0) AS total_dash_fees,
        COALESCE(SUM(msouwout_medical_fee) FILTER (WHERE medical_protection = true), 0) AS total_msouwout_fees
      FROM ride_requests
      WHERE status = 'completed'
    `);

    const monthly = await pool.query(`
      SELECT
        TO_CHAR(completed_at, 'YYYY-MM') AS month,
        COUNT(*) AS rides,
        COALESCE(SUM(medical_fee), 0) AS medical_fees,
        COALESCE(SUM(dash_fee), 0) AS dash_fees,
        COALESCE(SUM(msouwout_medical_fee), 0) AS msouwout_fees
      FROM ride_requests
      WHERE medical_protection = true AND status = 'completed' AND completed_at IS NOT NULL
      GROUP BY TO_CHAR(completed_at, 'YYYY-MM')
      ORDER BY month DESC
      LIMIT 12
    `);

    const claimStats = await pool.query(`
      SELECT
        COUNT(*) AS total_claims,
        COUNT(*) FILTER (WHERE status = 'pending') AS pending_claims,
        COUNT(*) FILTER (WHERE status = 'approved') AS approved_claims,
        COUNT(*) FILTER (WHERE status = 'rejected') AS rejected_claims
      FROM medical_claims
    `);

    res.json({
      summary: {
        total_protected_rides: parseInt(totals.rows[0].total_protected_rides),
        total_medical_fees: parseInt(totals.rows[0].total_medical_fees),
        total_dash_fees: parseInt(totals.rows[0].total_dash_fees),
        total_msouwout_fees: parseInt(totals.rows[0].total_msouwout_fees)
      },
      monthly: monthly.rows,
      claims: {
        total: parseInt(claimStats.rows[0].total_claims),
        pending: parseInt(claimStats.rows[0].pending_claims),
        approved: parseInt(claimStats.rows[0].approved_claims),
        rejected: parseInt(claimStats.rows[0].rejected_claims)
      }
    });
  } catch (err) {
    console.error('Medical dashboard error:', err);
    res.status(500).json({ error: 'Erè sèvè' });
  }
});

// POST /api/medical/claim — File an accident claim
router.post('/claim', async (req, res) => {
  try {
    const { ride_id, description, photos, claimant_name, claimant_phone } = req.body;

    if (!ride_id || !description) {
      return res.status(400).json({ error: 'ride_id ak description obligatwa' });
    }

    // Verify ride exists and had medical protection
    const ride = await pool.query(
      'SELECT id, medical_protection, status FROM ride_requests WHERE id = $1',
      [ride_id]
    );
    if (ride.rows.length === 0) {
      return res.status(404).json({ error: 'Kous pa jwenn' });
    }
    if (!ride.rows[0].medical_protection) {
      return res.status(400).json({ error: 'Kous sa pa gen pwoteksyon medikal DASH' });
    }

    // Check for duplicate claim on same ride
    const existing = await pool.query(
      'SELECT id FROM medical_claims WHERE ride_id = $1',
      [ride_id]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Yon reklamasyon deja egziste pou kous sa' });
    }

    const claimId = uuidv4();
    const photoArray = Array.isArray(photos) ? photos : [];

    const result = await pool.query(
      `INSERT INTO medical_claims (id, ride_id, claimant_name, claimant_phone, description, photos, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending', NOW())
       RETURNING *`,
      [claimId, ride_id, claimant_name || null, claimant_phone || null, description, photoArray]
    );

    res.status(201).json({
      claim: result.rows[0],
      message: 'Reklamasyon medikal anrejistre. DASH ap revize li.'
    });
  } catch (err) {
    console.error('Medical claim error:', err);
    res.status(500).json({ error: 'Erè sèvè' });
  }
});

// GET /api/medical/claims — List claims (with optional status filter)
router.get('/claims', async (req, res) => {
  try {
    const { status, limit } = req.query;
    let query = `
      SELECT mc.*, r.tracking_code, r.customer_name, r.customer_phone,
             r.price, r.medical_fee, r.dash_fee
      FROM medical_claims mc
      JOIN ride_requests r ON mc.ride_id = r.id
    `;
    const params = [];
    if (status) {
      params.push(status);
      query += ' WHERE mc.status = $1';
    }
    query += ' ORDER BY mc.created_at DESC';
    if (limit) {
      params.push(parseInt(limit));
      query += ` LIMIT $${params.length}`;
    }

    const result = await pool.query(query, params);
    res.json({ claims: result.rows, total: result.rows.length });
  } catch (err) {
    console.error('List claims error:', err);
    res.status(500).json({ error: 'Erè sèvè' });
  }
});

// PATCH /api/medical/claims/:id — Update claim status (admin)
router.patch('/claims/:id', async (req, res) => {
  try {
    const { status, admin_note, reviewed_by } = req.body;

    const validStatuses = ['pending', 'reviewing', 'approved', 'rejected'];
    if (!status || !validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Status pa valid. Itilize: pending, reviewing, approved, rejected' });
    }

    const result = await pool.query(
      `UPDATE medical_claims
       SET status = $1, admin_note = $2, reviewed_by = $3, reviewed_at = NOW(), updated_at = NOW()
       WHERE id = $4
       RETURNING *`,
      [status, admin_note || null, reviewed_by || null, req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Reklamasyon pa jwenn' });
    }

    res.json({
      claim: result.rows[0],
      message: `Reklamasyon mete ajou: ${status}`
    });
  } catch (err) {
    console.error('Update claim error:', err);
    res.status(500).json({ error: 'Erè sèvè' });
  }
});

module.exports = router;
