const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const pool = require('../db/pool');
const pricing = require('../services/pricing');

// POST /api/rides/calculate — Estimate ride price
router.post('/calculate', async (req, res) => {
  try {
    const { pickup, dropoff, ride_type } = req.body;

    if (!pickup || !dropoff) {
      return res.status(400).json({ error: 'pickup ak dropoff obligatwa' });
    }

    const rideType = (ride_type || 'moto').toLowerCase();
    if (!['car', 'moto'].includes(rideType)) {
      return res.status(400).json({ error: 'ride_type dwe "car" oswa "moto"' });
    }

    let pickupLat, pickupLng, dropoffLat, dropoffLng;

    if (typeof pickup === 'string') {
      [pickupLat, pickupLng] = pickup.split(',').map(Number);
    } else {
      pickupLat = pickup.lat; pickupLng = pickup.lng;
    }

    if (typeof dropoff === 'string') {
      [dropoffLat, dropoffLng] = dropoff.split(',').map(Number);
    } else {
      dropoffLat = dropoff.lat; dropoffLng = dropoff.lng;
    }

    if (isNaN(pickupLat) || isNaN(pickupLng) || isNaN(dropoffLat) || isNaN(dropoffLng)) {
      return res.status(400).json({ error: 'Kòdone yo pa valid' });
    }

    const estimate = await pricing.calculateRide(pickupLat, pickupLng, dropoffLat, dropoffLng, rideType);
    res.json(estimate);
  } catch (err) {
    console.error('Calculate ride error:', err);
    res.status(500).json({ error: 'Erè sèvè' });
  }
});

// POST /api/rides/request — Request a ride
router.post('/request', async (req, res) => {
  try {
    const { user_id, customer_name, customer_phone, pickup, dropoff, ride_type, price, payment_method } = req.body;

    if (!pickup || !dropoff || !customer_phone) {
      return res.status(400).json({ error: 'pickup, dropoff, ak customer_phone obligatwa' });
    }

    const rideType = (ride_type || 'moto').toLowerCase();

    let pickupLat, pickupLng, dropoffLat, dropoffLng;
    if (typeof pickup === 'string') {
      [pickupLat, pickupLng] = pickup.split(',').map(Number);
    } else {
      pickupLat = pickup.lat; pickupLng = pickup.lng;
    }
    if (typeof dropoff === 'string') {
      [dropoffLat, dropoffLng] = dropoff.split(',').map(Number);
    } else {
      dropoffLat = dropoff.lat; dropoffLng = dropoff.lng;
    }

    const estimate = await pricing.calculateRide(pickupLat, pickupLng, dropoffLat, dropoffLng, rideType);
    const finalPrice = price || estimate.price;
    const config = await pricing.getPricingConfig();
    const commission = pricing.calculateCommission(finalPrice, config);

    const rideId = uuidv4();
    const trackingCode = 'MW-' + Date.now().toString(36).toUpperCase().slice(-6);

    await pool.query(
      `INSERT INTO ride_requests
       (id, customer_name, customer_phone, user_id, pickup_lat, pickup_lng, dropoff_lat, dropoff_lng,
        ride_type, distance_km, duration_min, price, platform_fee, driver_earning,
        payment_method, tracking_code, status, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'searching',NOW())`,
      [rideId, customer_name || 'Kliyan', customer_phone, user_id || null,
       pickupLat, pickupLng, dropoffLat, dropoffLng,
       rideType, estimate.distance_km, estimate.duration_min, finalPrice,
       commission.platform_fee, commission.driver_earning,
       payment_method || 'cash', trackingCode]
    );

    res.status(201).json({
      ride_id: rideId,
      tracking_code: trackingCode,
      status: 'searching',
      distance_km: estimate.distance_km,
      duration_min: estimate.duration_min,
      price: finalPrice,
      platform_fee: commission.platform_fee,
      driver_earning: commission.driver_earning,
      payment_method: payment_method || 'cash',
      message: 'Ap chèche chofè...'
    });
  } catch (err) {
    console.error('Request ride error:', err);
    res.status(500).json({ error: 'Erè sèvè' });
  }
});

// POST /api/rides/history — User login / ride history by phone (public)
router.post('/history', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) {
      return res.status(400).json({ error: 'Phone number is required' });
    }

    const clean = phone.replace(/[^0-9+]/g, '');
    const result = await pool.query(`
      SELECT id, customer_name, ride_type, status, price, payment_method,
             tracking_code, created_at, completed_at, started_at,
             pickup_lat, pickup_lng, dropoff_lat, dropoff_lng,
             distance_km, duration_min
      FROM ride_requests
      WHERE customer_phone = $1 OR customer_phone = $2
      ORDER BY created_at DESC LIMIT 30
    `, [clean, phone.trim()]);

    const name = result.rows.length > 0 ? result.rows[0].customer_name : null;

    res.json({
      customer_name: name,
      phone: clean,
      total_rides: result.rows.length,
      rides: result.rows
    });
  } catch (err) {
    console.error('Ride history error:', err);
    res.status(500).json({ error: 'Failed to fetch history' });
  }
});

