const express = require('express');
const router = express.Router();
const pool = require('../db/pool');

// POST /api/safety/contacts — Add a trusted contact
router.post('/contacts', async (req, res) => {
  try {
    const { phone, contact_name, contact_phone, relationship } = req.body;
    if (!phone || !contact_phone) {
      return res.status(400).json({ error: 'phone ak contact_phone obligatwa' });
    }

    const existing = await pool.query(
      'SELECT id FROM trusted_contacts WHERE owner_phone = $1 AND contact_phone = $2',
      [phone, contact_phone]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Kontak sa deja ajoute' });
    }

    const count = await pool.query(
      'SELECT COUNT(*) FROM trusted_contacts WHERE owner_phone = $1', [phone]
    );
    if (parseInt(count.rows[0].count) >= 5) {
      return res.status(400).json({ error: 'Maksimòm 5 kontak konfyans' });
    }

    const result = await pool.query(
      `INSERT INTO trusted_contacts (owner_phone, contact_name, contact_phone, relationship)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [phone, contact_name || '', contact_phone, relationship || 'family']
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Add contact error:', err);
    res.status(500).json({ error: 'Erè sèvè' });
  }
});

// GET /api/safety/contacts/:phone — Get trusted contacts for a phone number
router.get('/contacts/:phone', async (req, res) => {
  try {
    const clean = req.params.phone.replace(/[^0-9+]/g, '');
    const result = await pool.query(
      'SELECT * FROM trusted_contacts WHERE owner_phone = $1 OR owner_phone = $2 ORDER BY created_at',
      [clean, req.params.phone.trim()]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Get contacts error:', err);
    res.status(500).json({ error: 'Erè sèvè' });
  }
});

// DELETE /api/safety/contacts/:id — Remove a trusted contact
router.delete('/contacts/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM trusted_contacts WHERE id = $1', [req.params.id]);
    res.json({ deleted: true });
  } catch (err) {
    res.status(500).json({ error: 'Erè sèvè' });
  }
});

// POST /api/safety/sos — 3-level SOS system
router.post('/sos', async (req, res) => {
  try {
    const { phone, name, lat, lng, ride_id, level, silent, trigger_reason } = req.body;
    if (!phone) return res.status(400).json({ error: 'phone obligatwa' });

    const alertLevel = level || 'warning';

    const result = await pool.query(
      `INSERT INTO sos_alerts (phone, name, lat, lng, ride_id, platform, status, alert_level,
       is_silent, trigger_reason, created_at)
       VALUES ($1, $2, $3, $4, $5, 'msouwout', 'active', $6, $7, $8, NOW())
       RETURNING *`,
      [phone, name || '', lat || null, lng || null, ride_id || null,
       alertLevel, silent || false, trigger_reason || 'manual']
    );

    const alert = result.rows[0];

    if (alertLevel === 'silent' || alertLevel === 'escalated') {
      if (ride_id) {
        await pool.query(
          `UPDATE ride_requests SET status = $1, updated_at = NOW() WHERE id = $2`,
          [alertLevel === 'escalated' ? 'emergency' : 'monitoring', ride_id]
        );
      }

      const contacts = await pool.query(
        'SELECT * FROM trusted_contacts WHERE owner_phone = $1 OR owner_phone = $2',
        [phone.replace(/[^0-9+]/g, ''), phone.trim()]
      );

      if (ride_id) {
        await pool.query(
          `INSERT INTO safety_events (sos_id, ride_id, event_type, data)
           VALUES ($1, $2, $3, $4)`,
          [alert.id, ride_id, 'sos_' + alertLevel,
           JSON.stringify({ lat, lng, contacts_notified: contacts.rows.length })]
        );
      }

      res.status(201).json({
        alert_id: alert.id,
        level: alertLevel,
        contacts_to_notify: contacts.rows.map(c => ({
          name: c.contact_name,
          phone: c.contact_phone
        })),
        message: alertLevel === 'escalated'
          ? 'Alèt ijans eskale! Ekip sekirite ap reponn.'
          : 'Alèt silansye aktive. GPS ap pataje.'
      });
    } else {
      res.status(201).json({
        alert_id: alert.id,
        level: 'warning',
        message: 'SOS anrejistre. Kenbe bouton an pou konfime.'
      });
    }
  } catch (err) {
    console.error('SOS error:', err);
    res.status(500).json({ error: 'Erè sèvè' });
  }
});

// POST /api/safety/safe — "I'm Safe" button
router.post('/safe', async (req, res) => {
  try {
    const { phone, ride_id, alert_id } = req.body;
    if (!phone) return res.status(400).json({ error: 'phone obligatwa' });

    let query = 'UPDATE sos_alerts SET status = $1, resolved_at = NOW() WHERE phone = $2';
    const params = ['resolved_safe', phone];

    if (alert_id) {
      query = 'UPDATE sos_alerts SET status = $1, resolved_at = NOW() WHERE id = $2';
      params[1] = alert_id;
    }

    await pool.query(query + ' AND status IN (\'active\', \'monitoring\')', params);

    if (ride_id) {
      const ride = await pool.query('SELECT status FROM ride_requests WHERE id = $1', [ride_id]);
      if (ride.rows.length > 0 && ['emergency', 'monitoring'].includes(ride.rows[0].status)) {
        await pool.query(
          `UPDATE ride_requests SET status = 'in_progress', updated_at = NOW() WHERE id = $1`,
          [ride_id]
        );
      }

      await pool.query(
        `INSERT INTO safety_events (ride_id, event_type, data) VALUES ($1, 'safe_confirmed', $2)`,
        [ride_id, JSON.stringify({ phone, resolved_at: new Date().toISOString() })]
      );
    }

    res.json({ status: 'safe', message: 'Alèt fèmen. Mèsi!' });
  } catch (err) {
    console.error('Safe error:', err);
    res.status(500).json({ error: 'Erè sèvè' });
  }
});

// POST /api/safety/checkpoint — Log GPS checkpoint for route monitoring
router.post('/checkpoint', async (req, res) => {
  try {
    const { ride_id, lat, lng } = req.body;
    if (!ride_id || !lat || !lng) {
      return res.status(400).json({ error: 'ride_id, lat, lng obligatwa' });
    }

    await pool.query(
      `INSERT INTO route_checkpoints (ride_id, lat, lng) VALUES ($1, $2, $3)`,
      [ride_id, lat, lng]
    );

    const ride = await pool.query(
      'SELECT pickup_lat, pickup_lng, dropoff_lat, dropoff_lng, status FROM ride_requests WHERE id = $1',
      [ride_id]
    );
    if (ride.rows.length === 0) return res.json({ deviation: false });

    const r = ride.rows[0];
    if (r.status !== 'in_progress') return res.json({ deviation: false });

    const checkpoints = await pool.query(
      'SELECT lat, lng FROM route_checkpoints WHERE ride_id = $1 ORDER BY created_at DESC LIMIT 5',
      [ride_id]
    );

    let deviation = false;
    let reason = null;

    if (checkpoints.rows.length >= 3) {
      const corridor = getRouteCorridor(r.pickup_lat, r.pickup_lng, r.dropoff_lat, r.dropoff_lng);
      const latest = checkpoints.rows[0];
      const distFromRoute = pointToLineDistance(
        latest.lat, latest.lng,
        r.pickup_lat, r.pickup_lng,
        r.dropoff_lat, r.dropoff_lng
      );

      if (distFromRoute > 2.0) {
        deviation = true;
        reason = 'route_deviation';
      }

      const prev = checkpoints.rows[1];
      const timeDiff = 30;
      const dist = haversine(prev.lat, prev.lng, latest.lat, latest.lng);
      if (dist < 0.02 && checkpoints.rows.length >= 3) {
        const older = checkpoints.rows[2];
        const dist2 = haversine(older.lat, older.lng, latest.lat, latest.lng);
        if (dist2 < 0.03) {
          deviation = true;
          reason = 'suspicious_stop';
        }
      }
    }

    const zones = await pool.query(
      "SELECT name FROM zones WHERE zone_type = 'red' AND is_active = true"
    );
    for (const zone of zones.rows) {
      // Red zone check would use geometry - simplified check
    }

    if (deviation) {
      await pool.query(
        `INSERT INTO safety_events (ride_id, event_type, data) VALUES ($1, $2, $3)`,
        [ride_id, reason, JSON.stringify({ lat, lng })]
      );
    }

    res.json({ deviation, reason, lat, lng });
  } catch (err) {
    console.error('Checkpoint error:', err);
    res.status(500).json({ error: 'Erè sèvè' });
  }
});

// GET /api/safety/ride-status/:ride_id — Get safety status for a ride
router.get('/ride-status/:ride_id', async (req, res) => {
  try {
    const { ride_id } = req.params;

    const alerts = await pool.query(
      `SELECT * FROM sos_alerts WHERE ride_id = $1 AND status IN ('active', 'monitoring')
       ORDER BY created_at DESC LIMIT 1`,
      [ride_id]
    );

    const events = await pool.query(
      `SELECT * FROM safety_events WHERE ride_id = $1 ORDER BY created_at DESC LIMIT 10`,
      [ride_id]
    );

    const checkpoints = await pool.query(
      `SELECT lat, lng, created_at FROM route_checkpoints WHERE ride_id = $1 ORDER BY created_at DESC LIMIT 20`,
      [ride_id]
    );

    res.json({
      active_alert: alerts.rows[0] || null,
      recent_events: events.rows,
      route_trail: checkpoints.rows,
      has_active_sos: alerts.rows.length > 0
    });
  } catch (err) {
    console.error('Ride status error:', err);
    res.status(500).json({ error: 'Erè sèvè' });
  }
});

// GET /api/safety/alerts — Admin: list active alerts
router.get('/alerts', async (req, res) => {
  try {
    const { status } = req.query;
    let query = `SELECT s.*, r.tracking_code, r.customer_name, r.customer_phone,
                        r.pickup_lat, r.pickup_lng, r.dropoff_lat, r.dropoff_lng,
                        d.full_name as driver_name, d.phone as driver_phone
                 FROM sos_alerts s
                 LEFT JOIN ride_requests r ON s.ride_id = r.id
                 LEFT JOIN drivers d ON r.driver_id = d.id`;
    const params = [];
    if (status) {
      params.push(status);
      query += ' WHERE s.status = $1';
    }
    query += ' ORDER BY s.created_at DESC LIMIT 50';

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Erè sèvè' });
  }
});

// POST /api/safety/alerts/:id/respond — Admin respond to alert
router.post('/alerts/:id/respond', async (req, res) => {
  try {
    const { note, action } = req.body;
    const status = action === 'resolve' ? 'resolved' : 'responded';
    const result = await pool.query(
      `UPDATE sos_alerts SET status = $1, admin_note = $2, responded_at = NOW()
       WHERE id = $3 RETURNING *`,
      [status, note || '', req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Alèt pa jwenn' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Erè sèvè' });
  }
});

// GET /api/safety/nearby-drivers — Find nearby verified drivers for escalation
router.get('/nearby-drivers', async (req, res) => {
  try {
    const { lat, lng, radius } = req.query;
    if (!lat || !lng) return res.status(400).json({ error: 'lat ak lng obligatwa' });

    const r = parseFloat(radius) || 3;
    const result = await pool.query(
      `SELECT id, full_name, phone, vehicle_type, current_lat, current_lng,
              last_location_update
       FROM drivers
       WHERE status = 'approved' AND is_active = true
         AND current_lat IS NOT NULL AND current_lng IS NOT NULL
         AND last_location_update > NOW() - INTERVAL '30 minutes'
       ORDER BY last_location_update DESC`
    );

    const nearby = result.rows.filter(d => {
      const dist = haversine(parseFloat(lat), parseFloat(lng), d.current_lat, d.current_lng);
      d.distance_km = Math.round(dist * 100) / 100;
      return dist <= r;
    }).sort((a, b) => a.distance_km - b.distance_km).slice(0, 10);

    res.json(nearby);
  } catch (err) {
    res.status(500).json({ error: 'Erè sèvè' });
  }
});

function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function pointToLineDistance(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return haversine(px, py, x1, y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const closestLat = x1 + t * dx;
  const closestLng = y1 + t * dy;
  return haversine(px, py, closestLat, closestLng);
}

function getRouteCorridor(lat1, lng1, lat2, lng2) {
  return { lat1, lng1, lat2, lng2 };
}

module.exports = router;
