const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const pool = require('../db/pool');

// Contact info filtering
const PHONE_RE = /(?:\+?509[\s.-]?\d{4}[\s.-]?\d{4}|\b\d{4}[\s.-]?\d{4}\b|\+\d{1,3}[\s.-]?\d{3,4}[\s.-]?\d{3,4}[\s.-]?\d{0,4})/g;
const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const WA_RE = /(?:wa\.me\/|whatsapp\.com\/|whatsapp\b)/gi;
const URL_RE = /(?:https?:\/\/|www\.)[^\s]+/gi;

function filterContact(text) {
  if (!text) return text;
  return text.replace(PHONE_RE, '[kontak kache]').replace(EMAIL_RE, '[kontak kache]').replace(WA_RE, '[kontak kache]').replace(URL_RE, '[lyen kache]');
}

function hasContactInfo(text) {
  if (!text) return false;
  const t = text;
  const r = PHONE_RE.test(t) || EMAIL_RE.test(t) || WA_RE.test(t) || URL_RE.test(t);
  PHONE_RE.lastIndex = 0; EMAIL_RE.lastIndex = 0; WA_RE.lastIndex = 0; URL_RE.lastIndex = 0;
  return r;
}

const TRUSTED_STATUSES = ['accepted', 'in_progress', 'completed'];

async function getRideStatus(rideId) {
  if (!rideId) return null;
  const r = await pool.query('SELECT status FROM ride_requests WHERE id = $1', [rideId]);
  return r.rows.length > 0 ? r.rows[0].status : null;
}

// POST /api/messages/conversations
router.post('/conversations', async (req, res) => {
  try {
    const { ride_id, driver_id, rider_phone, rider_name, message } = req.body;
    if (!rider_phone) return res.status(400).json({ error: 'rider_phone obligatwa' });

    let convo;
    if (ride_id) {
      const existing = await pool.query('SELECT * FROM conversations WHERE ride_id = $1', [ride_id]);
      if (existing.rows.length > 0) convo = existing.rows[0];
    }

    if (!convo) {
      const id = uuidv4();
      const result = await pool.query(
        `INSERT INTO conversations (id, ride_id, driver_id, rider_phone, rider_name, last_message_at, created_at)
         VALUES ($1, $2, $3, $4, $5, NOW(), NOW()) RETURNING *`,
        [id, ride_id || null, driver_id || null, rider_phone, rider_name || 'Kliyan']
      );
      convo = result.rows[0];
    }

    if (message) {
      const rideStatus = await getRideStatus(convo.ride_id);
      const trusted = rideStatus && TRUSTED_STATUSES.includes(rideStatus);
      const finalMsg = trusted ? message : filterContact(message);

      const msgId = uuidv4();
      await pool.query(
        `INSERT INTO messages (id, conversation_id, sender_type, sender_id, content, type, created_at)
         VALUES ($1, $2, 'rider', $3, $4, 'text', NOW())`,
        [msgId, convo.id, rider_phone, finalMsg]
      );
      await pool.query(
        'UPDATE conversations SET last_message = $1, last_message_at = NOW() WHERE id = $2',
        [finalMsg.substring(0, 100), convo.id]
      );
    }

    res.status(201).json(convo);
  } catch (err) {
    console.error('Start conversation error:', err);
    res.status(500).json({ error: 'Erè sèvè' });
  }
});