// GET /api/rides/:id — Get ride details
router.get('/:id', async (req, res) => {
  try {
    const param = req.params.id;
    const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(param);
    const result = await pool.query(
      `SELECT r.*, d.full_name as driver_name, d.phone as driver_phone,
              d.vehicle_type, d.license_plate, d.photo_url as driver_photo
       FROM ride_requests r
       LEFT JOIN drivers d ON r.driver_id = d.id
       WHERE ${isUUID ? 'r.id = $1' : 'r.tracking_code = $1'}`,
      [param]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Kous pa jwenn' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Get ride error:', err);
    res.status(500).json({ error: 'Erè sèvè' });
  }
});

// GET /api/rides — List rides (admin)
router.get('/', async (req, res) => {
  try {
    const { status, limit } = req.query;
    let query = 'SELECT r.*, d.full_name as driver_name FROM ride_requests r LEFT JOIN drivers d ON r.driver_id = d.id';
    const params = [];
    if (status) {
      params.push(status);
      query += ' WHERE r.status = $1';
    }
    query += ' ORDER BY r.created_at DESC';
    if (limit) {
      params.push(parseInt(limit));
      query += ` LIMIT $${params.length}`;
    }
    const result = await pool.query(query, params);
    res.json({ rides: result.rows, total: result.rows.length });
  } catch (err) {
    console.error('List rides error:', err);
    res.status(500).json({ error: 'Erè sèvè' });
  }
});

// PATCH /api/rides/:id/accept — Driver accepts ride
router.patch('/:id/accept', async (req, res) => {
  try {
    const { driver_id } = req.body;
    if (!driver_id) {
      return res.status(400).json({ error: 'driver_id obligatwa' });
    }

    const ride = await pool.query('SELECT * FROM ride_requests WHERE id = $1', [req.params.id]);
    if (ride.rows.length === 0) return res.status(404).json({ error: 'Kous pa jwenn' });
    if (ride.rows[0].status !== 'searching') {
      return res.status(400).json({ error: 'Kous sa deja pran' });
    }

    const driver = await pool.query('SELECT * FROM drivers WHERE id = $1 AND status = $2', [driver_id, 'approved']);
    if (driver.rows.length === 0) return res.status(404).json({ error: 'Chofè pa jwenn oswa pa apwouve' });

    await pool.query(
      `UPDATE ride_requests SET driver_id = $1, status = 'accepted', updated_at = NOW() WHERE id = $2`,
      [driver_id, req.params.id]
    );

    res.json({
      status: 'accepted',
      ride_id: req.params.id,
      driver: { id: driver.rows[0].id, name: driver.rows[0].full_name, phone: driver.rows[0].phone, vehicle_type: driver.rows[0].vehicle_type, license_plate: driver.rows[0].license_plate },
      message: 'Chofè aksepte kous la!'
    });
  } catch (err) {
    console.error('Accept ride error:', err);
    res.status(500).json({ error: 'Erè sèvè' });
  }
});

// PATCH /api/rides/:id/reject — Driver rejects ride
router.patch('/:id/reject', async (req, res) => {
  try {
    const { driver_id, reason } = req.body;
    const ride = await pool.query('SELECT * FROM ride_requests WHERE id = $1', [req.params.id]);
    if (ride.rows.length === 0) return res.status(404).json({ error: 'Kous pa jwenn' });

    res.json({ status: 'searching', message: 'Ap chèche lòt chofè...' });
  } catch (err) {
    console.error('Reject ride error:', err);
    res.status(500).json({ error: 'Erè sèvè' });
  }
});

// PATCH /api/rides/:id/start — Driver starts ride
router.patch('/:id/start', async (req, res) => {
  try {
    const ride = await pool.query('SELECT * FROM ride_requests WHERE id = $1', [req.params.id]);
    if (ride.rows.length === 0) return res.status(404).json({ error: 'Kous pa jwenn' });
    if (ride.rows[0].status !== 'accepted') return res.status(400).json({ error: 'Kous dwe aksepte avan kòmanse' });

    await pool.query(
      `UPDATE ride_requests SET status = 'in_progress', started_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [req.params.id]
    );
    res.json({ status: 'in_progress', message: 'Kous kòmanse!' });
  } catch (err) {
    console.error('Start ride error:', err);
    res.status(500).json({ error: 'Erè sèvè' });
  }
});

// PATCH /api/rides/:id/complete — Driver completes ride
router.patch('/:id/complete', async (req, res) => {
  try {
    const ride = await pool.query('SELECT * FROM ride_requests WHERE id = $1', [req.params.id]);
    if (ride.rows.length === 0) return res.status(404).json({ error: 'Kous pa jwenn' });
    if (ride.rows[0].status !== 'in_progress') return res.status(400).json({ error: 'Kous dwe an kou avan fini' });

    await pool.query(
      `UPDATE ride_requests SET status = 'completed', completed_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [req.params.id]
    );

    res.json({
      status: 'completed',
      price: ride.rows[0].price,
      platform_fee: ride.rows[0].platform_fee,
      driver_earning: ride.rows[0].driver_earning,
      message: 'Kous fini! Mèsi.'
    });
  } catch (err) {
    console.error('Complete ride error:', err);
    res.status(500).json({ error: 'Erè sèvè' });
  }
});

