const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { v4: uuidv4 } = require('uuid');

/* ═══ DASH's EMERGENCY CONTACT ════════════════════════════════════════════
 *
 * 🚨🚨 9 Oct 2026: THE FACILITY LIST THAT USED TO LIVE HERE WAS A SECOND,
 * DIFFERENT, WRONG COPY.
 *
 * Jeffery, 8 Oct, about the dashboard: "The list in the app is fictif." I
 * fixed the dashboard and moved its list into the database. This one - the
 * one the EMERGENCY LOCATOR reads, the page somebody opens after a crash -
 * was still hard-coded here and was worse:
 *
 *   - it carried three structures that are not on DASH's list at all
 *     (Saint Esprit, Sainte Gene, DASH Centre-Ville CMC);
 *   - it was missing five that are (OMNI Per Mariam, Ste-Cène, St James,
 *     Sonapi, Oswald Durand);
 *   - and it listed FOUR that DASH says are temporarily unavailable for
 *     security reasons, with nothing to say so. The locator would happily
 *     answer "nearest: Hôpital Jude Anne" and send an injured passenger to a
 *     door that is shut.
 *   - every telephone number was the DASH switchboard, not the clinic's.
 *
 * ⛔ The coordinates have NOT been carried over. Several were plainly
 * approximate and one put DASH Carries near Gonaïves. A GPS pin for a
 * hospital is not something I am prepared to invent: being confidently wrong
 * about where a clinic is, in an emergency, is worse than saying the address.
 * lat/lng are now a nullable column DASH can fill in from dash-clinics.html,
 * and a structure without them is still listed - with its address and its own
 * telephone number - just without a distance claimed for it.
 * ═══════════════════════════════════════════════════════════════════════════ */
const DASH_CONFIG = {
  emergency_phone: '+50933333274',
  emergency_whatsapp: '+50933333274',
  name: 'DASH Medical Assistance',
  website: 'www.dashhaiti.org'
};

/* The structures, from the table dash-clinics.html maintains. Cached for a
   minute: an accident report must not wait on a database round trip, and the
   list changes a few times a year. */
let facCache = { at: 0, rows: [] };
async function loadFacilities() {
  if (Date.now() - facCache.at < 60000 && facCache.rows.length) return facCache.rows;
  const { rows } = await pool.query(
    `SELECT name, address, phones, city, status, lat, lng
       FROM dash_clinics ORDER BY sort_order ASC, name ASC`);
  const out = rows.map(r => ({
    name: r.name,
    address: r.address || '',
    phone: r.phones || DASH_CONFIG.emergency_phone,
    city: r.city || '',
    status: r.status,
    available: r.status === 'open',
    lat: r.lat === null ? null : Number(r.lat),
    lng: r.lng === null ? null : Number(r.lng),
    type: /clinique|dash /i.test(r.name) ? 'clinic' : 'hospital'
  }));
  if (out.length) facCache = { at: Date.now(), rows: out };
  return out;
}

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/* 🚨 ONLY STRUCTURES THAT ARE ACTUALLY OPEN can be "the nearest one". A
   closed site is returned separately so the page can show it greyed - a
   structure that silently disappears looks exactly like one that never
   existed, and somebody needs to know not to drive there.

   ⛔ A distance is only ever reported for a structure whose coordinates we
   actually hold. The rest are listed after, with no distance, rather than
   being dropped or given a made-up one. */
async function findNearestFacilities(lat, lng, limit) {
  const all = await loadFacilities();
  const open = all.filter(f => f.available);
  const n = limit || 3;
  const haveGps = Number.isFinite(lat) && Number.isFinite(lng);

  const located = open.filter(f => f.lat !== null && f.lng !== null);
  const unlocated = open.filter(f => f.lat === null || f.lng === null);

  if (!haveGps || !located.length) {
    return open.slice(0, n).map(f => Object.assign({}, f, { distance_km: null }));
  }
  const ranked = located
    .map(f => Object.assign({}, f, {
      distance_km: parseFloat(haversineKm(lat, lng, f.lat, f.lng).toFixed(1))
    }))
    .sort((a, b) => a.distance_km - b.distance_km);
  return ranked
    .concat(unlocated.map(f => Object.assign({}, f, { distance_km: null })))
    .slice(0, n);
}


