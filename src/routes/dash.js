/* ═══ DASH's PARTNER STRUCTURES, EDITABLE WITHOUT ME ═══════════════════════
 *
 * Jeffery, 8 Oct 2026: "DASH CLINICS: Yes, I approve a simple admin screen so
 * authorized personnel can update clinic availability, addresses, and phone
 * numbers without modifying the code. Keep it lightweight and secure."
 *
 * Until now the fourteen structures lived in the HTML of dash-dashboard.html,
 * so a clinic closing for security - which DASH's own page says happens -
 * needed a deploy from me. An injured passenger is pointed at the nearest
 * structure on this list; a stale list sends somebody to a door that will turn
 * them away.
 *
 * 🔑 READ IS PUBLIC. The list is already published on dashhaiti.org, and the
 * emergency page has to work for a passenger who has no key and is not signed
 * in to anything. ⛔ WRITE IS NOT: it takes either Jeffery's admin secret or a
 * key minted for DASH, and nothing else.
 *
 * 🔑 THE DASH KEY IS NOT THE PORTAL KEY. DASH_PORTAL_KEY travels in a URL that
 * gets forwarded in WhatsApp; giving it the power to rewrite the clinic list
 * would mean anybody who was ever sent the dashboard link could rewrite where
 * injured people are sent. The edit key is separate, hashed, and revocable on
 * its own.
 * ═══════════════════════════════════════════════════════════════════════════ */
const express = require('express');
const crypto = require('crypto');
const router = express.Router();
/* ⚠️ `require('../db/pool')`, exporting the pool DIRECTLY - there is no
   ../db/index.js and no named export. Every other route in this service does
   it this way; destructuring here would have been `undefined.query`. */
const pool = require('../db/pool');

const STATUSES = ['open', 'closed', 'temporary'];

/* The fourteen, taken verbatim from dashhaiti.org/nos-structures on 8 Oct
   2026 and used ONCE, to fill an empty table. ⛔ It is not a reset: if the
   table has any row in it this does nothing, so an edit made by DASH is never
   overwritten by a redeploy. */
const SEED = [
  ['Hôpital OMNI Per Mariam', 'Rue Clerveaux, Pétion-Ville', '3316-0200 / 3325-4365', 'Pétion-Ville', 'open'],
  ['La Croix Dieu', '325, Delmas 67', '4394-5577', 'Delmas', 'open'],
  ['Hôpital Jude-Anne', 'Delmas 18', '4062-0642 / 4061-2152', 'Delmas', 'temporary'],
  ['Hôpital St Landry', '#25, Rue Aubran, Pétion-Ville', '3222-1019 / 4393-0969', 'Pétion-Ville', 'open'],
  ['Hôpital Mont-Carmel', 'Rue Metelus', '4061-6134 / 3214-1227', 'Pétion-Ville', 'open'],
  ['Hôpital Ste Claire', 'Laboule 11 C', '4893-9486', 'Laboule', 'open'],
  ['Hôpital St James', 'Martissant 4', '4437-1254', 'Martissant', 'temporary'],
  ['Hôpital Christ du Nord', 'Rue 17K, Cap-Haïtien', '3219-4051', 'Cap-Haïtien', 'open'],
  ['Hôpital Ste-Cène', 'Rte de Frères, Niveau Jacquet Toto', '4061-7155', 'Frères', 'open'],
  ['DASH / Tabarre', 'BLVD 15 Octobre, à côté de la Camep', '4706-9431', 'Tabarre', 'temporary'],
  ['Clinique médico-chirurgicale Oswald Durand', '', '4061-0086', '', 'temporary'],
  ['Sonapi', 'Parc industriel, Sonapi', '3316-1060', 'Port-au-Prince', 'open'],
  ['DASH Carries', 'En face Warf de la Gonâve', '4891-7562', 'Carries', 'temporary'],
  ['DASH Montrouis', 'Tout près Royal Decameron', '4891-7562', 'Montrouis', 'temporary']
];
const CLOSED_NOTE = 'Temporairement indisponible pour raisons de sécurité';

let seedChecked = false;
async function seedOnce() {
  if (seedChecked) return;
  seedChecked = true;
  try {
    const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM dash_clinics');
    if (rows[0].n > 0) return;
    for (let i = 0; i < SEED.length; i++) {
      const [name, address, phones, city, status] = SEED[i];
      await pool.query(
        `INSERT INTO dash_clinics (name, address, phones, city, status, note, sort_order, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'seed')`,
        [name, address, phones, city, status, status === 'open' ? '' : CLOSED_NOTE, i * 10]);
    }
    console.log('dash_clinics seeded with the 14 structures from dashhaiti.org');
  } catch (e) {
    /* A failed seed must not take the route down - the list simply comes back
       empty and the page says so. */
    seedChecked = false;
    console.error('dash_clinics seed failed:', e.message);
  }
}

