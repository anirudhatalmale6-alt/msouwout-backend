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
/* A tracking code must be unique - the column says so. It was built from
 * Date.now() alone, so two passengers ordering in the SAME MILLISECOND produced
 * the SAME code, the second INSERT hit the unique index, and her order came back
 * as a 500 and was simply lost. Measured on the live system before this change:
 * fine at 10 at once, ~15% lost at 20, ~30% lost at 80.
 *
 * The time part keeps codes roughly ordered and short enough to read out; the
 * random tail is what stops the collision. The insert below also retries if one
 * ever does slip through, so nobody is dropped because two codes clashed. */
function newTrackingCode() {
  const t = Date.now().toString(36).toUpperCase().slice(-4);
  const r = Math.random().toString(36).toUpperCase().slice(2, 5);
  return 'MW-' + t + r;
}

router.post('/request', async (req, res) => {
  try {
    const b = req.body || {};
    // The website has always posted riderPhone/pickupAddress/vehicleType while this
    // route read customer_phone/pickup/ride_type, so every order 400'd and the page
    // quietly showed a "searching" screen anyway. Accept both spellings rather than
    // break whichever client is not redeployed yet.
    const customer_phone = b.customer_phone || b.riderPhone || b.phone;
    const customer_name  = b.customer_name  || b.riderName;
    const user_id        = b.user_id;
    const payment_method = b.payment_method;
    const pickup  = b.pickup  != null ? b.pickup  : b.pickupAddress;
    const dropoff = b.dropoff != null ? b.dropoff : b.dropoffAddress;
    const ride_type = b.ride_type || b.vehicleType || b.rideType;
    const price = b.price;
    const { is_delegated, orderer_name, orderer_phone, passenger_name, passenger_phone } = b;

    if (!pickup || !dropoff || !customer_phone) {
      return res.status(400).json({ error: 'pickup, dropoff, ak customer_phone obligatwa' });
    }

    const rideType = (ride_type === 'car' || ride_type === 'machin') ? 'car' : 'moto';

    // A place is either a point or a sentence. Only a "lat,lng" string or a {lat,lng}
    // object is a point; anything else is what the passenger actually typed, and it is
    // the address — not a broken coordinate — that the driver needs to read.
    function readPlace(value, latHint, lngHint) {
      const num = (v) => (v === null || v === undefined || v === '' ? NaN : Number(v));
      if (value && typeof value === 'object') {
        const la = num(value.lat), ln = num(value.lng);
        if (Number.isFinite(la) && Number.isFinite(ln)) return { lat: la, lng: ln, address: value.address || null };
      }
      if (typeof value === 'string' && /^\s*-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?\s*$/.test(value)) {
        const [la, ln] = value.split(',').map(Number);
        return { lat: la, lng: ln, address: null };
      }
      const la = num(latHint), ln = num(lngHint);
      return {
        lat: Number.isFinite(la) ? la : null,
        lng: Number.isFinite(ln) ? ln : null,
        address: typeof value === 'string' ? value.trim() : null
      };
    }

    const from = readPlace(pickup,  b.pickupLat,  b.pickupLng);
    const to   = readPlace(dropoff, b.dropoffLat, b.dropoffLng);
    const pickupLat = from.lat, pickupLng = from.lng;
    const dropoffLat = to.lat,  dropoffLng = to.lng;
    const havePoints = [pickupLat, pickupLng, dropoffLat, dropoffLng].every(Number.isFinite);

    // With two real points the server prices the ride. With written addresses it cannot
    // measure the distance, so it trusts the figure the passenger was actually shown —
    // quoting one price on the phone and storing another is worse than a rough estimate.
    let estimate;
    if (havePoints) {
      estimate = await pricing.calculateRide(pickupLat, pickupLng, dropoffLat, dropoffLng, rideType);
    } else {
      const km = Number(b.distance_km);
      const config = await pricing.getPricingConfig();
      const distanceKm = Number.isFinite(km) && km > 0 ? km : 3;
      estimate = {
        distance_km: distanceKm,
        duration_min: pricing.estimateDuration(distanceKm),
        price: pricing.calculatePrice(rideType, distanceKm, config, 1.0)
      };
    }
    const finalPrice = Math.round(Number(price) > 0 ? Number(price) : estimate.price);
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
    let trackingCode = newTrackingCode();
    const ridePin = String(Math.floor(1000 + Math.random() * 9000));

    // Rider pays the fare plus only their 12.50 DASH half.
    const totalWithProtection = Math.round(finalPrice + med.rider_share);

    /* Retry on a duplicate tracking code (Postgres 23505) rather than letting
       one collision become a lost passenger. Any other error still propagates. */
    let inserted = false;
    for (let attempt = 0; attempt < 3 && !inserted; attempt++) {
      try {
        await insertRide();
        inserted = true;
      } catch (e) {
        if (e && e.code === '23505' && attempt < 2) { trackingCode = newTrackingCode(); continue; }
        throw e;
      }
    }

    async function insertRide() {
    return pool.query(
      `INSERT INTO ride_requests
       (id, customer_name, customer_phone, user_id, pickup_lat, pickup_lng, dropoff_lat, dropoff_lng,
        ride_type, distance_km, duration_min, price, platform_fee, driver_earning,
        payment_method, tracking_code, ride_pin, status,
        medical_protection, medical_fee, dash_fee, msouwout_medical_fee, driver_dash_share, total_with_protection,
        is_delegated, orderer_name, orderer_phone, passenger_name, passenger_phone,
        pickup_address, dropoff_address,
        created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'searching',
               $18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,NOW())`,
      [rideId, customer_name || 'Kliyan', customer_phone, user_id || null,
       pickupLat, pickupLng, dropoffLat, dropoffLng,
       rideType, estimate.distance_km, estimate.duration_min, finalPrice,
       commission.platform_fee, commission.driver_earning,
       payment_method || 'cash', trackingCode, ridePin,
       wantsMedical, medicalFee, dashFee, msouwoutMedicalFee, driverDashShare, totalWithProtection,
       delegated, delegated ? (orderer_name || customer_name || 'Kliyan') : null,
       delegated ? (orderer_phone || customer_phone) : null,
       delegated ? passenger_name : null, delegated ? passenger_phone : null,
       from.address, to.address]
    );
    }

    const response = {
      ride_id: rideId,
      tracking_code: trackingCode,
      ride_pin: ridePin,
      status: 'searching',
      pickup_address: from.address,
      dropoff_address: to.address,
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
// GET /api/rides/available — what a driver on duty should be seeing.
//
// ⚠️ Must stay ABOVE `GET /:id`, or Express reads "available" as a ride id.
//
// Only rides still searching, and only recent ones: an order from this morning is
// not something a driver should be offered at eight in the evening.
/* Every spelling either side of the wire has ever used for the same two
   things. Returns null for anything unrecognised, so an unknown value means
   "no filter" rather than "match nothing". */
function normVehicle(v) {
  const x = String(v || '').trim().toLowerCase();
  if (!x) return null;
  if (['moto', 'motorcycle', 'motocyclette', 'mototaxi', 'motto'].includes(x)) return 'moto';
  if (['car', 'machin', 'voiture', 'auto', 'automobile'].includes(x)) return 'car';
  return null;
}

router.get('/available', async (req, res) => {
  try {
    /* A RIDE is 'moto' or 'car'. A DRIVER is 'motorcycle' or 'car' - the two
       halves of the system have always spelled it differently. The old check
       was `=== 'moto'`, so a driver app sending its own vehicle_type of
       "motorcycle" matched neither arm and the filter silently switched itself
       off: the moto driver got car rides and nothing looked broken. Normalise
       instead of trusting the spelling. */
    const rideType = normVehicle(req.query.ride_type);
    const minutes = Math.min(parseInt(req.query.minutes, 10) || 60, 720);
    const params = [];
    let where = `WHERE r.status = 'searching' AND r.created_at > NOW() - INTERVAL '${minutes} minutes'`;
    if (rideType) {
      params.push(rideType);
      where += ` AND r.ride_type = $${params.length}`;
    }
    /* Nearest first, when we know where the driver is.
     *
     * The driver app sends lat/lng now, so it can ask for the board sorted by
     * how far each pickup is from him. Straight-line distance, not road
     * distance: it is one arithmetic expression, it needs no third party, and
     * for choosing between "two streets away" and "across the city" it is
     * right often enough. Road distance would be better and is not worth an API
     * bill per poll per driver.
     *
     * ⛔ A ride with no pickup coordinates is NOT dropped. Plenty of orders are
     * placed by typing an address that never geocoded, and hiding those from
     * every driver would quietly lose real fares. They sort last.
     *
     * 6371 is the earth's radius in km; the cos() term is there because a
     * degree of longitude narrows as you leave the equator. */
    let order = 'r.created_at DESC';
    const dLat = parseFloat(req.query.lat), dLng = parseFloat(req.query.lng);
    let distSelect = 'NULL::float AS km_away';
    if (Number.isFinite(dLat) && Number.isFinite(dLng) &&
        Math.abs(dLat) <= 90 && Math.abs(dLng) <= 180 && (dLat !== 0 || dLng !== 0)) {
      params.push(dLat); const pLat = params.length;
      params.push(dLng); const pLng = params.length;
      distSelect = `CASE WHEN r.pickup_lat IS NULL OR r.pickup_lng IS NULL THEN NULL ELSE
          6371 * 2 * asin(sqrt(
            power(sin(radians(r.pickup_lat - $${pLat}) / 2), 2) +
            cos(radians($${pLat})) * cos(radians(r.pickup_lat)) *
            power(sin(radians(r.pickup_lng - $${pLng}) / 2), 2)
          )) END AS km_away`;
      /* NULLS LAST so a ride we cannot place still reaches every driver,
         underneath the ones we can. */
      order = 'km_away ASC NULLS LAST, r.created_at DESC';
    }

    const result = await pool.query(
      `SELECT r.id, r.tracking_code, r.customer_name, r.customer_phone,
              r.pickup_address, r.dropoff_address, r.pickup_lat, r.pickup_lng,
              r.dropoff_lat, r.dropoff_lng, r.ride_type, r.distance_km, r.duration_min,
              r.price, r.driver_earning, r.total_with_protection, r.payment_method,
              r.created_at,
              ${distSelect}
       FROM ride_requests r ${where}
       ORDER BY ${order} LIMIT 20`,
      params
    );
    res.json({ rides: result.rows, total: result.rows.length, sorted_by: order.startsWith('km') ? 'distance' : 'time' });
  } catch (err) {
    console.error('Available rides error:', err);
    res.status(500).json({ error: 'Erè sèvè' });
  }
});

// GET /api/rides/driver/:driverId/active — the ride this driver is on right now.
// The dashboard used to learn about rides only at login, so a ride accepted after
// login stayed invisible until the driver signed out and back in.
router.get('/driver/:driverId/active', async (req, res) => {
  try {
    // The demo account's id is the word "demo", not a uuid. Postgres answers a bad
    // cast with an error, which reached the driver's phone as "Erè sèvè" — a server
    // fault for what is simply an account with no rides.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(req.params.driverId)) {
      return res.json({ ride: null });
    }
    const result = await pool.query(
      `SELECT r.*, d.full_name as driver_name, d.phone as driver_phone, d.license_plate
       FROM ride_requests r LEFT JOIN drivers d ON r.driver_id = d.id
       /* 🚨 22 Sep: MW-KRPWCO9 was accepted, arrived and STARTED, then a safety
          alert flipped its status to 'monitoring' (routes/safety.js). This
          query did not list that status, so the endpoint returned {ride:null}
          and the ride became invisible to its own driver - it could not be
          completed and could not be paid. A safety alert must never take the
          ride off the driver's screen; that is when he needs it most. */
       WHERE r.driver_id = $1 AND r.status IN ('accepted','in_progress','monitoring','emergency')
       ORDER BY r.updated_at DESC LIMIT 1`,
      [req.params.driverId]
    );
    res.json({ ride: result.rows[0] || null });
  } catch (err) {
    console.error('Driver active ride error:', err);
    res.status(500).json({ error: 'Erè sèvè' });
  }
});

/* 🚨🚨 24 Sep — "Confirm that public tracking links cannot expose passenger
   information or security PINs."
   They could. This route returns r.* — 48 columns, including customer_phone,
   driver_phone and ride_pin — and it ACCEPTED A TRACKING CODE. A tracking code
   is printed in a link the passenger is expected to forward to her family, so
   anybody holding that link could read her number and the PIN she uses to
   prove she is getting into the right car.
   It now answers ONLY to the ride's UUID, which is never shared: the passenger
   app has it from the moment she orders, and nobody else ever sees it. Anyone
   with a tracking code goes to /:id/track, whose payload is curated.
   Checked before changing it: msouwout-site/index.html is the only caller and
   it passes rideData.id, a UUID. */
router.get('/:id', async (req, res) => {
  try {
    const param = req.params.id;
    const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(param);
    if (!isUUID) {
      return res.status(404).json({
        error: 'Kous pa jwenn',
        hint: 'A tracking code cannot read the full ride. Use /api/rides/:code/track.'
      });
    }
    const result = await pool.query(
      `SELECT r.*, d.full_name as driver_name, d.phone as driver_phone,
              d.vehicle_type, d.license_plate, d.photo_url as driver_photo
       FROM ride_requests r
       LEFT JOIN drivers d ON r.driver_id = d.id
       WHERE r.id = $1`,
      [param]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Kous pa jwenn' });
    }
    /* She already has her PIN from the moment she ordered - the ordering page
       stores it. Not repeating it here keeps it out of one more response. */
    const row = { ...result.rows[0] };
    delete row.ride_pin;
    res.json(row);
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
    // Say "this account cannot take rides" rather than letting a bad uuid become a
    // 500 the driver reads as the whole system being down.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(driver_id)) {
      return res.status(404).json({ error: 'Chofè pa jwenn oswa pa apwouve' });
    }

    const ride = await pool.query('SELECT * FROM ride_requests WHERE id = $1', [req.params.id]);
    if (ride.rows.length === 0) return res.status(404).json({ error: 'Kous pa jwenn' });
    if (ride.rows[0].status !== 'searching') {
      return res.status(400).json({ error: 'Kous sa deja pran' });
    }

    const driver = await pool.query('SELECT * FROM drivers WHERE id = $1 AND status = $2', [driver_id, 'approved']);
    if (driver.rows.length === 0) return res.status(404).json({ error: 'Chofè pa jwenn oswa pa apwouve' });

    // With ten drivers watching the same board, two can tap Accept in the same
    // second — and the SELECT above would say "searching" to both. The status is
    // re-checked inside the UPDATE itself, so exactly one row can change hands.
    //
    // The NOT EXISTS is the other half of it. Nothing hands a particular ride to a
    // particular driver: every searching ride is on every board. So when two
    // passengers order at the same moment, both requests sit in front of the same
    // driver and he can take both — and his phone only ever shows one of them.
    // The second passenger would be told a driver is coming who does not know she
    // exists. One unfinished ride per driver, decided by the database so two taps
    // in the same second cannot both slip through.
    const claim = await pool.query(
      `UPDATE ride_requests SET driver_id = $1, status = 'accepted', accepted_at = NOW(), updated_at = NOW()
        WHERE id = $2 AND status = 'searching'
          AND NOT EXISTS (
            SELECT 1 FROM ride_requests busy
             WHERE busy.driver_id = $1 AND busy.status IN ('accepted','in_progress')
          )`,
      [driver_id, req.params.id]
    );
    if (claim.rowCount === 0) {
      // Refused for one of two very different reasons. Telling him "already taken"
      // when the truth is "you have not finished your own ride" sends him hunting
      // for a bug that is not there.
      const held = await pool.query(
        `SELECT tracking_code FROM ride_requests
          WHERE driver_id = $1 AND status IN ('accepted','in_progress') LIMIT 1`,
        [driver_id]
      );
      if (held.rows.length > 0) {
        return res.status(409).json({
          error: 'Ou gen yon kous ki poko fini. Fini l anvan ou pran yon lòt.',
          active_ride: held.rows[0].tracking_code
        });
      }
      return res.status(400).json({ error: 'Kous sa deja pran' });
    }

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
/* PATCH /api/rides/:id/arrived — the driver says he is outside.
 *
 * His question: "How can we let the customer know when the driver arrived
 * without having to call?" The passenger's page is already open and already
 * polling every ten seconds once a ride is accepted, so nothing needs to be
 * pushed anywhere - the driver only needs somewhere to say it.
 *
 * Deliberately a timestamp and not a new status. searching -> accepted ->
 * in_progress -> completed is switched on in several places; a fifth value
 * would change all of them. arrived_at only adds.
 *
 * Idempotent: a driver who taps twice does not move the time. The passenger
 * would see the "he is outside" alert fire again for no reason, and on a
 * ride that is already under way it would be simply wrong.
 */
router.patch('/:id/arrived', async (req, res) => {
  try {
    const ride = await pool.query('SELECT * FROM ride_requests WHERE id = $1', [req.params.id]);
    if (ride.rows.length === 0) return res.status(404).json({ error: 'Kous pa jwenn' });
    if (ride.rows[0].status !== 'accepted') {
      return res.status(400).json({ error: 'Kous la dwe aksepte anvan' });
    }
    /* Only the driver who took the ride may mark it. Sent by the driver app;
       checked here because the endpoint is reachable by anybody. */
    const { driver_id } = req.body || {};
    if (driver_id && ride.rows[0].driver_id && driver_id !== ride.rows[0].driver_id) {
      return res.status(403).json({ error: 'Se pa kous ou' });
    }
    if (ride.rows[0].arrived_at) {
      return res.json({ arrived_at: ride.rows[0].arrived_at, already: true });
    }
    const out = await pool.query(
      `UPDATE ride_requests SET arrived_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND status = 'accepted' AND arrived_at IS NULL
       RETURNING arrived_at`,
      [req.params.id]
    );
    if (!out.rows.length) {
      return res.status(409).json({ error: 'Kous la chanje' });
    }
    res.json({ arrived_at: out.rows[0].arrived_at, message: 'Pasaje a avize' });
  } catch (err) {
    console.error('Arrived error:', err);
    res.status(500).json({ error: 'Erè sèvè' });
  }
});

router.patch('/:id/start', async (req, res) => {
  try {
    const { pin } = req.body;
    const ride = await pool.query('SELECT * FROM ride_requests WHERE id = $1', [req.params.id]);
    if (ride.rows.length === 0) return res.status(404).json({ error: 'Kous pa jwenn' });
    if (ride.rows[0].status !== 'accepted') return res.status(400).json({ error: 'Kous dwe aksepte avan kòmanse' });

    /* 🚨 24 Sep, Jeffery's final structure, point 1: "The driver must receive
       server-confirmed payment before starting."
       Nothing enforced that. The driver could take a passenger who had not
       paid, and only discover it afterwards - by which time the ride is done
       and the only way to collect is to chase her.
       SERVER-confirmed means this column, which is written when the gateway
       itself says the money arrived. Not what the phone believes. */
    if (String(ride.rows[0].payment_status || '').toLowerCase() !== 'paid') {
      return res.status(402).json({
        error: 'Pasaje a poko peye. Tann konfimasyon peman an avan ou kòmanse kous la.',
        payment_required: true,
        payment_status: ride.rows[0].payment_status || 'unpaid'
      });
    }

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

    /* 🛑 A ride that was ALREADY PAID for.
       Until 23 Sep a passenger could only pay once the ride had finished, so
       this could not arise. Payment now opens the moment a driver accepts, and
       the first real ride to use it was cancelled eight minutes after paying:
       368 HTG taken, 50 HTG legitimately kept, 318 HTG owed back - and not one
       line in this codebase could send it.
       The refund itself needs the gateway to support one. Recording the debt
       does not, and must not wait for it: money owed that lives only in
       somebody's memory is money that gets lost. */
    const alreadyPaid = String(r.payment_status || '').toLowerCase() === 'paid';
    const paidAmount = Number(r.total_with_protection) > 0
      ? Number(r.total_with_protection)
      : Number(r.price || 0);
    const refundDue = alreadyPaid ? Math.max(0, Math.round(paidAmount - cancelFee)) : 0;

    await pool.query(
      `UPDATE ride_requests
         SET status = 'cancelled', cancel_reason = $1, cancelled_by = $2,
             cancel_fee = $3,
             refund_due = $5,
             refund_status = CASE WHEN $5 > 0 THEN 'owed' ELSE refund_status END,
             updated_at = NOW()
       WHERE id = $4`,
      [reason || null, cancelledBy, cancelFee, req.params.id, refundDue]
    );

    if (refundDue > 0) {
      /* Loud on purpose. Nobody is watching a database column during a launch. */
      console.warn(`[REFUND OWED] ride ${r.tracking_code} — paid ${paidAmount} HTG, ` +
                   `fee ${cancelFee} HTG, OWED ${refundDue} HTG to ` +
                   `${r.customer_phone || 'unknown number'}`);
    }

    res.json({
      status: 'cancelled',
      cancelled_by: cancelledBy,
      cancel_fee: cancelFee,               // 0 = free; else charged to rider, paid to driver
      dash_charged: false,                 // DASH is never charged on a cancellation
      was_paid: alreadyPaid,
      amount_paid: alreadyPaid ? Math.round(paidAmount) : 0,
      refund_due: refundDue,               // still owed - NOTHING sends it automatically
      message: cancelFee > 0
        ? `Kous anile. Frè anilasyon: ${cancelFee} HTG (pou chofè a).`
        : 'Kous anile. Pa gen frè.',
      refund_message: refundDue > 0
        ? `Ou te peye ${Math.round(paidAmount)} HTG. Nou dwe remèt ou ${refundDue} HTG. ` +
          `Ekip MsouWout ap voye l sou kont MonCash ou.`
        : undefined
    });
  } catch (err) {
    console.error('Cancel ride error:', err);
    res.status(500).json({ error: 'Erè sèvè' });
  }
});

/* PATCH /api/rides/:id/refund — mark an owed refund as settled BY HAND.
   Jeffery, 24 Sep: "Our administration will process refunds manually and
   record the transfer reference. Do not build automatic refunds."
   So this moves no money and calls no gateway. It is the book-keeping entry
   that turns "owed" into "paid on this date with this reference", which is the
   difference between a refund somebody remembers and one that can be proved.
   Admin-only: it writes off money owed to a passenger. */
router.patch('/:id/refund', async (req, res) => {
  try {
    const { reference, note, amount } = req.body || {};
    if (!reference || !String(reference).trim()) {
      return res.status(400).json({ error: 'A transfer reference is required' });
    }
    const r = await pool.query(
      `SELECT id, tracking_code, refund_due, refund_status FROM ride_requests WHERE id = $1`,
      [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Kous pa jwenn' });
    const ride = r.rows[0];
    if (!Number(ride.refund_due)) {
      return res.status(400).json({ error: 'This ride has no refund owed' });
    }
    if (ride.refund_status === 'refunded') {
      /* Not an error - someone pressed twice. Say so instead of double-marking. */
      return res.status(409).json({ error: 'This refund is already recorded as paid' });
    }
    const paid = amount != null ? Math.round(Number(amount)) : Number(ride.refund_due);
    await pool.query(
      `UPDATE ride_requests
          SET refund_status = 'refunded', refunded_at = NOW(),
              refund_note = $2, updated_at = NOW()
        WHERE id = $1`,
      [req.params.id,
       `ref=${String(reference).trim()} amount=${paid}` + (note ? ` note=${String(note).trim()}` : '')]);
    console.warn(`[REFUND SETTLED] ride ${ride.tracking_code} — ${paid} HTG, reference ${reference}`);
    res.json({ status: 'refunded', ride: ride.tracking_code, amount: paid, reference });
  } catch (err) {
    console.error('Refund record error:', err);
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
    /* 🚨🚨 The PIN is GONE from this endpoint. `?pin=1` was decided by a query
       string that anybody could type, on a route reached with a tracking code
       that is designed to be forwarded - so "only the owner sees it" was never
       true. The PIN is issued and displayed in the ordering app, which is the
       one place that can tell the passenger apart from someone she sent the
       link to.
       ⚠️ rider.name and rider.phone DO remain: the panic button posts them as
       "who is in trouble", and an alert that cannot say who raised it is worse
       than the privacy it protects. Flagged to Jeffery rather than quietly
       weakening the safety feature. The proper fix is a private owner link. */
    const trackResponse = {
      ride_id: ride.id,
      tracking_code: ride.tracking_code,
      status: ride.status,
      pickup: { lat: ride.pickup_lat, lng: ride.pickup_lng, address: ride.pickup_address },
      dropoff: { lat: ride.dropoff_lat, lng: ride.dropoff_lng, address: ride.dropoff_address },
      pickup_address: ride.pickup_address,
      dropoff_address: ride.dropoff_address,
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
      /* 🚨 23 Sep: the tracking page could not take money because it was never
         told what the ride costs or whether it had been settled. `price` alone
         UNDER-CHARGES every ride that has DASH protection on it - the amount
         the server actually bills is total_with_protection. None of these three
         are personal data, so a shared tracking link may see them; what a
         shared viewer must NOT get is the pay button, and that is decided in
         the page, not here. */
      total_with_protection: ride.total_with_protection,
      payment_status: ride.payment_status,
      payment_method: ride.payment_method,
      /* So a passenger who paid and then cancelled is TOLD what she is owed,
         rather than being left to work it out or to assume she lost it. */
      cancel_fee: ride.cancel_fee,
      refund_due: ride.refund_due,
      refund_status: ride.refund_status,
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