// GET /api/messages/conversations/driver/:driverId
router.get('/conversations/driver/:driverId', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT c.*, r.status as ride_status, r.tracking_code, r.ride_type
      FROM conversations c
      LEFT JOIN ride_requests r ON c.ride_id = r.id
      WHERE c.driver_id = $1 AND c.is_archived = false
      ORDER BY c.last_message_at DESC NULLS LAST
    `, [req.params.driverId]);

    const convos = [];
    for (const c of result.rows) {
      const unread = await pool.query(
        `SELECT COUNT(*) FROM messages WHERE conversation_id = $1 AND sender_type = 'rider' AND read_at IS NULL`,
        [c.id]
      );
      const trusted = c.ride_status && TRUSTED_STATUSES.includes(c.ride_status);
      convos.push({
        ...c,
        unread_count: parseInt(unread.rows[0].count),
        contact_unlocked: trusted,
        rider_phone: trusted ? c.rider_phone : null
      });
    }

    res.json({ conversations: convos, total: convos.length });
  } catch (err) {
    console.error('List driver convos error:', err);
    res.status(500).json({ error: 'Erè sèvè' });
  }
});

// GET /api/messages/conversations/rider/:phone
router.get('/conversations/rider/:phone', async (req, res) => {
  try {
    const phone = req.params.phone.replace(/[^0-9+]/g, '');
    const result = await pool.query(`
      SELECT c.*, d.full_name as driver_name, d.phone as driver_phone,
             d.vehicle_type, d.license_plate,
             r.status as ride_status, r.tracking_code, r.ride_type
      FROM conversations c
      LEFT JOIN drivers d ON c.driver_id = d.id
      LEFT JOIN ride_requests r ON c.ride_id = r.id
      WHERE (c.rider_phone = $1 OR c.rider_phone = $2) AND c.is_archived = false
      ORDER BY c.last_message_at DESC NULLS LAST
    `, [phone, req.params.phone.trim()]);

    const convos = [];
    for (const c of result.rows) {
      const unread = await pool.query(
        `SELECT COUNT(*) FROM messages WHERE conversation_id = $1 AND sender_type = 'driver' AND read_at IS NULL`,
        [c.id]
      );
      const trusted = c.ride_status && TRUSTED_STATUSES.includes(c.ride_status);
      convos.push({
        ...c,
        unread_count: parseInt(unread.rows[0].count),
        contact_unlocked: trusted,
        driver_phone: trusted ? c.driver_phone : null
      });
    }

    res.json({ conversations: convos, total: convos.length });
  } catch (err) {
    console.error('List rider convos error:', err);
    res.status(500).json({ error: 'Erè sèvè' });
  }
});

// GET /api/messages/conversations/:id/messages
router.get('/conversations/:id/messages', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const offset = (page - 1) * limit;

    const convo = await pool.query('SELECT * FROM conversations WHERE id = $1', [req.params.id]);
    if (convo.rows.length === 0) return res.status(404).json({ error: 'Konvèsasyon pa jwenn' });

    const rideStatus = await getRideStatus(convo.rows[0].ride_id);
    const trusted = rideStatus && TRUSTED_STATUSES.includes(rideStatus);

    const count = await pool.query('SELECT COUNT(*) FROM messages WHERE conversation_id = $1', [req.params.id]);
    const result = await pool.query(
      `SELECT * FROM messages WHERE conversation_id = $1
       ORDER BY created_at ASC LIMIT $2 OFFSET $3`,
      [req.params.id, limit, offset]
    );

    const messages = result.rows.map(m => {
      if (!trusted && m.type === 'text') {
        m.content = filterContact(m.content);
      }
      return m;
    });

    res.json({
      messages,
      total: parseInt(count.rows[0].count),
      page,
      pages: Math.ceil(parseInt(count.rows[0].count) / limit),
      contact_unlocked: trusted
    });
  } catch (err) {
    console.error('Get messages error:', err);
    res.status(500).json({ error: 'Erè sèvè' });
  }
});

// POST /api/messages/conversations/:id/messages
router.post('/conversations/:id/messages', async (req, res) => {
  try {
    const { sender_type, sender_id, content, type, file_url } = req.body;
    if (!content && !file_url) return res.status(400).json({ error: 'Mesaj vid' });
    if (!sender_type) return res.status(400).json({ error: 'sender_type obligatwa (rider/driver)' });

    const convo = await pool.query('SELECT * FROM conversations WHERE id = $1', [req.params.id]);
    if (convo.rows.length === 0) return res.status(404).json({ error: 'Konvèsasyon pa jwenn' });

    const rideStatus = await getRideStatus(convo.rows[0].ride_id);
    const trusted = rideStatus && TRUSTED_STATUSES.includes(rideStatus);

    let finalContent = content || '';
    let contactWarning = false;
    const msgType = type || 'text';

    if (!trusted && msgType === 'text') {
      if (hasContactInfo(finalContent)) {
        finalContent = filterContact(finalContent);
        contactWarning = true;

        const flagCheck = await pool.query(
          `SELECT COUNT(*) FROM messages WHERE conversation_id = $1 AND sender_id = $2 AND content LIKE '%[kontak kache]%'`,
          [req.params.id, sender_id || '']
        );
        if (parseInt(flagCheck.rows[0].count) >= 3) {
          return res.status(429).json({
            error: 'Ou eseye pataje kontak twòp fwa. Tanpri itilize platfòm nan pou kominike.',
            contact_warning: true
          });
        }
      }
    }

    const preview = msgType === 'image' ? '📷 Imaj' : msgType === 'voice' ? '🎤 Mesaj Vokal' : msgType === 'file' ? '📎 Fichye' : finalContent.substring(0, 100);

    const msgId = uuidv4();
    await pool.query(
      `INSERT INTO messages (id, conversation_id, sender_type, sender_id, content, type, file_url, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
      [msgId, req.params.id, sender_type, sender_id || null, finalContent, msgType, file_url || null]
    );

    await pool.query(
      'UPDATE conversations SET last_message = $1, last_message_at = NOW() WHERE id = $2',
      [preview, req.params.id]
    );

    const msg = await pool.query('SELECT * FROM messages WHERE id = $1', [msgId]);
    const response = msg.rows[0];
    if (contactWarning) {
      response.contact_warning = true;
      response.warning_message = '⚠️ Enfòmasyon kontak kache pou sekirite ou. Kontak ap disponib apre chofe a aksepte kous la.';
    }

    res.status(201).json(response);
  } catch (err) {
    console.error('Send message error:', err);
    res.status(500).json({ error: 'Erè sèvè' });
  }
});

// PATCH /api/messages/conversations/:id/read
router.patch('/conversations/:id/read', async (req, res) => {
  try {
    const { reader_type } = req.body;
    if (!reader_type) return res.status(400).json({ error: 'reader_type obligatwa (rider/driver)' });

    const oppositeType = reader_type === 'rider' ? 'driver' : 'rider';
    const result = await pool.query(
      `UPDATE messages SET read_at = NOW()
       WHERE conversation_id = $1 AND sender_type = $2 AND read_at IS NULL`,
      [req.params.id, oppositeType]
    );

    res.json({ marked_read: result.rowCount });
  } catch (err) {
    console.error('Mark read error:', err);
    res.status(500).json({ error: 'Erè sèvè' });
  }
});

module.exports = router;