function sha(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }

function sameSecret(a, b) {
  const x = Buffer.from(String(a || ''), 'utf8');
  const y = Buffer.from(String(b || ''), 'utf8');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/* Jeffery's own console secret. Mirrors middleware/adminOnly.js rather than
   inventing a second rule, including its fail-closed behaviour. */
function isOwner(req) {
  const envSecret = process.env.ADMIN_SECRET || null;
  const given = req.headers['x-admin-secret'] || req.headers['x-admin-pass'] ||
    (req.body || {}).admin_pass || req.query.secret || req.query.pass || '';
  return !!(envSecret && given && sameSecret(given, envSecret));
}

/* A key minted for DASH. Only the hash is stored, so a database dump does not
   hand somebody the ability to rewrite the list. */
async function isDashEditor(req) {
  const given = String(req.headers['x-dash-edit-key'] || req.query.ek || '');
  if (given.length < 16) return false;
  const h = sha(given);
  const k = await pool.query(
    `SELECT id FROM dash_access_keys
      WHERE label = 'clinics' AND revoked_at IS NULL AND key_hash = $1 LIMIT 1`, [h]);
  if (!k.rows.length) return false;
  await pool.query('UPDATE dash_access_keys SET last_used_at = NOW() WHERE id = $1',
                   [k.rows[0].id]);
  return true;
}

async function canEdit(req) {
  if (isOwner(req)) return 'owner';
  if (await isDashEditor(req)) return 'dash';
  return null;
}

function clean(s, max) {
  return String(s === undefined || s === null ? '' : s).trim().slice(0, max);
}
function numOrNull(v) {
  if (v === '' || v === undefined || v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function row(c) {
  return {
    id: c.id, name: c.name, address: c.address, phones: c.phones, city: c.city,
    status: c.status, note: c.note,
    lat: c.lat === null ? null : Number(c.lat),
    lng: c.lng === null ? null : Number(c.lng),
    sortOrder: c.sort_order,
    updatedAt: c.updated_at, updatedBy: c.updated_by
  };
}

/* ───────────────────────────────────────────────────────────────────────────
   PUBLIC READ
   ─────────────────────────────────────────────────────────────────────────── */
router.get('/clinics', async (req, res) => {
  try {
    await seedOnce();
    const { rows } = await pool.query(
      'SELECT * FROM dash_clinics ORDER BY sort_order ASC, name ASC');
    const list = rows.map(row);
    res.json({
      count: list.length,
      open: list.filter(c => c.status === 'open').length,
      /* ⛔ The two kinds of unavailable are counted separately. "14 structures"
         with six of them shut is a different sentence from "8 structures". */
      unavailable: list.filter(c => c.status !== 'open').length,
      clinics: list,
      source: 'dashhaiti.org/nos-structures'
    });
  } catch (err) {
    /* An empty list and an error are NOT the same thing to somebody looking
       for the nearest hospital, so say which. */
    res.status(500).json({ error: err.message, clinics: null });
  }
});

/* ───────────────────────────────────────────────────────────────────────────
   WRITE
   ─────────────────────────────────────────────────────────────────────────── */
async function requireEditor(req, res, next) {
  try {
    const who = await canEdit(req);
    if (!who) return res.status(401).json({ error: 'Unauthorized' });
    req.editor = who;
    next();
  } catch (err) { res.status(500).json({ error: err.message }); }
}

router.post('/clinics', requireEditor, async (req, res) => {
  try {
    const name = clean(req.body.name, 255);
    if (!name) return res.status(400).json({ error: 'A name is required' });
    const status = STATUSES.includes(req.body.status) ? req.body.status : 'open';
    const { rows } = await pool.query(
      `INSERT INTO dash_clinics (name, address, phones, city, status, note, lat, lng,
                                 sort_order, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,
               COALESCE((SELECT MAX(sort_order) + 10 FROM dash_clinics), 0), $9)
       RETURNING *`,
      [name, clean(req.body.address, 400), clean(req.body.phones, 200),
       clean(req.body.city, 120), status,
       clean(req.body.note, 300) || (status === 'open' ? '' : CLOSED_NOTE),
       numOrNull(req.body.lat), numOrNull(req.body.lng), req.editor]);
    res.status(201).json({ clinic: row(rows[0]) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/clinics/:id', requireEditor, async (req, res) => {
  try {
    const sets = [], vals = [];
    const push = (col, v) => { vals.push(v); sets.push(col + ' = $' + vals.length); };

    if (req.body.name !== undefined) {
      const n = clean(req.body.name, 255);
      if (!n) return res.status(400).json({ error: 'A name is required' });
      push('name', n);
    }
    if (req.body.address !== undefined) push('address', clean(req.body.address, 400));
    if (req.body.phones !== undefined) push('phones', clean(req.body.phones, 200));
    if (req.body.city !== undefined) push('city', clean(req.body.city, 120));
    if (req.body.status !== undefined) {
      if (!STATUSES.includes(req.body.status)) {
        return res.status(400).json({ error: 'status must be open, temporary or closed' });
      }
      push('status', req.body.status);
      /* Changing the status without touching the note used to leave "closed
         for security" sitting under a clinic that had reopened. */
      if (req.body.note === undefined) {
        push('note', req.body.status === 'open' ? '' : CLOSED_NOTE);
      }
    }
    if (req.body.note !== undefined) push('note', clean(req.body.note, 300));
    if (req.body.lat !== undefined) push('lat', numOrNull(req.body.lat));
    if (req.body.lng !== undefined) push('lng', numOrNull(req.body.lng));
    if (req.body.sortOrder !== undefined) push('sort_order', parseInt(req.body.sortOrder, 10) || 0);
    if (!sets.length) return res.status(400).json({ error: 'Nothing to change' });

    push('updated_by', req.editor);
    sets.push('updated_at = NOW()');
    vals.push(req.params.id);
    const { rows } = await pool.query(
      'UPDATE dash_clinics SET ' + sets.join(', ') + ' WHERE id = $' + vals.length +
      ' RETURNING *', vals);
    if (!rows.length) return res.status(404).json({ error: 'Clinic not found' });
    res.json({ clinic: row(rows[0]) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ⛔ Deleting is the OWNER's alone. Marking a structure closed is the normal
   operation and it keeps the history; a partner updating availability should
   not be able to make a site vanish from the record. */
router.delete('/clinics/:id', requireEditor, async (req, res) => {
  try {
    if (req.editor !== 'owner') {
      return res.status(403).json({
        error: 'Mark it closed instead. Only the MsouWout console can remove a structure.'
      });
    }
    const { rows } = await pool.query(
      'DELETE FROM dash_clinics WHERE id = $1 RETURNING id', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Clinic not found' });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ───────────────────────────────────────────────────────────────────────────
   THE KEY DASH IS GIVEN. Owner only.
   ─────────────────────────────────────────────────────────────────────────── */
router.get('/clinics-key', async (req, res) => {
  try {
    if (!isOwner(req)) return res.status(401).json({ error: 'Unauthorized' });
    const { rows } = await pool.query(
      `SELECT id, created_at, last_used_at FROM dash_access_keys
        WHERE label = 'clinics' AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1`);
    /* ⛔ There is no field here that could carry the key itself. */
    res.json({ exists: rows.length > 0, key: rows[0] || null });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/clinics-key', async (req, res) => {
  try {
    if (!isOwner(req)) return res.status(401).json({ error: 'Unauthorized' });
    const key = crypto.randomBytes(18).toString('base64url');
    /* Minting a new one revokes the old, so there is never a second key in
       circulation that somebody forgot about. */
    await pool.query(
      `UPDATE dash_access_keys SET revoked_at = NOW()
        WHERE label = 'clinics' AND revoked_at IS NULL`);
    await pool.query(
      `INSERT INTO dash_access_keys (label, key_hash) VALUES ('clinics', $1)`, [sha(key)]);
    res.status(201).json({
      key,                                   /* shown once */
      note: 'This key is not stored anywhere readable. If it is lost, make a new one.'
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/clinics-key', async (req, res) => {
  try {
    if (!isOwner(req)) return res.status(401).json({ error: 'Unauthorized' });
    const { rowCount } = await pool.query(
      `UPDATE dash_access_keys SET revoked_at = NOW()
        WHERE label = 'clinics' AND revoked_at IS NULL`);
    res.json({ success: true, revoked: rowCount });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* Who am I? Used by the edit page to decide what to show before anything is
   changed, so a DASH editor is never offered a Delete button that would
   refuse. */
router.get('/whoami', async (req, res) => {
  try {
    const who = await canEdit(req);
    res.json({ editor: who, canDelete: who === 'owner' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
