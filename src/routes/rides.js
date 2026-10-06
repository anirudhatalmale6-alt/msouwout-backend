const express = require('express');
const router = express.Router();

/* ───────────────────────────────────────────────────────────────────────────
   🚨 owner_token NEVER LEAVES EXCEPT WHERE IT IS MEANT TO.

   Found within an hour of shipping the private booking link, by reading a live
   response instead of trusting the design: GET /api/rides/:id does
   `SELECT * FROM ride_requests` and answers anybody. So the whole gate was
   walk-around-able -

     family link -> /track returns ride_id -> GET /api/rides/<ride_id>
                 -> owner_token -> full owner access.

   A secret is only as private as the *least* careful query that touches the
   row, and this table is read by `SELECT *` in a dozen places. Guarding the
   ones I can think of today guards nothing tomorrow.

   So it is DENY BY DEFAULT: every JSON body leaving this router has
   owner_token stripped, recursively, unless the handler has explicitly said
   `res.locals.sendOwnerToken = true`. Exactly ONE does: creating the ride,
   which is the moment she is given it. The owner's /track does not need it -
   it returns her PIN and her details, never the key itself. A route added
   next month is safe without its author having to know this file exists. */
function stripOwnerToken(value, depth = 0) {
  if (depth > 8 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) { value.forEach(v => stripOwnerToken(v, depth + 1)); return value; }
  if ('owner_token' in value) delete value.owner_token;
  for (const k of Object.keys(value)) stripOwnerToken(value[k], depth + 1);
  return value;
}
router.use((req, res, next) => {
  const send = res.json.bind(res);
  res.json = body => send(res.locals.sendOwnerToken ? body : stripOwnerToken(body));
  next();
});
const { v4: uuidv4 } = require('uuid');
const pool = require('../db/pool');
const pricing = require('../services/pricing');
const earnings = require('../services/earnings');
const dispatch = require('../services/dispatch');
const alerts = require('../services/driverAlerts');

