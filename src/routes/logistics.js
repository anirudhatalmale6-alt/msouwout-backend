const express = require('express');
const router = express.Router();
const pool = require('../db/pool');

// ==================== FLEETS ====================

router.post('/fleets', async (req, res) => {
  try {
    const { owner_name, company_name, phone, email, address, lat, lng } = req.body;
    if (!owner_name || !phone) return res.status(400).json({ error: 'owner_name ak phone obligatwa' });

    const existing = await pool.query('SELECT id FROM fleets WHERE phone = $1', [phone]);
    if (existing.rows.length > 0) return res.status(409).json({ error: 'Nimewo sa a deja enskri' });

    const result = await pool.query(
      `INSERT INTO fleets (owner_name, company_name, phone, email, address, lat, lng)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [owner_name, company_name || null, phone, email || null, address || null, lat || null, lng || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Create fleet error:', err);
    res.status(500).json({ error: 'Erè sèvè' });
  }
});

router.get('/fleets', async (req, res) => {
  try {
    const { status } = req.query;
    let q = 'SELECT * FROM fleets';
    const params = [];
    if (status) { params.push(status); q += ' WHERE status = $1'; }
    q += ' ORDER BY created_at DESC';
    const result = await pool.query(q, params);
    res.json({ fleets: result.rows, total: result.rows.length });
  } catch (err) {
    res.status(500).json({ error: 'Erè sèvè' });
  }
});

router.get('/fleets/:id', async (req, res) => {
  try {
    const fleet = await pool.query('SELECT * FROM fleets WHERE id = $1', [req.params.id]);
    if (fleet.rows.length === 0) return res.status(404).json({ error: 'Flòt pa jwenn' });

    const trucks = await pool.query(
      `SELECT t.*, d.full_name as driver_name, d.phone as driver_phone
       FROM trucks t LEFT JOIN drivers d ON t.driver_id = d.id
       WHERE t.fleet_id = $1 ORDER BY t.created_at DESC`, [req.params.id]
    );

    const activeLoads = await pool.query(
      `SELECT fl.* FROM freight_loads fl
       JOIN trucks t ON fl.assigned_truck_id = t.id
       WHERE t.fleet_id = $1 AND fl.status NOT IN ('delivered','cancelled')
       ORDER BY fl.created_at DESC`, [req.params.id]
    );

    res.json({ fleet: fleet.rows[0], trucks: trucks.rows, active_loads: activeLoads.rows });
  } catch (err) {
    res.status(500).json({ error: 'Erè sèvè' });
  }
});

router.patch('/fleets/:id/verify', async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE fleets SET status = 'approved', is_verified = true WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Flòt pa jwenn' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Erè sèvè' });
  }
});

// Fleet login by phone
router.post('/fleets/login', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'phone obligatwa' });
    const clean = phone.replace(/[^0-9+]/g, '');

    const fleet = await pool.query(
      'SELECT * FROM fleets WHERE phone = $1 OR phone = $2', [clean, phone.trim()]
    );
    if (fleet.rows.length === 0) return res.status(404).json({ error: 'Flòt pa jwenn' });

    const trucks = await pool.query(
      `SELECT t.*, d.full_name as driver_name FROM trucks t
       LEFT JOIN drivers d ON t.driver_id = d.id
       WHERE t.fleet_id = $1`, [fleet.rows[0].id]
    );

    const loads = await pool.query(
      `SELECT fl.* FROM freight_loads fl
       JOIN trucks t ON fl.assigned_truck_id = t.id
       WHERE t.fleet_id = $1 ORDER BY fl.created_at DESC LIMIT 20`, [fleet.rows[0].id]
    );

    res.json({ fleet: fleet.rows[0], trucks: trucks.rows, loads: loads.rows });
  } catch (err) {
    res.status(500).json({ error: 'Erè sèvè' });
  }
});

// ==================== TRUCKS ====================

router.post('/trucks', async (req, res) => {
  try {
    const { fleet_id, driver_id, truck_type, make, model, year, license_plate,
            payload_capacity_kg, payload_capacity_desc } = req.body;
    if (!truck_type) return res.status(400).json({ error: 'truck_type obligatwa' });

    const result = await pool.query(
      `INSERT INTO trucks (fleet_id, driver_id, truck_type, make, model, year, license_plate,
        payload_capacity_kg, payload_capacity_desc)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [fleet_id || null, driver_id || null, truck_type, make || null, model || null,
       year || null, license_plate || null, payload_capacity_kg || null, payload_capacity_desc || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Create truck error:', err);
    res.status(500).json({ error: 'Erè sèvè' });
  }
});

router.get('/trucks', async (req, res) => {
  try {
    const { type, available, fleet_id } = req.query;
    let q = `SELECT t.*, f.company_name as fleet_name, d.full_name as driver_name
             FROM trucks t LEFT JOIN fleets f ON t.fleet_id = f.id
             LEFT JOIN drivers d ON t.driver_id = d.id WHERE 1=1`;
    const params = [];
    if (type) { params.push(type); q += ` AND t.truck_type = $${params.length}`; }
    if (available === 'true') { q += ' AND t.is_available = true AND t.status = \'approved\''; }
    if (fleet_id) { params.push(fleet_id); q += ` AND t.fleet_id = $${params.length}`; }
    q += ' ORDER BY t.created_at DESC';
    const result = await pool.query(q, params);
    res.json({ trucks: result.rows, total: result.rows.length });
  } catch (err) {
    res.status(500).json({ error: 'Erè sèvè' });
  }
});

router.patch('/trucks/:id/verify', async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE trucks SET status = 'approved', is_verified = true WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Kamyon pa jwenn' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Erè sèvè' });
  }
});