// PATCH /api/rides/:id/cancel — Cancel ride
router.patch('/:id/cancel', async (req, res) => {
  try {
    const { reason } = req.body;
    const ride = await pool.query('SELECT * FROM ride_requests WHERE id = $1', [req.params.id]);
    if (ride.rows.length === 0) return res.status(404).json({ error: 'Kous pa jwenn' });
    if (['completed', 'cancelled'].includes(ride.rows[0].status)) {
      return res.status(400).json({ error: 'Pa ka anile kous sa' });
    }

    await pool.query(
      `UPDATE ride_requests SET status = 'cancelled', cancel_reason = $1, updated_at = NOW() WHERE id = $2`,
      [reason || null, req.params.id]
    );
    res.json({ status: 'cancelled', message: 'Kous anile' });
  } catch (err) {
    console.error('Cancel ride error:', err);
    res.status(500).json({ error: 'Erè sèvè' });
  }
});

// POST /api/rides/:id/emergency — Trigger SOS panic
router.post('/:id/emergency', async (req, res) => {
  try {
    const { lat, lng, phone, name } = req.body;
    const param = req.params.id;
    const isUUID = /^[0-9a-f]{8}-/.test(param);
    const ride = await pool.query(
      `SELECT * FROM ride_requests WHERE ${isUUID ? 'id = $1' : 'tracking_code = $1'}`,
      [param]
    );

    if (ride.rows.length > 0) {
      await pool.query(
        `UPDATE ride_requests SET status = 'emergency', updated_at = NOW() WHERE id = $1`,
        [ride.rows[0].id]
      );
    }

    await pool.query(
      `INSERT INTO sos_alerts (phone, name, lat, lng, ride_id, platform, status, created_at)
       VALUES ($1, $2, $3, $4, $5, 'msouwout', 'active', NOW())`,
      [phone || ride.rows[0]?.customer_phone || 'unknown', name || '', lat || null, lng || null, ride.rows[0]?.id || null]
    );

    res.status(201).json({ message: 'SOS voye! Ekip sekirite ap reponn.', status: 'active' });
  } catch (err) {
    console.error('Emergency error:', err);
    res.status(500).json({ error: 'Erè sèvè' });
  }
});

// GET /api/rides/:id/track — Get live tracking data for a ride
router.get('/:id/track', async (req, res) => {
  try {
    const param = req.params.id;
    const isUUID = /^[0-9a-f]{8}-/.test(param);
    const result = await pool.query(
      `SELECT r.*, d.full_name as driver_name, d.phone as driver_phone,
              d.vehicle_type, d.license_plate, d.photo_url as driver_photo,
              d.current_lat as driver_lat, d.current_lng as driver_lng,
              d.last_location_update
       FROM ride_requests r
       LEFT JOIN drivers d ON r.driver_id = d.id
       WHERE ${isUUID ? 'r.id = $1' : 'r.tracking_code = $1'}`,
      [param]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Kous pa jwenn' });
    }

    const ride = result.rows[0];
    res.json({
      ride_id: ride.id,
      tracking_code: ride.tracking_code,
      status: ride.status,
      pickup: { lat: ride.pickup_lat, lng: ride.pickup_lng },
      dropoff: { lat: ride.dropoff_lat, lng: ride.dropoff_lng },
      rider: { name: ride.customer_name, phone: ride.customer_phone },
      driver: ride.driver_id ? {
        name: ride.driver_name,
        phone: ride.driver_phone,
        vehicle_type: ride.vehicle_type,
        license_plate: ride.license_plate,
        photo: ride.driver_photo,
        lat: ride.driver_lat,
        lng: ride.driver_lng,
        location_updated: ride.last_location_update
      } : null,
      price: ride.price,
      distance_km: ride.distance_km,
      duration_min: ride.duration_min,
      ride_type: ride.ride_type,
      started_at: ride.started_at,
      created_at: ride.created_at
    });
  } catch (err) {
    console.error('Track ride error:', err);
    res.status(500).json({ error: 'Erè sèvè' });
  }
});

module.exports = router;
