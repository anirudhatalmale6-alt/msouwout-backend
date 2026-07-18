const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const pool = require('../db/pool');
const pricing = require('../services/pricing');

// POST /api/rides/account/delete — user-initiated deletion of a rider's data
// Required by App Store Guideline 5.1.1(v).
router.post('/account/delete', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'Phone number is required' });
    const clean = phone.replace(/[^0-9+]/g, '');
    await pool.query(
      'DELETE FROM ride_requests WHERE customer_phone = $1 OR customer_phone = $2',
      [clean, phone.trim()]
    );
    res.json({ deleted: true });
  } catch (err) {
    console.error('Rider delete error:', err);
    res.status(500).json({ error: 'Delete failed' });
  }
});

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
    // DASH Protection — flat 25 HTG pot (12.50 rider + 12.50 driver), split 20 fund / 5 MsouWout.
    const cfg = await pricing.getPricingConfig();
    const med = pricing.calculateMedicalFee(estimate.price, cfg);
    estimate.medical_protection = {
      fee: med.medical_fee,           // 25 — full pot
      rider_share: med.rider_share,   // 12.5 — what the rider pays on top
      driver_share: med.driver_share, // 12.5 — deducted from the driver
      dash_share: med.dash_fee,       // 20 — to DASH fund
      msouwout_share: med.msouwout_medical_fee, // 5 — MsouWout cut
      flat: true
    };
    // The rider only pays their 12.50 half on top of the fare.
    estimate.total_with_protection = Math.round(estimate.price + med.rider_share);
    res.json(estimate);
  } catch (err) {
    console.error('Calculate ride error:', err);
    res.status(500).json({ error: 'Erè sèvè' });
  }
});

