const express = require('express');
const pool = require('../db/pool');
const router = express.Router();

// POST /api/drivers - Register a new driver (public)
router.post('/', async (req, res) => {
  try {
    const { full_name, phone, email, vehicle_type, license_plate,
            license_number, preferred_zones, preferred_service,
            referral_partner, referral_code, syndicate, vehicle_year } = req.body;

    if (!full_name || !phone || !vehicle_type) {
      return res.status(400).json({ error: 'full_name, phone, and vehicle_type are required' });
    }

    // Check for duplicate phone
    const existing = await pool.query('SELECT id FROM drivers WHERE phone = $1', [phone]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'A driver with this phone number already exists' });
    }

    const yearInt = parseInt(vehicle_year, 10);

    const result = await pool.query(`
      INSERT INTO drivers (full_name, phone, email, vehicle_type, license_plate,
                          license_number, preferred_zones, preferred_service,
                          referral_partner, referral_code, syndicate, vehicle_year, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'pending')
      RETURNING id, full_name, phone, vehicle_type, status, created_at
    `, [
      full_name, phone, email || null, vehicle_type,
      license_plate || null, license_number || null,
      preferred_zones || null, preferred_service || 'both',
      referral_partner || null, referral_code || null,
      syndicate || null, Number.isFinite(yearInt) ? yearInt : null
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

// POST /api/drivers/login - Phone-based driver login (public)
router.post('/login', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) {
      return res.status(400).json({ error: 'Phone number is required' });
    }

    const clean = phone.replace(/[^0-9+]/g, '');
    const result = await pool.query(`
      SELECT id, full_name, phone, email, vehicle_type, license_plate,
             preferred_service, status, is_verified, is_active,
             created_at, reviewed_at, rejection_reason
      FROM drivers WHERE phone = $1 OR phone = $2
    `, [clean, phone.trim()]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'No driver found with this phone number' });
    }

    const driver = result.rows[0];

    const rides = await pool.query(`
      SELECT id, ride_type, status, price, driver_earning, pickup_lat, pickup_lng,
             dropoff_lat, dropoff_lng, created_at, completed_at, tracking_code
      FROM ride_requests WHERE driver_id = $1
      ORDER BY created_at DESC LIMIT 20
    `, [driver.id]);

    res.json({ driver, rides: rides.rows });
  } catch (err) {
    console.error('Driver login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// POST /api/drivers/account/delete - user-initiated account deletion (public)
// Required by App Store Guideline 5.1.1(v): apps that create accounts must
// let the user delete their account from within the app.
router.post('/account/delete', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'Phone number is required' });
    const clean = phone.replace(/[^0-9+]/g, '');
    await pool.query('DELETE FROM drivers WHERE phone = $1 OR phone = $2', [clean, phone.trim()]);
    res.json({ deleted: true });
  } catch (err) {
    console.error('Driver delete error:', err);
    res.status(500).json({ error: 'Delete failed' });
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

// POST /api/drivers/:id/location — Update driver GPS location
router.post('/:id/location', async (req, res) => {
  try {
    const { lat, lng } = req.body;
    if (!lat || !lng) return res.status(400).json({ error: 'lat ak lng obligatwa' });

    const result = await pool.query(
      `UPDATE drivers SET current_lat = $2, current_lng = $3, last_location_update = NOW()
       WHERE id = $1 RETURNING id, full_name, current_lat, current_lng`,
      [req.params.id, lat, lng]
    );

    if (result.rows.length === 0) return res.status(404).json({ error: 'Chofè pa jwenn' });
    res.json({ updated: true, driver: result.rows[0] });
  } catch (err) {
    console.error('Location update error:', err);
    res.status(500).json({ error: 'Erè sèvè' });
  }
});

// GET /api/drivers/partner-stats - Stats by referral partner
router.get('/partner-stats', async (req, res) => {
  try {
    const { partner } = req.query;
    let where = '';
    const params = [];

    if (partner) {
      params.push(partner);
      where = ` WHERE d.referral_partner = $${params.length}`;
    }

    const stats = await pool.query(`
      SELECT
        COALESCE(d.referral_partner, 'Direct') as partner,
        COUNT(*) as total_registered,
        COUNT(*) FILTER (WHERE d.is_verified = true) as total_verified,
        COUNT(*) FILTER (WHERE d.is_active = true AND d.status = 'approved') as active_drivers
      FROM drivers d${where}
      GROUP BY d.referral_partner
      ORDER BY total_registered DESC
    `, params);

    const tripStats = await pool.query(`
      SELECT
        COALESCE(d.referral_partner, 'Direct') as partner,
        COUNT(r.id) as total_trips,
        COALESCE(SUM(r.price), 0) as total_revenue,
        COALESCE(SUM(r.platform_fee), 0) as total_platform_fee
      FROM drivers d
      LEFT JOIN ride_requests r ON r.driver_id = d.id AND r.status = 'completed'${where}
      GROUP BY d.referral_partner
    `, params);

    const tripMap = {};
    tripStats.rows.forEach(r => { tripMap[r.partner] = r; });

    const combined = stats.rows.map(s => ({
      partner: s.partner,
      total_registered: parseInt(s.total_registered),
      total_verified: parseInt(s.total_verified),
      active_drivers: parseInt(s.active_drivers),
      total_trips: parseInt(tripMap[s.partner]?.total_trips || 0),
      total_revenue: parseInt(tripMap[s.partner]?.total_revenue || 0),
      total_platform_fee: parseInt(tripMap[s.partner]?.total_platform_fee || 0)
    }));

    res.json(combined);
  } catch (err) {
    console.error('Partner stats error:', err);
    res.status(500).json({ error: 'Failed to fetch partner stats' });
  }
});

// GET /api/drivers/partner-drivers - List drivers for a specific partner
router.get('/partner-drivers', async (req, res) => {
  try {
    const { partner } = req.query;
    if (!partner) return res.status(400).json({ error: 'partner parameter required' });

    const result = await pool.query(`
      SELECT d.id, d.full_name, d.phone, d.vehicle_type, d.status,
             d.is_verified, d.is_active, d.referral_code, d.created_at,
             COUNT(r.id) as trip_count,
             COALESCE(SUM(CASE WHEN r.status = 'completed' THEN r.price ELSE 0 END), 0) as revenue
      FROM drivers d
      LEFT JOIN ride_requests r ON r.driver_id = d.id
      WHERE d.referral_partner = $1
      GROUP BY d.id
      ORDER BY d.created_at DESC
    `, [partner]);

    res.json(result.rows);
  } catch (err) {
    console.error('Partner drivers error:', err);
    res.status(500).json({ error: 'Failed to fetch partner drivers' });
  }
});

// GET /api/drivers/syndicate-stats - Stats by syndicate (with 2% commission)
router.get('/syndicate-stats', async (req, res) => {
  try {
    const { syndicate } = req.query;
    let where = '';
    const params = [];

    if (syndicate) {
      params.push(syndicate);
      where = ` WHERE d.syndicate = $${params.length}`;
    }

    const stats = await pool.query(`
      SELECT
        COALESCE(d.syndicate, 'Unassigned') as syndicate,
        COUNT(*) as total_registered,
        COUNT(*) FILTER (WHERE d.is_verified = true) as total_verified,
        COUNT(*) FILTER (WHERE d.is_active = true AND d.status = 'approved') as active_drivers
      FROM drivers d${where}
      GROUP BY d.syndicate
      ORDER BY total_registered DESC
    `, params);

    const tripStats = await pool.query(`
      SELECT
        COALESCE(d.syndicate, 'Unassigned') as syndicate,
        COUNT(r.id) as total_trips,
        COALESCE(SUM(r.price), 0) as total_revenue,
        COALESCE(SUM(r.platform_fee), 0) as total_platform_fee
      FROM drivers d
      LEFT JOIN ride_requests r ON r.driver_id = d.id AND r.status = 'completed'${where}
      GROUP BY d.syndicate
    `, params);

    const tripMap = {};
    tripStats.rows.forEach(r => { tripMap[r.syndicate] = r; });

    const combined = stats.rows.map(s => {
      const revenue = parseInt(tripMap[s.syndicate]?.total_revenue || 0);
      const platformFee = parseInt(tripMap[s.syndicate]?.total_platform_fee || 0);
      return {
        syndicate: s.syndicate,
        total_registered: parseInt(s.total_registered),
        total_verified: parseInt(s.total_verified),
        active_drivers: parseInt(s.active_drivers),
        total_trips: parseInt(tripMap[s.syndicate]?.total_trips || 0),
        total_revenue: revenue,
        total_platform_fee: platformFee,
        syndicate_share: Math.round(platformFee * 0.02)
      };
    });

    res.json(combined);
  } catch (err) {
    console.error('Syndicate stats error:', err);
    res.status(500).json({ error: 'Failed to fetch syndicate stats' });
  }
});

// GET /api/drivers/syndicate-drivers - List drivers for a specific syndicate
router.get('/syndicate-drivers', async (req, res) => {
  try {
    const { syndicate } = req.query;
    if (!syndicate) return res.status(400).json({ error: 'syndicate parameter required' });

    const result = await pool.query(`
      SELECT d.id, d.full_name, d.phone, d.vehicle_type, d.status,
             d.is_verified, d.is_active, d.syndicate, d.created_at,
             COUNT(r.id) as trip_count,
             COALESCE(SUM(CASE WHEN r.status = 'completed' THEN r.price ELSE 0 END), 0) as revenue,
             COALESCE(SUM(CASE WHEN r.status = 'completed' THEN r.platform_fee ELSE 0 END), 0) as platform_fee
      FROM drivers d
      LEFT JOIN ride_requests r ON r.driver_id = d.id
      WHERE d.syndicate = $1
      GROUP BY d.id
      ORDER BY d.created_at DESC
    `, [syndicate]);

    res.json(result.rows);
  } catch (err) {
    console.error('Syndicate drivers error:', err);
    res.status(500).json({ error: 'Failed to fetch syndicate drivers' });
  }
});

module.exports = router;