// POST /api/rides/account/delete — user-initiated deletion of a rider's data
// Required by App Store Guideline 5.1.1(v).
router.post('/account/delete', async (req, res) => {
  const client = await pool.connect();
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'Phone number is required' });
    const clean = phone.replace(/[^0-9+]/g, '');

    const mine = await client.query(
      'SELECT id FROM ride_requests WHERE customer_phone = $1 OR customer_phone = $2',
      [clean, phone.trim()]);
    const ids = mine.rows.map(r => r.id);
    if (!ids.length) return res.json({ deleted: true, rides: 0, note: 'No such account.' });

    await client.query('BEGIN');

    /* 🚨 28 Sep. This was a bare DELETE, and ANY row pointing at the ride made
       it fail with "Delete failed": a safety alert, a shared family link, a GPS
       checkpoint, a message. So a passenger who had ever pressed the panic
       button could NEVER delete her account - and account deletion is App Store
       Guideline 5.1.1(v), the same rule that already forced the driver-side fix.
       I hit it myself clearing up after a live test.

       The tables that point at a ride are read from the catalog rather than
       listed here, so a table added next month cannot quietly re-break this. */
    const refs = await client.query(`
      SELECT tc.table_name, kcu.column_name, col.is_nullable
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON kcu.constraint_name = tc.constraint_name
        JOIN information_schema.constraint_column_usage ccu
          ON ccu.constraint_name = tc.constraint_name
        JOIN information_schema.columns col
          ON col.table_name = tc.table_name AND col.column_name = kcu.column_name
       WHERE tc.constraint_type = 'FOREIGN KEY'
         AND ccu.table_name = 'ride_requests'
         AND tc.table_name <> 'ride_requests'`);

    const cleared = [];
    for (const r of refs.rows) {
      /* Identifiers come from the catalog, never from the request. A nullable
         column is detached so an accounting row survives; a required one goes,
         because it only exists to describe a ride that is being erased. */
      const sql = r.is_nullable === 'YES'
        ? `UPDATE "${r.table_name}" SET "${r.column_name}" = NULL WHERE "${r.column_name}" = ANY($1::uuid[])`
        : `DELETE FROM "${r.table_name}" WHERE "${r.column_name}" = ANY($1::uuid[])`;
      const out = await client.query(sql, [ids]);
      if (out.rowCount) cleared.push(`${r.table_name}.${r.column_name}:${out.rowCount}`);
    }

    /* payments.subject_id is deliberately NOT a foreign key - a payment is
       taken against a SUBJECT, which may be a ride, an order or a ticket - so
       the catalog above cannot see it. Named here for that reason. ⛔ The
       payment ROW is kept: it is a money record and it outlives the ride. Only
       the link back to the deleted person is cut. */
    const pay = await client.query(
      `UPDATE payments SET subject_id = NULL
        WHERE subject_type = 'ride' AND subject_id = ANY($1::text[])`,
      [ids.map(String)]);
    if (pay.rowCount) cleared.push('payments.subject_id:' + pay.rowCount);

    const del = await client.query('DELETE FROM ride_requests WHERE id = ANY($1::uuid[])', [ids]);
    await client.query('COMMIT');

    console.warn(`[RIDER DELETE] removed ${del.rowCount} ride(s); cleared ${cleared.join(', ') || 'nothing'}`);
    res.json({ deleted: true, rides: del.rowCount, cleared });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('Rider delete error:', err);
    res.status(500).json({ error: 'Delete failed' });
  } finally {
    client.release();
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
    /* The passenger's private key to her own booking. 32 hex characters from
       the OS random source - it is the only thing standing between a
       forwarded family link and her name, her number and her PIN, so it must
       not come from Math.random(). Returned exactly once, at creation. */
    /* 🚨 28 Sep: "Cash must NOT come back. MsouWout is cashless."
       Wilkendy's ride was recorded as cash, because the default was cash and
       nothing refused it. The server decides now - a request asking for cash
       gets a digital method, it does not get a cash ride. */
    const DIGITAL = ['moncash', 'natcash', 'all'];
    const asked = String(payment_method || '').toLowerCase().trim();
    const chosenMethod = DIGITAL.includes(asked) ? asked : 'moncash';
    if (asked && !DIGITAL.includes(asked)) {
      console.warn(`[RIDES] refused payment_method "${asked}" - MsouWout is cashless`);
    }

    const ownerToken = require('crypto').randomBytes(16).toString('hex');

    /* ⛔ NO DUPLICATE BOOKINGS. The browser sends the same id for every retry
       of one booking attempt. If we have already made that ride, hand the SAME
       one back - key and all - instead of booking a second car. Checked before
       the insert for the common case, and caught again on the unique index
       below for the case where two retries arrive at once. */
    const clientReqId = String((req.body || {}).client_request_id || '').slice(0, 64) || null;
    if (clientReqId) {
      const seen = await pool.query(
        `SELECT id, tracking_code, ride_pin, owner_token, status, price,
                total_with_protection, pickup_address, dropoff_address
           FROM ride_requests WHERE client_request_id = $1`, [clientReqId]);
      if (seen.rows.length) {
        const r0 = seen.rows[0];
        console.warn(`[RIDES] replayed booking ${clientReqId} -> ${r0.tracking_code}`);
        res.locals.sendOwnerToken = true;
        return res.status(201).json({
          ride_id: r0.id, tracking_code: r0.tracking_code, ride_pin: r0.ride_pin,
          owner_token: r0.owner_token, status: r0.status, price: r0.price,
          total_with_protection: r0.total_with_protection,
          pickup_address: r0.pickup_address, dropoff_address: r0.dropoff_address,
          duplicate: true, message: 'Kous ou deja anrejistre.'
        });
      }
    }

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
        pickup_address, dropoff_address, owner_token, client_request_id,
        created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'searching',
               $18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,NOW())`,
      [rideId, customer_name || 'Kliyan', customer_phone, user_id || null,
       pickupLat, pickupLng, dropoffLat, dropoffLng,
       rideType, estimate.distance_km, estimate.duration_min, finalPrice,
       commission.platform_fee, commission.driver_earning,
       chosenMethod, trackingCode, ridePin,
       wantsMedical, medicalFee, dashFee, msouwoutMedicalFee, driverDashShare, totalWithProtection,
       delegated, delegated ? (orderer_name || customer_name || 'Kliyan') : null,
       delegated ? (orderer_phone || customer_phone) : null,
       delegated ? passenger_name : null, delegated ? passenger_phone : null,
       from.address, to.address, ownerToken, clientReqId]
    );
    }

    const response = {
      ride_id: rideId,
      tracking_code: trackingCode,
      ride_pin: ridePin,
      /* ⚠️ One of only two responses allowed to carry it - see the strip
         middleware at the top of this file. The ordering app keeps it and puts
         it in the passenger's own link; nothing else can ask for it later. */
      owner_token: ownerToken,
      status: 'searching',
      pickup_address: from.address,
      dropoff_address: to.address,
      distance_km: estimate.distance_km,
      duration_min: estimate.duration_min,
      price: finalPrice,
      platform_fee: commission.platform_fee,
      driver_earning: commission.driver_earning,
      payment_method: chosenMethod,
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

    /* 🚨 Tell her NOW if there is realistically nobody to come. The ride is
       still created - she may want to wait anyway, and refusing outright would
       lose a fare we could have served ten minutes later - but she is told the
       truth instead of watching a spinner for five hours. */
    try {
      const cov = await dispatch.coverage(pickupLat, pickupLng, rideType);
      response.coverage = cov;
      if (!cov.covered) {
        response.no_driver_nearby = true;
        response.no_driver_message =
          cov.reason === 'too_far'
            ? `Chofè ki pi pre a a ${cov.nearest_km} km. Sa ka pran anpil tan. Ou ka tann, oswa ekri nou sou WhatsApp.`
            : 'Nou pa wè okenn chofè toupre ou kounye a. Ou ka tann, oswa ekri nou sou WhatsApp.';
        await pool.query('UPDATE ride_requests SET no_driver_warned = true WHERE id = $1', [rideId]);
        console.warn(`[DISPATCH] ${trackingCode} booked with no driver in range (online=${cov.drivers_online}, nearest=${cov.nearest_km}km)`);
      }
    } catch (e) {
      /* A coverage check that fails must never stop a booking. */
      console.error('[DISPATCH] coverage check failed:', e.message);
    }

    /* ⛔ Not awaited. A slow push service must never make her booking slow,
       and a broken one must never make it fail. The driver board is still the
       system of record; this only means he does not have to be staring at it. */
    alerts.alertNewRide({
      id: rideId, tracking_code: trackingCode, price: finalPrice,
      pickup_address: from.address, dropoff_address: to.address
    }).catch(e => console.error('[ALERTS] could not notify drivers:', e.message));

    res.locals.sendOwnerToken = true;      // creating the ride: she must receive it
    res.status(201).json(response);
  } catch (err) {
    /* 23505 = unique_violation on client_request_id: two retries of the SAME
       booking arrived close enough together that both passed the check above.
       The first one won and made the ride; this one must hand back that ride,
       not an error and certainly not a second car. */
    if (err && err.code === '23505' && /client_request/.test(err.constraint || err.detail || '')) {
      try {
        const again = await pool.query(
          `SELECT id, tracking_code, ride_pin, owner_token, status, price,
                  total_with_protection, pickup_address, dropoff_address
             FROM ride_requests WHERE client_request_id = $1`,
          [String((req.body || {}).client_request_id || '').slice(0, 64)]);
        if (again.rows.length) {
          const r1 = again.rows[0];
          console.warn(`[RIDES] duplicate booking race resolved -> ${r1.tracking_code}`);
          res.locals.sendOwnerToken = true;
          return res.status(201).json({
            ride_id: r1.id, tracking_code: r1.tracking_code, ride_pin: r1.ride_pin,
            owner_token: r1.owner_token, status: r1.status, price: r1.price,
            total_with_protection: r1.total_with_protection,
            pickup_address: r1.pickup_address, dropoff_address: r1.dropoff_address,
            duplicate: true, message: 'Kous ou deja anrejistre.'
          });
        }
      } catch (e2) { console.error('duplicate replay failed:', e2.message); }
    }
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

/* GET /api/rides/reports/attention — the rides a PERSON has to settle (admin).
 *
 * Two kinds, and neither may be decided by a timer:
 *   - she paid and no driver ever came (needs a refund decision)
 *   - a driver started a ride and never finished it (needs the truth about
 *     whether it happened, and it is silently keeping him from taking work)
 *
 * 🚨 The first list already existed and was called from nowhere at all. A
 * report nobody reads is not a report. */
router.get('/reports/attention', async (req, res) => {
  try {
    res.json(await dispatch.needsAttention());
  } catch (err) {
    console.error('Attention report error:', err);
    res.status(500).json({ error: 'Failed to build the report' });
  }
});

// GET /api/rides/reports/money — Money split & settlement report (admin)
// Every completed ride contributes three lines: driver payout, DASH fund, MsouWout revenue.
// Defaults to the last 24 hours (the payout/settlement window) plus a 7-day daily series.
/* ═══ THE DASH PARTNER PORTAL ════════════════════════════════════════════
   Jeffery, 6 Oct 2026: "I have a meeting with dash and need to show them their
   dashboard and how it worked especially we made 2 real paid rides already."

   The portal page showed ZEROS, because it never asked the server anything -
   it was a static mock-up. He was about to present it to the partner it was
   built for, after two real rides had already collected their fee.

   🔑 WHAT THIS DELIBERATELY DOES NOT RETURN: no passenger name, no telephone
   number, no address, no driver name. DASH is owed a FEE, not a ride history.
   Aggregates and a reference code are everything the partner needs to reconcile
   a bank transfer, and nothing more.

   Guarded by DASH_PORTAL_KEY so the ride volume of the whole company is not a
   public figure. Fails CLOSED when the key is unset.                          */
router.get('/dash/summary', async (req, res) => {
  try {
    const expected = process.env.DASH_PORTAL_KEY;
    if (!expected) return res.status(503).json({ error: 'portal not configured' });
    const given = String(req.get('x-dash-key') || req.query.k || '');
    const a = Buffer.from(given), b = Buffer.from(expected);
    if (a.length !== b.length || !require('crypto').timingSafeEqual(a, b)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    /* dash_fee is the WHOLE protection pot for a ride (rider half + driver
       half). The passenger's receipt shows only her half, which is why a
       receipt says 13 and the partner is owed 25. */
    /* 🚨🚨 ONLY RIDES THAT WERE ACTUALLY PAID COUNT AS MONEY OWED.
       The first version of this counted every COMPLETED ride with protection
       on it - which swept in the September test rides, and would have shown
       the partner 9 rides and 180 HTG when two rides had genuinely been paid.
       A fee is owed when a passenger has paid it, not when somebody pressed
       Fini on a test. Both figures are returned so the difference is visible
       rather than hidden. */
    const PAID = "LOWER(COALESCE(payment_status,'')) = 'paid'";
    const totals = await pool.query(
      `SELECT COUNT(*) FILTER (WHERE ${PAID})::int                       AS rides,
              COALESCE(SUM(dash_fee)       FILTER (WHERE ${PAID}),0)::int AS collected,
              COALESCE(SUM(medical_fee)    FILTER (WHERE ${PAID}),0)::int AS rider_paid,
              COUNT(*)::int                                              AS rides_all,
              COALESCE(SUM(dash_fee),0)::int                             AS collected_all,
              MIN(completed_at) FILTER (WHERE ${PAID})                   AS first_ride,
              MAX(completed_at) FILTER (WHERE ${PAID})                   AS last_ride
         FROM ride_requests
        WHERE status='completed' AND COALESCE(medical_protection,false)=true`);

    const monthly = await pool.query(
      `SELECT to_char(date_trunc('month', completed_at),'YYYY-MM') AS period,
              COUNT(*)::int                          AS rides,
              COALESCE(SUM(dash_fee),0)::int         AS collected
         FROM ride_requests
        WHERE status='completed' AND COALESCE(medical_protection,false)=true
          AND LOWER(COALESCE(payment_status,'')) = 'paid'
        GROUP BY 1 ORDER BY 1 DESC LIMIT 24`);

    /* Reference code and amount only - enough to tie a transfer to a ride. */
    const recent = await pool.query(
      `SELECT tracking_code, completed_at, COALESCE(dash_fee,0)::int AS fee,
              LOWER(COALESCE(payment_status,'')) AS paid_status
         FROM ride_requests
        WHERE status='completed' AND COALESCE(medical_protection,false)=true
          AND LOWER(COALESCE(payment_status,'')) = 'paid'
        ORDER BY completed_at DESC LIMIT 20`);

    const incidents = await pool.query(
      `SELECT COUNT(*)::int AS n FROM ride_requests
        WHERE safety_state IS NOT NULL AND safety_state <> ''`);

    const t = totals.rows[0];
    res.json({
      rides: t.rides, collected: t.collected, rider_paid: t.rider_paid,
      owed: t.collected,                 /* nothing has been transferred yet */
      /* completed-but-never-paid, i.e. the test rides. Shown so nobody has to
         wonder why the portal and the ride list disagree. */
      rides_completed_unpaid: t.rides_all - t.rides,
      collected_if_unpaid_counted: t.collected_all,
      first_ride: t.first_ride, last_ride: t.last_ride,
      incidents: incidents.rows[0].n,
      monthly: monthly.rows,
      recent: recent.rows,
      generated_at: new Date().toISOString()
    });
  } catch (err) {
    console.error('DASH summary error:', err);
    res.status(500).json({ error: 'Erè sèvè' });
  }
});

router.get('/reports/money', async (req, res) => {
  try {
    /* The gate for this route is middleware/adminOnly, mounted app-wide before
       the routers. It accepts EITHER ADMIN_SECRET or the stored admin
       password; the check that used to live here knew only the first, which
       is the one nobody has. Removing it does not open the door - it stops the
       door refusing the person holding the key. */

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
    /* 🚨 28 Sep - THE OTHER HALF OF THE WILKENDY FAULT. This used to hide any
       ride older than the window the app asked for (the driver app asks for
       120 minutes), while leaving it 'searching' in the database for ever. His
       booking became invisible to every driver at 19:54 and stayed open until
       I closed it by hand.

       The time filter is gone. 'searching' now genuinely means live, because
       services/dispatch.js ENDS the ones nobody accepted instead of letting
       them rot. A ride is either on the board or it is closed - never both,
       never neither. `minutes` is still accepted so an older driver app does
       not break, but it can only NARROW the board, never hide a live ride from
       everybody. */
    const askedMinutes = parseInt(req.query.minutes, 10);
    const params = [];
    let where = `WHERE r.status = 'searching'`;

    /* ⛔ A demo account never SEES a real passenger either. Accepting is already
       refused, but this board carries her name, her telephone number and the
       street she is standing on - so the reviewer's account is shown an empty
       board rather than a list of real people. He still signs in, still has his
       completed demo history, and the app still reviews. */
    if (req.query.driver_id && /^[0-9a-f-]{36}$/i.test(String(req.query.driver_id))) {
      const who = await pool.query('SELECT is_test_account FROM drivers WHERE id = $1',
                                   [req.query.driver_id]);
      if (who.rows.length && who.rows[0].is_test_account) {
        return res.json({ rides: [], test_account: true,
          message: 'Kont demo — pa gen kous reyèl.' });
      }
    }
    if (Number.isFinite(askedMinutes) && askedMinutes > 0 && askedMinutes < 60) {
      where += ` AND r.created_at > NOW() - INTERVAL '${Math.floor(askedMinutes)} minutes'`;
    }
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
          alert flipped its status to 'monitoring' (routes/safety.js). That
          overwrite is GONE - safety has its own column - so the two real
          in-flight states are the only ones needed here. This
          query did not list that status, so the endpoint returned {ride:null}
          and the ride became invisible to its own driver - it could not be
          completed and could not be paid. A safety alert must never take the
          ride off the driver's screen; that is when he needs it most. */
       WHERE r.driver_id = $1 AND r.status IN ('accepted','in_progress')
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

    /* 🚨 28 Sep, Jeffery: "Do not allow +509 0000 0000 to receive or accept real
       customer rides." The account exists because Apple rejected 1.0(7) when a
       reviewer could not sign in, so it cannot simply be switched off - but a
       real passenger must never be handed to it. Refused HERE, at the moment of
       accepting, rather than only hidden from the board: hiding is a display
       decision and this is a rule. */
    if (driver.rows[0].is_test_account) {
      console.warn('[DISPATCH] refused: test account ' + driver.rows[0].phone +
                   ' tried to accept real ride ' + ride.rows[0].tracking_code);
      return res.status(403).json({
        error: 'Kont demo a pa ka pran yon kous reyèl.',
        code: 'test_account' });
    }

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

    /* 🚨 Write who is owed what, now that the ride is finished. This used to be
       computed for the response below and thrown away, which is why nothing
       could ever answer "what does this driver have coming?"
       Deliberately not awaited into the response path's success: a ledger
       problem must never stop a driver marking his ride complete. It is safe
       to run late or twice - (ride_id, recipient_type) is unique. */
    earnings.recordForRide(req.params.id)
      .catch(e => console.error('[EARNINGS] could not record for ride', r.tracking_code, e.message));

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

    /* 🚨 24 Sep — REASSIGNMENT. Jeffery: "If a driver cancels a prepaid ride,
       keep the payment attached to the booking and search for another verified
       driver. The passenger must not pay twice."
       So a DRIVER walking away from a ride the passenger has already paid for
       does not cancel the booking - it goes back on the board. The payment row
       is untouched, payment_status stays 'paid', and nothing is owed back
       because nothing is being given back. The passenger keeps her tracking
       code, her PIN and her place.
       Her own cancel is unaffected: she can still cancel and then the refund is
       recorded as before. */
    if (cancelledBy === 'driver' &&
        String(r.payment_status || '').toLowerCase() === 'paid' &&
        ['accepted', 'in_progress'].includes(r.status)) {
      await pool.query(
        `UPDATE ride_requests
            SET status = 'searching', driver_id = NULL, accepted_at = NULL,
                arrived_at = NULL, started_at = NULL,
                reassigned_count = COALESCE(reassigned_count, 0) + 1,
                cancel_reason = $2, updated_at = NOW()
          WHERE id = $1`,
        [req.params.id,
         `driver released a paid ride: ${reason || 'no reason given'}`]);
      console.warn(`[REASSIGN] ride ${r.tracking_code} — driver left a PAID ride; ` +
                   `back to searching, payment kept`);
      return res.json({
        status: 'searching',
        reassigned: true,
        cancel_fee: 0,
        payment_kept: true,
        message: 'Chofè a pa ka fè kous la. N ap chèche yon lòt chofè pou ou — ou pa bezwen peye ankò.'
      });
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

    /* 🚨 28 Sep: "She cancelled it but i never received a text."
       Until now alertNewRide was the ONLY notification in the whole system -
       a driver was told when work ARRIVED and never when it went away, so he
       could be riding to a passenger who cancelled ten minutes earlier.
       ⛔ Not awaited: a slow push service must never slow down a cancellation,
       and a broken one must never fail it. */
    if (r.driver_id && cancelledBy === 'rider') {
      alerts.alertRideGone(r.driver_id, r, 'cancelled_by_rider')
        .catch(e => console.error('[ALERTS] cancel notice failed (ride still cancelled):', e.message));
    }

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

/* GET /api/rides/earnings/owed — what is owed, grouped for a payout run.
   READ ONLY, and admin-only: it lists drivers, their payout numbers and what
   each is due. Nothing here moves money; the response says so out loud. */
router.get('/earnings/owed', async (req, res) => {
  try {
    res.json(await earnings.owed({
      since: req.query.since || null,
      until: req.query.until || null,
      recipient_type: req.query.type || null
    }));
  } catch (err) {
    console.error('Earnings read error:', err);
    res.status(500).json({ error: 'Erè sèvè' });
  }
});

/* POST /api/rides/earnings/backfill — record entitlements for rides that
   finished before the ledger existed. Idempotent: the unique constraint turns
   a second run into a no-op rather than a second payment. */
router.post('/earnings/backfill', async (req, res) => {
  try {
    const out = await earnings.backfill(Math.min(2000, parseInt(req.body && req.body.limit) || 500));
    console.warn(`[EARNINGS] backfill recorded ${out.rows} entitlement(s) across ${out.rides} ride(s)`);
    res.json({ ...out, note: 'Recorded as owed. Nothing has been paid.' });
  } catch (err) {
    console.error('Earnings backfill error:', err);
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
/* ───────────────────────────────────────────────────────────────────────────
   "Fix the PIN recovery problem properly. We cannot have passengers contacting
   you to retrieve their PIN manually." - 27 Sep.

   The PIN and the private key are sent once, in the answer to the booking. If
   that answer is lost, or she clears her browser, or opens her link on another
   phone, she has neither - and the only route back was me reading it off the
   database. That is not a product.

   She proves who she is with the PHONE NUMBER SHE BOOKED WITH. That is the
   same bar the rest of the passenger side uses, and it is a real second factor
   here: the tracking code alone does not open it, and the phone number alone
   is useless without the code.

   ⚠️ The answer is deliberately the SAME for "no such ride" and "wrong
   number". Different answers turn this into a way to ask which phone number
   booked a given ride.
   =========================================================================== */
/* She has been told nobody has accepted yet and pressed "keep waiting".
   ⛔ Deliberately NOT owner-gated: the alternative is a passenger who cannot
   keep her own ride alive because the answer to her booking got lost. The
   worst a stranger can do here is keep somebody's ride open longer. */
router.post('/:id/keep-waiting', async (req, res) => {
  try {
    const param = req.params.id;
    const isUUID = /^[0-9a-f]{8}-/.test(param);
    const q = await pool.query(
      `UPDATE ride_requests
          SET keep_waiting_until = NOW() + make_interval(mins => $1), updated_at = NOW()
        WHERE ${isUUID ? 'id = $2' : 'tracking_code = $2'} AND status = 'searching'
        RETURNING tracking_code, keep_waiting_until`,
      [dispatch.KEEP_WAITING_MIN, param]);
    if (!q.rows.length) {
      return res.status(409).json({ error: 'Kous sa a pa ap chèche chofè ankò.' });
    }
    res.json({ ok: true, keep_waiting_until: q.rows[0].keep_waiting_until,
               minutes: dispatch.KEEP_WAITING_MIN });
  } catch (err) {
    console.error('keep-waiting error:', err);
    res.status(500).json({ error: 'Erè sèvè' });
  }
});

router.post('/:id/recover', async (req, res) => {
  try {
    const param = req.params.id;
    const given = String((req.body || {}).phone || '').replace(/[^0-9]/g, '');
    if (given.length < 6) {
      return res.status(400).json({ error: 'Mete nimewo telefòn ou te itilize pou kòmande a.' });
    }
    const isUUID = /^[0-9a-f]{8}-/.test(param);
    const q = await pool.query(
      `SELECT id, tracking_code, ride_pin, owner_token, status,
              customer_phone, passenger_phone, orderer_phone, is_delegated
         FROM ride_requests WHERE ${isUUID ? 'id = $1' : 'tracking_code = $1'}`, [param]);

    const DENY = { error: 'Nou pa jwenn yon kous ki gen nimewo sa a.' };
    if (!q.rows.length) return res.status(404).json(DENY);
    const ride = q.rows[0];

    /* Any of the numbers attached to the ride may claim it: on a delegated
       ride the person IN the car is not the person who ordered it, and both
       have a legitimate need for the PIN. Compared on the last 8 digits so
       +509 / 509 / bare local all match. */
    const tail = v => String(v || '').replace(/[^0-9]/g, '').slice(-8);
    const mine = tail(given);
    const allowed = [ride.customer_phone, ride.passenger_phone, ride.orderer_phone]
      .map(tail).filter(Boolean);
    if (!mine || !allowed.includes(mine)) return res.status(404).json(DENY);

    if (['completed', 'cancelled'].includes(ride.status)) {
      return res.status(409).json({ error: 'Kous sa a fini deja.', status: ride.status });
    }

    console.warn(`[RECOVER] PIN + key re-issued for ${ride.tracking_code}`);
    /* Hand back BOTH. The key is what makes her own page work again - without
       it she would recover the PIN and still be treated as a stranger. */
    res.locals.sendOwnerToken = true;
    res.json({
      ok: true,
      ride_id: ride.id,
      tracking_code: ride.tracking_code,
      ride_pin: ride.ride_pin,
      owner_token: ride.owner_token,
      status: ride.status
    });
  } catch (err) {
    console.error('Recover error:', err);
    res.status(500).json({ error: 'Erè sèvè' });
  }
});

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

    /* ── WHO IS ASKING ────────────────────────────────────────────────────
       27 Sep, his words: "Separate the passenger's private booking page from
       the family tracking link."

       The answer is a secret the viewer cannot invent. `?t=` is compared
       against owner_token, which was handed to the ordering app once and never
       again. It is NOT `?shared=1`, which is what this used to turn on - the
       viewer types that, so a forwarded link became an owner link by deleting
       four characters.

       Compared in constant time: a plain === on a secret leaks its prefix to
       anyone patient enough to time the answers. */
    const givenToken = String(req.query.t || req.headers['x-ride-token'] || '');
    const isOwner = (() => {
      if (!ride.owner_token || !givenToken) return false;
      const a = Buffer.from(givenToken, 'utf8');
      const b = Buffer.from(String(ride.owner_token), 'utf8');
      return a.length === b.length && require('crypto').timingSafeEqual(a, b);
    })();
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
      /* ⛔ The family link gets NOTHING that identifies the passenger. Her
         name and number are the whole reason this separation exists, so they
         are attached below only when the token matched - never here, where a
         later edit could widen them back without anyone noticing. */
      is_owner: isOwner,
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
      /* So the page can say "your driver could not make it, we are finding
         another one" instead of silently dropping back to a searching screen
         that looks like the ride was never accepted. */
      reassigned_count: ride.reassigned_count || 0,
      /* A flag ABOUT the ride, beside it - never instead of its status. */
      safety_state: ride.safety_state || null,
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

    /* How long she has been waiting, and whether we are still promising
       anything. Read-only, so polling it costs nothing. */
    Object.assign(trackResponse, dispatch.waitState(ride));
    trackResponse.expired = ride.status === 'expired';
    if (ride.status === 'expired') trackResponse.expire_reason = ride.expire_reason;

    /* Owner-only. Everything here is either personal data or a credential. */
    if (isOwner) {
      trackResponse.rider = { name: ride.customer_name, phone: ride.customer_phone };
      /* The PIN comes back for the owner. It used to be read out of
         localStorage, which loses it the moment she clears her browser or
         opens the link on a different phone - and then she cannot start the
         ride she paid for. A 32-character secret in the URL is a better key
         than a value the browser may silently discard. */
      trackResponse.ride_pin = ride.ride_pin;
    }

    res.json(trackResponse);
  } catch (err) {
    console.error('Track ride error:', err);
    res.status(500).json({ error: 'Erè sèvè' });
  }
});

module.exports = router;