// GET /api/medical/dash-info — DASH contact & facilities info (public)
router.get('/dash-info', async (req, res) => {
  try {
    const lat = parseFloat(req.query.lat), lng = parseFloat(req.query.lng);
    const all = await loadFacilities();
    const facilities = await findNearestFacilities(lat, lng, 3);
    res.json({
      emergency_phone: DASH_CONFIG.emergency_phone,
      emergency_whatsapp: DASH_CONFIG.emergency_whatsapp,
      name: DASH_CONFIG.name,
      facilities,
      /* ⛔ The unavailable ones are RETURNED, not dropped. The page greys them
         so nobody drives to a door that is shut, and nobody thinks a
         structure they know about has quietly stopped existing. */
      unavailable: all.filter(f => !f.available),
      total: all.length,
      open: all.filter(f => f.available).length,
      /* Honest about what we know. With no GPS, or with no coordinates on
         file, these are simply the open structures - not "the nearest". */
      ranked_by_distance: facilities.some(f => f.distance_km !== null),
      message_ht: 'Nou regrèt aksidan ki rive a. Pou asistans medikal imedya, tanpri kontakte DASH oswa ale nan sant medikal DASH ki pi pre w la. Klike isit la pou wè direksyon ak enfòmasyon sant la.'
    });
  } catch (err) {
    /* ⛔ An empty list and a failure are not the same thing to somebody who
       has just been in an accident. Say which, and still give them the
       telephone number - that is the part that always works. */
    res.status(500).json({
      error: err.message,
      emergency_phone: DASH_CONFIG.emergency_phone,
      emergency_whatsapp: DASH_CONFIG.emergency_whatsapp,
      facilities: null
    });
  }
});