// POST /api/rides/request — Request a ride
router.post('/request', async (req, res) => {
  try {
    const {
      user_id, customer_name, customer_phone, pickup, dropoff, ride_type, price, payment_method,
      // Medical protection toggle
      medical_protection,
      // Delegation fields (order for someone else)
      is_delegated, orderer_name, orderer_phone, passenger_name, passenger_phone
    } = req.body;

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

    // DASH Protection & Medical Assistance — MANDATORY on every ride.
    // Flat 25 HTG pot (12.50 rider + 12.50 driver), split 20 to DASH fund / 5 to MsouWout.
    const wantsMedical = true;
    const med = pricing.calculateMedicalFee(finalPrice, config);
    const medicalFee = med.medical_fee;            // 25 — full pot
    const dashFee = med.dash_fee;                  // 20 — DASH fund
    const msouwoutMedicalFee = med.msouwout_medical_fee; // 5 — MsouWout cut
    const driverDashShare = med.driver_share;      // 12.5 — deducted from driver at payout

    // Delegation validation
    const delegated = is_delegated === true;
    if (delegated && (!passenger_name || !passenger_phone)) {
      return res.status(400).json({ error: 'passenger_name ak passenger_phone obligatwa pou kous delegasyon' });
    }

    const rideId = uuidv4();
    const trackingCode = 'MW-' + Date.now().toString(36).toUpperCase().slice(-6);
    const ridePin = String(Math.floor(1000 + Math.random() * 9000));

    // Rider pays the fare plus only their 12.50 DASH half.
    const totalWithProtection = Math.round(finalPrice + med.rider_share);

    await pool.query(
      `INSERT INTO ride_requests
       (id, customer_name, customer_phone, user_id, pickup_lat, pickup_lng, dropoff_lat, dropoff_lng,
        ride_type, distance_km, duration_min, price, platform_fee, driver_earning,
        payment_method, tracking_code, ride_pin, status,
        medical_protection, medical_fee, dash_fee, msouwout_medical_fee, driver_dash_share, total_with_protection,
        is_delegated, orderer_name, orderer_phone, passenger_name, passenger_phone,
        created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'searching',
               $18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,NOW())`,
      [rideId, customer_name || 'Kliyan', customer_phone, user_id || null,
       pickupLat, pickupLng, dropoffLat, dropoffLng,
       rideType, estimate.distance_km, estimate.duration_min, finalPrice,
       commission.platform_fee, commission.driver_earning,
       payment_method || 'cash', trackingCode, ridePin,
       wantsMedical, medicalFee, dashFee, msouwoutMedicalFee, driverDashShare, totalWithProtection,
       delegated, delegated ? (orderer_name || customer_name || 'Kliyan') : null,
       delegated ? (orderer_phone || customer_phone) : null,
       delegated ? passenger_name : null, delegated ? passenger_phone : null]
    );

    const response = {
      ride_id: rideId,
      tracking_code: trackingCode,
      ride_pin: ridePin,
      status: 'searching',
      distance_km: estimate.distance_km,
      duration_min: estimate.duration_min,
      price: finalPrice,
      platform_fee: commission.platform_fee,
      driver_earning: commission.driver_earning,
      payment_method: payment_method || 'cash',
      message: 'Ap chèche chofè...'
    };

    response.medical_protection = true;
    response.medical_fee = medicalFee;
    response.dash_fee = dashFee;
    response.msouwout_medical_fee = msouwoutMedicalFee;
    response.driver_dash_share = driverDashShare;
    response.total_with_protection = totalWithProtection;

    if (delegated) {
      response.is_delegated = true;
      response.orderer = { name: orderer_name || customer_name || 'Kliyan', phone: orderer_phone || customer_phone };
      response.passenger = { name: passenger_name, phone: passenger_phone };
      response.share_link = `${req.protocol}://${req.get('host')}/api/rides/${trackingCode}/track`;
    }

    res.status(201).json(response);
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

// GET /api/rides/reports/money — Money split & settlement report (admin)
// Every completed ride contributes three lines: driver payout, DASH fund, MsouWout revenue.
// Defaults to the last 24 hours (the payout/settlement window) plus a 7-day daily series.
router.get('/reports/money', async (req, res) => {
  try {
    if (process.env.ADMIN_SECRET) {
      const secret = req.headers['x-admin-secret'] || req.query.secret;
      if (secret !== process.env.ADMIN_SECRET) return res.status(401).json({ error: 'Unauthorized' });
    }

    const to = req.query.to ? new Date(req.query.to) : new Date();
    const from = req.query.from ? new Date(req.query.from) : new Date(to.getTime() - 24 * 60 * 60 * 1000);

    // Completed rides in the window — the money that must settle.
    const completed = await pool.query(
      `SELECT
         COUNT(*)                                                   AS rides,
         COALESCE(SUM(price),0)                                     AS gross_fares,
         COALESCE(SUM(driver_earning - COALESCE(driver_dash_share,0)),0) AS driver_payouts,
         COALESCE(SUM(dash_fee),0)                                  AS dash_fund,
         COALESCE(SUM(platform_fee + COALESCE(msouwout_medical_fee,0)),0) AS msouwout_revenue,
         COALESCE(SUM(total_with_protection),0)                     AS rider_collected
       FROM ride_requests
       WHERE status = 'completed' AND completed_at >= $1 AND completed_at <= $2`,
      [from.toISOString(), to.toISOString()]
    );

    // Cancellation fees in the window — paid to drivers, no DASH.
    const cancels = await pool.query(
      `SELECT COUNT(*) AS cancelled, COALESCE(SUM(COALESCE(cancel_fee,0)),0) AS cancel_fees
       FROM ride_requests
       WHERE status = 'cancelled' AND updated_at >= $1 AND updated_at <= $2`,
      [from.toISOString(), to.toISOString()]
    );

    // 7-day daily series for the trend view.
    const daily = await pool.query(
      `SELECT
         to_char(date_trunc('day', completed_at), 'YYYY-MM-DD') AS day,
         COUNT(*)                                               AS rides,
         COALESCE(SUM(driver_earning - COALESCE(driver_dash_share,0)),0) AS driver_payouts,
         COALESCE(SUM(dash_fee),0)                              AS dash_fund,
         COALESCE(SUM(platform_fee + COALESCE(msouwout_medical_fee,0)),0) AS msouwout_revenue
       FROM ride_requests
       WHERE status = 'completed' AND completed_at >= NOW() - INTERVAL '7 days'
       GROUP BY 1 ORDER BY 1 DESC`
    );

    const c = completed.rows[0];
    res.json({
      window: { from: from.toISOString(), to: to.toISOString(), hours: 24 },
      summary: {
        rides: parseInt(c.rides) || 0,
        gross_fares: Math.round(Number(c.gross_fares)),
        driver_payouts: Math.round(Number(c.driver_payouts)),   // due to drivers within 24h
        dash_fund: Math.round(Number(c.dash_fund)),             // due to DASH medical fund within 24h
        msouwout_revenue: Math.round(Number(c.msouwout_revenue)),
        rider_collected: Math.round(Number(c.rider_collected)),
        cancelled: parseInt(cancels.rows[0].cancelled) || 0,
        cancel_fees: Math.round(Number(cancels.rows[0].cancel_fees))
      },
      daily: daily.rows.map(d => ({
        day: d.day,
        rides: parseInt(d.rides) || 0,
        driver_payouts: Math.round(Number(d.driver_payouts)),
        dash_fund: Math.round(Number(d.dash_fund)),
        msouwout_revenue: Math.round(Number(d.msouwout_revenue))
      })),
      currency: 'HTG'
    });
  } catch (err) {
    console.error('Money report error:', err);
    res.status(500).json({ error: 'Erè sèvè' });
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
      `UPDATE ride_requests SET driver_id = $1, status = 'accepted', accepted_at = NOW(), updated_at = NOW() WHERE id = $2`,
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

// PATCH /api/rides/:id/start — Driver starts ride (PIN required)
router.patch('/:id/start', async (req, res) => {
  try {
    const { pin } = req.body;
    const ride = await pool.query('SELECT * FROM ride_requests WHERE id = $1', [req.params.id]);
    if (ride.rows.length === 0) return res.status(404).json({ error: 'Kous pa jwenn' });
    if (ride.rows[0].status !== 'accepted') return res.status(400).json({ error: 'Kous dwe aksepte avan kòmanse' });

    if (ride.rows[0].ride_pin && pin !== ride.rows[0].ride_pin) {
      return res.status(403).json({ error: 'PIN pa kòrèk. Mande pasaje a pou PIN nan.', pin_required: true });
    }

    await pool.query(
      `UPDATE ride_requests SET status = 'in_progress', started_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [req.params.id]
    );
    res.json({ status: 'in_progress', message: 'PIN verifye! Kous kòmanse!' });
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

    const r = ride.rows[0];
    const driverDash = Number(r.driver_dash_share) || 0;
    const driverNet = Math.round((Number(r.driver_earning) || 0) - driverDash);        // 80% fare − 12.50
    const msouwoutRevenue = (Number(r.platform_fee) || 0) + (Number(r.msouwout_medical_fee) || 0); // 20% fare + 5

    res.json({
      status: 'completed',
      price: r.price,
      platform_fee: r.platform_fee,
      driver_earning: r.driver_earning,
      // 3-way split, recorded on every completed ride
      driver_net: driverNet,          // paid to driver
      dash_fund: r.dash_fee,          // 20 → DASH medical fund
      msouwout_revenue: msouwoutRevenue, // 20% fare + 5
      message: 'Kous fini! Mèsi.'
    });
  } catch (err) {
    console.error('Complete ride error:', err);
    res.status(500).json({ error: 'Erè sèvè' });
  }
});

// PATCH /api/rides/:id/cancel — Cancel ride
//
// Cancellation policy (confirmed with Jeffery 2026-07-18):
//   • Rider cancels before a driver accepts → FREE, no charge, no DASH.
//   • Rider cancels within the grace window after accept → FREE.
//   • Rider cancels after the grace window / once the driver is on the way →
//       cancel fee (default 50 HTG) charged to the rider, paid to the driver. No DASH.
//   • Driver cancels → rider pays nothing, no DASH (repeat driver cancels are flagged).
//   • DASH's 25 HTG is only ever charged on COMPLETED rides, never a cancellation.
router.patch('/:id/cancel', async (req, res) => {
  try {
    const { reason } = req.body;
    const cancelledBy = (req.body.cancelled_by || 'rider').toLowerCase() === 'driver' ? 'driver' : 'rider';
    const ride = await pool.query('SELECT * FROM ride_requests WHERE id = $1', [req.params.id]);
    if (ride.rows.length === 0) return res.status(404).json({ error: 'Kous pa jwenn' });
    const r = ride.rows[0];
    if (['completed', 'cancelled'].includes(r.status)) {
      return res.status(400).json({ error: 'Pa ka anile kous sa' });
    }

    const config = await pricing.getPricingConfig();
    let cancelFee = 0;

    // A fee only applies when the RIDER cancels after a driver has already committed
    // and the free grace window has elapsed.
    if (cancelledBy === 'rider' && ['accepted', 'in_progress'].includes(r.status)) {
      const acceptedAt = r.accepted_at ? new Date(r.accepted_at).getTime() : null;
      const elapsedSec = acceptedAt ? (Date.now() - acceptedAt) / 1000 : Infinity;
      if (r.status === 'in_progress' || elapsedSec > (config.cancel_grace_sec || 120)) {
        cancelFee = config.cancel_fee || 0;
      }
    }

    await pool.query(
      `UPDATE ride_requests
         SET status = 'cancelled', cancel_reason = $1, cancelled_by = $2,
             cancel_fee = $3, updated_at = NOW()
       WHERE id = $4`,
      [reason || null, cancelledBy, cancelFee, req.params.id]
    );

    res.json({
      status: 'cancelled',
      cancelled_by: cancelledBy,
      cancel_fee: cancelFee,               // 0 = free; else charged to rider, paid to driver
      dash_charged: false,                 // DASH is never charged on a cancellation
      message: cancelFee > 0
        ? `Kous anile. Frè anilasyon: ${cancelFee} HTG (pou chofè a).`
        : 'Kous anile. Pa gen frè.'
    });
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
    const showPin = req.query.pin === '1';
    const trackResponse = {
      ride_id: ride.id,
      tracking_code: ride.tracking_code,
      status: ride.status,
      ride_pin: showPin ? ride.ride_pin : undefined,
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
    };

    // Include medical protection info
    if (ride.medical_protection) {
      trackResponse.medical_protection = true;
      trackResponse.medical_fee = ride.medical_fee;
    }

    // Include delegation info
    if (ride.is_delegated) {
      trackResponse.is_delegated = true;
      trackResponse.orderer = { name: ride.orderer_name, phone: ride.orderer_phone };
      trackResponse.passenger = { name: ride.passenger_name, phone: ride.passenger_phone };
      trackResponse.share_link = `${req.protocol}://${req.get('host')}/api/rides/${ride.tracking_code}/track`;
    }

    res.json(trackResponse);
  } catch (err) {
    console.error('Track ride error:', err);
    res.status(500).json({ error: 'Erè sèvè' });
  }
});

module.exports = router;