router.post('/trucks/:id/location', async (req, res) => {
  try {
    const { lat, lng } = req.body;
    if (!lat || !lng) return res.status(400).json({ error: 'lat ak lng obligatwa' });
    const result = await pool.query(
      `UPDATE trucks SET current_lat = $2, current_lng = $3, last_location_update = NOW()
       WHERE id = $1 RETURNING id, truck_type, current_lat, current_lng`,
      [req.params.id, lat, lng]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Kamyon pa jwenn' });
    res.json({ updated: true, truck: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Erè sèvè' });
  }
});

// ==================== FREIGHT LOADS (LOAD BOARD) ====================

function generateTrackingCode() {
  return 'FL-' + Date.now().toString(36).toUpperCase().slice(-6);
}
function generatePin() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

router.post('/loads', async (req, res) => {
  try {
    const { posted_by_phone, posted_by_name, business_id, cargo_type, cargo_description,
            weight_kg, quantity, truck_type_needed, pickup_address, pickup_lat, pickup_lng,
            pickup_contact, pickup_phone, dropoff_address, dropoff_lat, dropoff_lng,
            dropoff_contact, dropoff_phone, price, urgency, pickup_date, notes } = req.body;

    if (!posted_by_phone || !cargo_type || !pickup_lat || !pickup_lng || !dropoff_lat || !dropoff_lng) {
      return res.status(400).json({ error: 'Champs obligatwa manke' });
    }

    const trackingCode = generateTrackingCode();
    const pickupPin = generatePin();
    const deliveryPin = generatePin();
    const distance = haversine(pickup_lat, pickup_lng, dropoff_lat, dropoff_lng);

    const result = await pool.query(
      `INSERT INTO freight_loads (tracking_code, posted_by_phone, posted_by_name, business_id,
        cargo_type, cargo_description, weight_kg, quantity, truck_type_needed,
        pickup_address, pickup_lat, pickup_lng, pickup_contact, pickup_phone,
        dropoff_address, dropoff_lat, dropoff_lng, dropoff_contact, dropoff_phone,
        distance_km, price, urgency, pickup_date, notes, pickup_pin, delivery_pin)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)
       RETURNING *`,
      [trackingCode, posted_by_phone, posted_by_name || null, business_id || null,
       cargo_type, cargo_description || null, weight_kg || null, quantity || null,
       truck_type_needed || null, pickup_address || null, pickup_lat, pickup_lng,
       pickup_contact || null, pickup_phone || null, dropoff_address || null,
       dropoff_lat, dropoff_lng, dropoff_contact || null, dropoff_phone || null,
       Math.round(distance * 10) / 10, price || null, urgency || 'normal',
       pickup_date || null, notes || null, pickupPin, deliveryPin]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Create load error:', err);
    res.status(500).json({ error: 'Erè sèvè' });
  }
});

router.get('/loads', async (req, res) => {
  try {
    const { status, truck_type, urgency, limit } = req.query;
    let q = `SELECT fl.*, t.truck_type as assigned_truck_type, t.license_plate as truck_plate,
                    d.full_name as driver_name, d.phone as driver_phone
             FROM freight_loads fl
             LEFT JOIN trucks t ON fl.assigned_truck_id = t.id
             LEFT JOIN drivers d ON fl.assigned_driver_id = d.id WHERE 1=1`;
    const params = [];
    if (status) { params.push(status); q += ` AND fl.status = $${params.length}`; }
    if (truck_type) { params.push(truck_type); q += ` AND fl.truck_type_needed = $${params.length}`; }
    if (urgency) { params.push(urgency); q += ` AND fl.urgency = $${params.length}`; }
    q += ' ORDER BY fl.created_at DESC';
    if (limit) { params.push(parseInt(limit)); q += ` LIMIT $${params.length}`; }
    const result = await pool.query(q, params);
    res.json({ loads: result.rows, total: result.rows.length });
  } catch (err) {
    res.status(500).json({ error: 'Erè sèvè' });
  }
});

router.get('/loads/:id', async (req, res) => {
  try {
    const param = req.params.id;
    const isUUID = /^[0-9a-f]{8}-/.test(param);
    const result = await pool.query(
      `SELECT fl.*, t.truck_type as assigned_truck_type, t.license_plate as truck_plate,
              t.make as truck_make, t.model as truck_model, t.photo_url as truck_photo,
              d.full_name as driver_name, d.phone as driver_phone,
              f.company_name as fleet_name
       FROM freight_loads fl
       LEFT JOIN trucks t ON fl.assigned_truck_id = t.id
       LEFT JOIN drivers d ON fl.assigned_driver_id = d.id
       LEFT JOIN fleets f ON t.fleet_id = f.id
       WHERE ${isUUID ? 'fl.id = $1' : 'fl.tracking_code = $1'}`, [param]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Chajman pa jwenn' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Erè sèvè' });
  }
});

// Track a load (public, no PINs exposed)
router.get('/loads/:id/track', async (req, res) => {
  try {
    const param = req.params.id;
    const isUUID = /^[0-9a-f]{8}-/.test(param);
    const result = await pool.query(
      `SELECT fl.id, fl.tracking_code, fl.cargo_type, fl.quantity, fl.status,
              fl.pickup_address, fl.pickup_lat, fl.pickup_lng,
              fl.dropoff_address, fl.dropoff_lat, fl.dropoff_lng,
              fl.distance_km, fl.price, fl.urgency,
              fl.assigned_at, fl.picked_up_at, fl.in_transit_at, fl.delivered_at,
              t.truck_type as assigned_truck_type, t.license_plate as truck_plate,
              t.current_lat as truck_lat, t.current_lng as truck_lng, t.last_location_update,
              d.full_name as driver_name, d.phone as driver_phone,
              f.company_name as fleet_name
       FROM freight_loads fl
       LEFT JOIN trucks t ON fl.assigned_truck_id = t.id
       LEFT JOIN drivers d ON fl.assigned_driver_id = d.id
       LEFT JOIN fleets f ON t.fleet_id = f.id
       WHERE ${isUUID ? 'fl.id = $1' : 'fl.tracking_code = $1'}`, [param]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Chajman pa jwenn' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Erè sèvè' });
  }
});

// ==================== DISPATCH ====================

router.patch('/loads/:id/assign', async (req, res) => {
  try {
    const { truck_id, driver_id } = req.body;
    if (!truck_id) return res.status(400).json({ error: 'truck_id obligatwa' });

    const load = await pool.query('SELECT * FROM freight_loads WHERE id = $1', [req.params.id]);
    if (load.rows.length === 0) return res.status(404).json({ error: 'Chajman pa jwenn' });
    if (load.rows[0].status !== 'posted') return res.status(400).json({ error: 'Chajman sa a deja pran' });

    const truck = await pool.query('SELECT * FROM trucks WHERE id = $1', [truck_id]);
    if (truck.rows.length === 0) return res.status(404).json({ error: 'Kamyon pa jwenn' });

    const actualDriverId = driver_id || truck.rows[0].driver_id;

    await pool.query(
      `UPDATE freight_loads SET assigned_truck_id = $1, assigned_driver_id = $2,
       status = 'assigned', assigned_at = NOW(), updated_at = NOW() WHERE id = $3`,
      [truck_id, actualDriverId, req.params.id]
    );

    await pool.query('UPDATE trucks SET is_available = false WHERE id = $1', [truck_id]);

    res.json({ status: 'assigned', message: 'Kamyon asiyen!' });
  } catch (err) {
    console.error('Assign load error:', err);
    res.status(500).json({ error: 'Erè sèvè' });
  }
});

router.patch('/loads/:id/pickup', async (req, res) => {
  try {
    const { pin } = req.body;
    const load = await pool.query('SELECT * FROM freight_loads WHERE id = $1', [req.params.id]);
    if (load.rows.length === 0) return res.status(404).json({ error: 'Chajman pa jwenn' });
    if (load.rows[0].status !== 'assigned') return res.status(400).json({ error: 'Chajman dwe asiyen avan' });

    if (load.rows[0].pickup_pin && pin !== load.rows[0].pickup_pin) {
      return res.status(403).json({ error: 'PIN pa kòrèk', pin_required: true });
    }

    await pool.query(
      `UPDATE freight_loads SET status = 'picked_up', picked_up_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [req.params.id]
    );
    res.json({ status: 'picked_up', message: 'Machandiz anbake!' });
  } catch (err) {
    res.status(500).json({ error: 'Erè sèvè' });
  }
});

router.patch('/loads/:id/transit', async (req, res) => {
  try {
    const load = await pool.query('SELECT * FROM freight_loads WHERE id = $1', [req.params.id]);
    if (load.rows.length === 0) return res.status(404).json({ error: 'Chajman pa jwenn' });
    if (load.rows[0].status !== 'picked_up') return res.status(400).json({ error: 'Dwe anbake avan' });

    await pool.query(
      `UPDATE freight_loads SET status = 'in_transit', in_transit_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [req.params.id]
    );
    res.json({ status: 'in_transit', message: 'Nan wout!' });
  } catch (err) {
    res.status(500).json({ error: 'Erè sèvè' });
  }
});

router.patch('/loads/:id/deliver', async (req, res) => {
  try {
    const { pin, confirmed_by_name, confirmed_by_phone, lat, lng, notes } = req.body;
    const load = await pool.query('SELECT * FROM freight_loads WHERE id = $1', [req.params.id]);
    if (load.rows.length === 0) return res.status(404).json({ error: 'Chajman pa jwenn' });
    if (!['in_transit', 'picked_up'].includes(load.rows[0].status)) {
      return res.status(400).json({ error: 'Chajman dwe nan wout' });
    }

    if (load.rows[0].delivery_pin && pin !== load.rows[0].delivery_pin) {
      return res.status(403).json({ error: 'PIN livrezon pa kòrèk', pin_required: true });
    }

    await pool.query(
      `UPDATE freight_loads SET status = 'delivered', delivered_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [req.params.id]
    );

    if (load.rows[0].assigned_truck_id) {
      await pool.query('UPDATE trucks SET is_available = true WHERE id = $1', [load.rows[0].assigned_truck_id]);
    }

    await pool.query(
      `INSERT INTO delivery_receipts (load_id, receipt_type, confirmed_by_name, confirmed_by_phone, lat, lng, notes)
       VALUES ($1, 'delivery', $2, $3, $4, $5, $6)`,
      [req.params.id, confirmed_by_name || null, confirmed_by_phone || null, lat || null, lng || null, notes || null]
    );

    res.json({ status: 'delivered', message: 'Livrezon konfime!' });
  } catch (err) {
    console.error('Deliver load error:', err);
    res.status(500).json({ error: 'Erè sèvè' });
  }
});

router.patch('/loads/:id/cancel', async (req, res) => {
  try {
    const { reason } = req.body;
    const load = await pool.query('SELECT * FROM freight_loads WHERE id = $1', [req.params.id]);
    if (load.rows.length === 0) return res.status(404).json({ error: 'Chajman pa jwenn' });
    if (['delivered', 'cancelled'].includes(load.rows[0].status)) {
      return res.status(400).json({ error: 'Pa ka anile' });
    }

    if (load.rows[0].assigned_truck_id) {
      await pool.query('UPDATE trucks SET is_available = true WHERE id = $1', [load.rows[0].assigned_truck_id]);
    }

    await pool.query(
      `UPDATE freight_loads SET status = 'cancelled', cancelled_at = NOW(), cancel_reason = $2, updated_at = NOW() WHERE id = $1`,
      [req.params.id, reason || null]
    );
    res.json({ status: 'cancelled', message: 'Chajman anile' });
  } catch (err) {
    res.status(500).json({ error: 'Erè sèvè' });
  }
});

// ==================== STATS ====================

router.get('/stats', async (req, res) => {
  try {
    const loads = await pool.query(`SELECT status, COUNT(*) as count FROM freight_loads GROUP BY status`);
    const trucks = await pool.query(`SELECT truck_type, COUNT(*) as count FROM trucks GROUP BY truck_type`);
    const fleets = await pool.query(`SELECT COUNT(*) as total FROM fleets`);
    const totalLoads = await pool.query(`SELECT COUNT(*) as total FROM freight_loads`);
    const revenue = await pool.query(`SELECT COALESCE(SUM(price),0) as total FROM freight_loads WHERE status = 'delivered'`);

    res.json({
      loads_by_status: loads.rows,
      trucks_by_type: trucks.rows,
      total_fleets: parseInt(fleets.rows[0].total),
      total_loads: parseInt(totalLoads.rows[0].total),
      total_revenue: parseInt(revenue.rows[0].total)
    });
  } catch (err) {
    res.status(500).json({ error: 'Erè sèvè' });
  }
});

module.exports = router;