// GET /api/medical/dashboard — Admin dashboard: total fees, DASH vs MsouWout split, settlements
router.get('/dashboard', async (req, res) => {
  try {
    const totals = await pool.query(`
      SELECT
        COUNT(*) AS total_rides,
        COUNT(*) FILTER (WHERE medical_protection = true) AS total_protected_rides,
        COALESCE(SUM(medical_fee) FILTER (WHERE medical_protection = true), 0) AS total_medical_fees,
        COALESCE(SUM(dash_fee) FILTER (WHERE medical_protection = true), 0) AS total_dash_fees,
        COALESCE(SUM(msouwout_medical_fee) FILTER (WHERE medical_protection = true), 0) AS total_msouwout_fees,
        COALESCE(SUM(price), 0) AS total_ride_revenue
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

    // Settlement data
    let settlements = { pending: [], completed: [], total_pending: 0, total_completed: 0 };
    try {
      const pendingSettlements = await pool.query(
        `SELECT * FROM dash_settlements WHERE status IN ('pending', 'processing') ORDER BY period_start DESC LIMIT 20`
      );
      const completedSettlements = await pool.query(
        `SELECT * FROM dash_settlements WHERE status = 'completed' ORDER BY transferred_at DESC LIMIT 20`
      );
      settlements.pending = pendingSettlements.rows;
      settlements.completed = completedSettlements.rows;
      settlements.total_pending = pendingSettlements.rows.reduce((s, r) => s + parseInt(r.dash_amount), 0);
      settlements.total_completed = completedSettlements.rows.reduce((s, r) => s + parseInt(r.dash_amount), 0);
    } catch (e) { /* table may not exist yet */ }

    // Accident reports
    let accidents = { total: 0, active: 0 };
    try {
      const accidentStats = await pool.query(`
        SELECT COUNT(*) AS total,
               COUNT(*) FILTER (WHERE status IN ('reported', 'dash_contacted')) AS active
        FROM accident_reports
      `);
      accidents = { total: parseInt(accidentStats.rows[0].total), active: parseInt(accidentStats.rows[0].active) };
    } catch (e) { /* table may not exist yet */ }

    // Unsettled amount (completed rides not yet in a settlement)
    let unsettled = 0;
    try {
      const unsettledQ = await pool.query(`
        SELECT COALESCE(SUM(dash_fee), 0) AS unsettled
        FROM ride_requests
        WHERE status = 'completed' AND medical_protection = true
          AND completed_at > COALESCE(
            (SELECT MAX(period_end) FROM dash_settlements WHERE status = 'completed'), '1970-01-01'::timestamptz
          )
      `);
      unsettled = parseInt(unsettledQ.rows[0].unsettled);
    } catch (e) { /* ok */ }

    res.json({
      summary: {
        total_rides: parseInt(totals.rows[0].total_rides),
        total_protected_rides: parseInt(totals.rows[0].total_protected_rides),
        total_medical_fees: parseInt(totals.rows[0].total_medical_fees),
        total_dash_fees: parseInt(totals.rows[0].total_dash_fees),
        total_msouwout_fees: parseInt(totals.rows[0].total_msouwout_fees),
        total_ride_revenue: parseInt(totals.rows[0].total_ride_revenue),
        unsettled_dash_amount: unsettled
      },
      monthly: monthly.rows,
      claims: {
        total: parseInt(claimStats.rows[0].total_claims),
        pending: parseInt(claimStats.rows[0].pending_claims),
        approved: parseInt(claimStats.rows[0].approved_claims),
        rejected: parseInt(claimStats.rows[0].rejected_claims)
      },
      settlements,
      accidents
    });
  } catch (err) {
    console.error('Medical dashboard error:', err);
    res.status(500).json({ error: 'Erè sèvè' });
  }
});

// POST /api/medical/settlement — Create a settlement record (admin)
router.post('/settlement', async (req, res) => {
  try {
    const { period_start, period_end, dash_bank_ref, notes } = req.body;
    if (!period_start || !period_end) {
      return res.status(400).json({ error: 'period_start ak period_end obligatwa' });
    }

    const rides = await pool.query(`
      SELECT COUNT(*) AS ride_count,
             COALESCE(SUM(medical_fee), 0) AS total_fees,
             COALESCE(SUM(dash_fee), 0) AS dash_total,
             COALESCE(SUM(msouwout_medical_fee), 0) AS msouwout_total
      FROM ride_requests
      WHERE status = 'completed' AND medical_protection = true
        AND completed_at >= $1 AND completed_at < $2
    `, [period_start, period_end]);

    const data = rides.rows[0];
    const id = uuidv4();

    await pool.query(
      `INSERT INTO dash_settlements (id, period_start, period_end, total_rides, total_protection_fees, dash_amount, msouwout_amount, dash_bank_ref, notes, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', NOW())`,
      [id, period_start, period_end, parseInt(data.ride_count), parseInt(data.total_fees), parseInt(data.dash_total), parseInt(data.msouwout_total), dash_bank_ref || null, notes || null]
    );

    res.status(201).json({
      settlement_id: id,
      total_rides: parseInt(data.ride_count),
      dash_amount: parseInt(data.dash_total),
      msouwout_amount: parseInt(data.msouwout_total),
      status: 'pending',
      message: 'Règleman kreye. Transfere nan kont DASH nan 24è.'
    });
  } catch (err) {
    console.error('Create settlement error:', err);
    res.status(500).json({ error: 'Erè sèvè' });
  }
});

// PATCH /api/medical/settlement/:id — Update settlement status (mark as completed)
router.patch('/settlement/:id', async (req, res) => {
  try {
    const { status, dash_bank_ref, notes } = req.body;
    const validStatuses = ['pending', 'processing', 'completed', 'failed'];
    if (!status || !validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Status pa valid' });
    }

    const updates = ['status = $1', 'updated_at = NOW()'];
    const params = [status];
    let idx = 2;

    if (status === 'completed') {
      updates.push(`transferred_at = NOW()`);
    }
    if (dash_bank_ref) {
      updates.push(`dash_bank_ref = $${idx}`);
      params.push(dash_bank_ref);
      idx++;
    }
    if (notes) {
      updates.push(`notes = $${idx}`);
      params.push(notes);
      idx++;
    }

    params.push(req.params.id);
    const result = await pool.query(
      `UPDATE dash_settlements SET ${updates.join(', ')} WHERE id = $${idx} RETURNING *`,
      params
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Règleman pa jwenn' });
    }

    res.json({ settlement: result.rows[0], message: `Règleman mete ajou: ${status}` });
  } catch (err) {
    console.error('Update settlement error:', err);
    res.status(500).json({ error: 'Erè sèvè' });
  }
});

// GET /api/medical/settlements — List all settlements
router.get('/settlements', async (req, res) => {
  try {
    const { status, limit } = req.query;
    let query = 'SELECT * FROM dash_settlements';
    const params = [];
    if (status) {
      params.push(status);
      query += ' WHERE status = $1';
    }
    query += ' ORDER BY period_start DESC';
    if (limit) {
      params.push(parseInt(limit));
      query += ` LIMIT $${params.length}`;
    }
    const result = await pool.query(query, params);
    res.json({ settlements: result.rows, total: result.rows.length });
  } catch (err) {
    console.error('List settlements error:', err);
    res.status(500).json({ error: 'Erè sèvè' });
  }
});

// POST /api/medical/accident — Report an accident (triggers emergency flow)
router.post('/accident', async (req, res) => {
  try {
    const { ride_id, reporter_type, description, lat, lng, severity } = req.body;

    if (!ride_id) {
      return res.status(400).json({ error: 'ride_id obligatwa' });
    }

    const ride = await pool.query(
      `SELECT r.*, d.full_name as driver_name, d.phone as driver_phone,
              d.vehicle_type, d.license_plate
       FROM ride_requests r
       LEFT JOIN drivers d ON r.driver_id = d.id
       WHERE r.id = $1`,
      [ride_id]
    );

    if (ride.rows.length === 0) {
      return res.status(404).json({ error: 'Kous pa jwenn' });
    }

    const r = ride.rows[0];
    const reportId = uuidv4();
    const vehicleInfo = r.vehicle_type ? `${r.vehicle_type} - ${r.license_plate || 'N/A'}` : null;
    const gpsLat = lat || r.dropoff_lat;
    const gpsLng = lng || r.dropoff_lng;
    const nearest = await findNearestFacilities(gpsLat, gpsLng, 1);

    await pool.query(
      `INSERT INTO accident_reports
       (id, ride_id, reporter_type, reporter_name, reporter_phone, driver_name, driver_phone,
        vehicle_info, gps_lat, gps_lng, description, severity, nearest_facility, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'reported', NOW())`,
      [reportId, ride_id, reporter_type || 'passenger',
       r.customer_name, r.customer_phone, r.driver_name || null, r.driver_phone || null,
       vehicleInfo, gpsLat, gpsLng, description || 'Aksidan rapòte',
       severity || 'moderate', nearest.length > 0 ? nearest[0].name : null]
    );

    // Build the notification message (SMS/WhatsApp content)
    const now = new Date().toLocaleString('fr-HT', { timeZone: 'America/Port-au-Prince' });
    const notificationMsg = [
      'ALÈT AKSIDAN - MsouWout x DASH',
      `Pasaje: ${r.customer_name || 'Enkoni'} (${r.customer_phone})`,
      r.driver_name ? `Chofe: ${r.driver_name} (${r.driver_phone})` : 'Chofe: N/A',
      vehicleInfo ? `Veyikil: ${vehicleInfo}` : '',
      `Pozisyon GPS: ${gpsLat}, ${gpsLng}`,
      `Lè: ${now}`,
      /* ⛔ Never print "(nullkm)" to somebody at a crash site. The
         distance appears only when we actually hold the coordinates. */
      nearest.length > 0
        ? `Sant pi pre: ${nearest[0].name}` +
          (nearest[0].distance_km !== null ? ` (${nearest[0].distance_km}km)` : '') +
          (nearest[0].address ? ` - ${nearest[0].address}` : '')
        : ''
    ].filter(Boolean).join('\n');

    res.status(201).json({
      report_id: reportId,
      emergency: {
        dash_phone: DASH_CONFIG.emergency_phone,
        dash_whatsapp: DASH_CONFIG.emergency_whatsapp,
        nearest_facilities: nearest,
        message_ht: 'Nou regrèt aksidan ki rive a. Pou asistans medikal imedya, tanpri kontakte DASH oswa ale nan sant medikal DASH ki pi pre w la. Klike isit la pou wè direksyon ak enfòmasyon sant la.'
      },
      notification_content: notificationMsg,
      message: 'Rapò aksidan anrejistre. Kontakte DASH imedyatman.'
    });
  } catch (err) {
    console.error('Accident report error:', err);
    res.status(500).json({ error: 'Erè sèvè' });
  }
});

// GET /api/medical/accidents — List accident reports (admin)
router.get('/accidents', async (req, res) => {
  try {
    const { status, limit } = req.query;
    let query = `
      SELECT ar.*, r.tracking_code, r.customer_name, r.customer_phone, r.price
      FROM accident_reports ar
      LEFT JOIN ride_requests r ON ar.ride_id = r.id
    `;
    const params = [];
    if (status) {
      params.push(status);
      query += ' WHERE ar.status = $1';
    }
    query += ' ORDER BY ar.created_at DESC';
    if (limit) {
      params.push(parseInt(limit));
      query += ` LIMIT $${params.length}`;
    }
    const result = await pool.query(query, params);
    res.json({ accidents: result.rows, total: result.rows.length });
  } catch (err) {
    console.error('List accidents error:', err);
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

    const ride = await pool.query(
      'SELECT id, medical_protection, status FROM ride_requests WHERE id = $1',
      [ride_id]
    );
    if (ride.rows.length === 0) {
      return res.status(404).json({ error: 'Kous pa jwenn' });
    }

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

// GET /api/medical/export — Export all records as JSON for compliance/audit
router.get('/export', async (req, res) => {
  try {
    const { type, from, to } = req.query;
    const dateFilter = from && to ? ` AND created_at >= '${from}' AND created_at < '${to}'` : '';

    const result = {};

    if (!type || type === 'rides') {
      const rides = await pool.query(`SELECT * FROM ride_requests WHERE medical_protection = true ${dateFilter} ORDER BY created_at DESC`);
      result.rides = rides.rows;
    }
    if (!type || type === 'settlements') {
      try {
        const settlements = await pool.query(`SELECT * FROM dash_settlements ${dateFilter ? 'WHERE 1=1' + dateFilter : ''} ORDER BY period_start DESC`);
        result.settlements = settlements.rows;
      } catch (e) { result.settlements = []; }
    }
    if (!type || type === 'claims') {
      const claims = await pool.query(`SELECT * FROM medical_claims ${dateFilter ? 'WHERE 1=1' + dateFilter : ''} ORDER BY created_at DESC`);
      result.claims = claims.rows;
    }
    if (!type || type === 'accidents') {
      try {
        const accidents = await pool.query(`SELECT * FROM accident_reports ${dateFilter ? 'WHERE 1=1' + dateFilter : ''} ORDER BY created_at DESC`);
        result.accidents = accidents.rows;
      } catch (e) { result.accidents = []; }
    }

    result.exported_at = new Date().toISOString();
    result.filter = { type: type || 'all', from: from || null, to: to || null };

    res.json(result);
  } catch (err) {
    console.error('Export error:', err);
    res.status(500).json({ error: 'Erè sèvè' });
  }
});

module.exports = router;
