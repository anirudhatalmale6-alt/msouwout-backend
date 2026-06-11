const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { v4: uuidv4 } = require('uuid');

// DASH emergency contact & facility data
const DASH_CONFIG = {
  emergency_phone: '+50933333274',
  emergency_whatsapp: '+50933333274',
  name: 'DASH Medical Assistance',
  website: 'www.dashhaiti.org',
  facilities: [
    // Hospitals
    { name: 'Hôpital Jude Anne', lat: 18.5420, lng: -72.3250, address: 'Delmas 18', phone: '+50933333274', type: 'hospital' },
    { name: 'Hôpital St-Landry', lat: 18.5110, lng: -72.2870, address: 'Pétion-Ville, Route de Frères', phone: '+50933333274', type: 'hospital' },
    { name: 'Hôpital Saint Esprit', lat: 18.5450, lng: -72.3180, address: 'Delmas 31', phone: '+50933333274', type: 'hospital' },
    { name: 'Hôpital Sainte Claire', lat: 18.5455, lng: -72.3175, address: 'Delmas 31', phone: '+50933333274', type: 'hospital' },
    { name: 'Hôpital Sainte Gene', lat: 18.5130, lng: -72.2850, address: 'Route de Frères', phone: '+50933333274', type: 'hospital' },
    { name: 'Hôpital Mont-Carmel', lat: 18.5095, lng: -72.2920, address: 'Pétion-Ville, Bois Verna', phone: '+50933333274', type: 'hospital' },
    { name: 'Hôpital Christ du Nord', lat: 19.7590, lng: -72.2010, address: 'Cap-Haïtien', phone: '+50933333274', type: 'hospital' },
    // DASH Clinics & Centers
    { name: 'La Croix Dieu', lat: 18.5520, lng: -72.3080, address: 'Delmas 48', phone: '+50933333274', type: 'clinic' },
    { name: 'DASH Centre-Ville CMC', lat: 18.5430, lng: -72.3400, address: '#91 Rue Oswald Durand', phone: '+50933333274', type: 'clinic' },
    { name: 'DASH Tabarre', lat: 18.5580, lng: -72.2780, address: 'Route de Santo, Tabarre', phone: '+50933333274', type: 'clinic' },
    { name: 'DASH Carries', lat: 19.4500, lng: -72.6900, address: 'Baie de Henne / Gonaïves', phone: '+50933333274', type: 'clinic' },
    { name: 'DASH Montrouis', lat: 18.9500, lng: -72.7100, address: 'Entrée de Montrouis', phone: '+50933333274', type: 'clinic' }
  ]
};

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function findNearestFacilities(lat, lng, limit) {
  if (!lat || !lng) return DASH_CONFIG.facilities.slice(0, limit || 3);
  return DASH_CONFIG.facilities
    .map(f => ({ ...f, distance_km: parseFloat(haversineKm(lat, lng, f.lat, f.lng).toFixed(1)) }))
    .sort((a, b) => a.distance_km - b.distance_km)
    .slice(0, limit || 3);
}

// GET /api/medical/dash-info — DASH contact & facilities info (public)
router.get('/dash-info', (req, res) => {
  const { lat, lng } = req.query;
  const facilities = findNearestFacilities(parseFloat(lat), parseFloat(lng), 3);
  res.json({
    emergency_phone: DASH_CONFIG.emergency_phone,
    emergency_whatsapp: DASH_CONFIG.emergency_whatsapp,
    name: DASH_CONFIG.name,
    facilities,
    message_ht: 'Nou regrèt aksidan ki rive a. Pou asistans medikal imedya, tanpri kontakte DASH oswa ale nan sant medikal DASH ki pi pre w la. Klike isit la pou wè direksyon ak enfòmasyon sant la.'
  });
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
    const nearest = findNearestFacilities(gpsLat, gpsLng, 1);

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
      nearest.length > 0 ? `Sant pi pre: ${nearest[0].name} (${nearest[0].distance_km}km)` : ''
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
