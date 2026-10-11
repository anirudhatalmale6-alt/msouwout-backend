/* ═══ THE CHANNEL FOR THINGS THAT FAIL ON SOMEBODY ELSE'S PHONE ═══════════
 *
 * Jeffery, 11 Oct 2026: "NO MORE SILENT FAILURES. When something goes wrong,
 * the system must explain the problem clearly and record enough information
 * for you to diagnose it."
 *
 * Both of Jennifer's bugs this week were silent. The fare never appeared and
 * nothing said why. Cancel did nothing and nothing said why. All that reached
 * me was "it does not work", and finding each one meant reconstructing her
 * network conditions by guesswork.
 *
 * So the page writes down what failed, here, and I can read it without her
 * having to describe anything.
 *
 * ⛔ WHAT THIS IS NOT: a tracking log. No name, no address, no GPS position.
 * A diagnostic channel that quietly grows into surveillance is a different
 * product from the one anybody agreed to, and the way that happens is one
 * field at a time. The phone number is optional and is only ever the one the
 * page already had on screen.
 * ═══════════════════════════════════════════════════════════════════════════ */
const express = require('express');
const router = express.Router();
const pool = require('../db/pool');

const MAX_PER_IP = 20;              /* in the window below */
const WINDOW_MS = 10 * 60 * 1000;
const KEEP_DAYS = 30;

const seen = new Map();
function tooMany(ip) {
  const row = seen.get(ip);
  const now = Date.now();
  if (!row || now - row.at > WINDOW_MS) { seen.set(ip, { n: 1, at: now }); return false; }
  row.n++;
  if (seen.size > 5000) {
    for (const [k, v] of seen) if (now - v.at > WINDOW_MS) seen.delete(k);
  }
  return row.n > MAX_PER_IP;
}

function clean(v, max) {
  return String(v === undefined || v === null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);
}

/* POST /api/diag — public on purpose: a passenger whose page is broken is not
   signed in to anything, and a report that needs a working session is a
   report that never arrives.

   ⚠️ It answers 204 whatever happens. A failure to record a failure must
   never produce a second error on a page that is already in trouble. */
router.post('/', async (req, res) => {
  res.status(204).end();
  try {
    const ip = String(req.headers['x-forwarded-for'] || req.ip || 'unknown').split(',')[0].trim();
    if (tooMany(ip)) return;

    const b = req.body || {};
    const message = clean(b.message, 500);
    if (!message) return;

    await pool.query(
      `INSERT INTO client_errors
         (where_at, message, detail, tracking_code, phone, platform,
          app_version, user_agent, online)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [clean(b.where, 80), message, clean(b.detail, 2000),
       clean(b.tracking_code, 20) || null, clean(b.phone, 50) || null,
       clean(b.platform, 30) || 'msouwout', clean(b.app_version, 40),
       clean(req.headers['user-agent'], 300),
       typeof b.online === 'boolean' ? b.online : null]);

    /* Trim on write rather than on a schedule: no cron to forget about, and
       the table cannot grow without somebody writing to it. */
    if (Math.random() < 0.02) {
      await pool.query(
        `DELETE FROM client_errors WHERE created_at < NOW() - INTERVAL '${KEEP_DAYS} days'`);
    }
  } catch (err) {
    console.error('[DIAG] could not record a client error:', err.message);
  }
});

/* GET /api/diag — mine to read. Behind the admin gate in middleware/adminOnly. */
router.get('/', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const since = req.query.hours
      ? `NOW() - INTERVAL '${Math.min(parseInt(req.query.hours, 10) || 24, 720)} hours'`
      : `NOW() - INTERVAL '48 hours'`;
    const rows = await pool.query(
      `SELECT * FROM client_errors WHERE created_at > ${since}
        ORDER BY created_at DESC LIMIT $1`, [limit]);
    /* Grouped as well as listed: twenty copies of one fault is one fault, and
       the shape of the list is what says which. */
    const grouped = await pool.query(
      `SELECT where_at, message, COUNT(*)::int AS n,
              MAX(created_at) AS last_seen
         FROM client_errors WHERE created_at > ${since}
        GROUP BY 1,2 ORDER BY n DESC, last_seen DESC LIMIT 50`);
    res.json({ count: rows.rows.length, grouped: grouped.rows, errors: rows.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
