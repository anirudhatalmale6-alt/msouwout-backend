/* PERMANENT ADMIN ACTIVITY RECORD (16 Oct 2026).
 *
 * Jeffery, after the log review: "it does not prove that no one accessed the
 * systems before October 9. I recommend preserving the available audit records
 * and eventually implementing longer-term security logging."
 * Render keeps application logs for about 7 days. This keeps, in our own
 * database and with no expiry, one row per administrator action or attempt:
 * when, from where, what, with which kind of credential, and the answer.
 *
 * ⛔ The credential itself is NEVER stored - only its kind (server secret,
 *    12-hour session, or password).
 * ⛔ Never in the way: a write that fails is logged and forgotten; it can
 *    never slow down or break the request it describes.
 */
const pool = require('../db/pool');

function credKind(given) {
  const g = String(given || '');
  if (!g) return 'none';
  if (process.env.ADMIN_SECRET && g === process.env.ADMIN_SECRET) return 'server-secret';
  if (/^mws_/.test(g)) return 'session';
  return 'password';
}

function record(req, fields) {
  try {
    const ip = (fields && fields.ip) || '';
    pool.query(
      `INSERT INTO admin_audit (method, path, ip, user_agent, cred, outcome, status, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [String((req && req.method) || fields.method || '').slice(0, 8),
       String(fields.path || (req && (req.originalUrl || req.url)) || '').split('?')[0].slice(0, 300),
       String(ip).slice(0, 64),
       String((req && req.headers && req.headers['user-agent']) || '').slice(0, 200),
       fields.cred || 'none', String(fields.outcome || '').slice(0, 20),
       fields.status == null ? null : Number(fields.status),
       fields.note ? String(fields.note).slice(0, 300) : null])
      .catch(e => console.error('[ADMIN AUDIT] not recorded:', e.message));
  } catch (e) { /* never in the way */ }
}

/* Record when the answer is known, so the row carries the real status code. */
function onFinish(req, res, fields) {
  res.on('finish', () => record(req, Object.assign({}, fields, { status: res.statusCode })));
}

async function recent(limit) {
  const n = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500);
  const r = await pool.query(
    `SELECT id, at, method, path, ip, cred, outcome, status, note
       FROM admin_audit ORDER BY id DESC LIMIT $1`, [n]);
  return r.rows;
}

module.exports = { record, onFinish, credKind, recent };
