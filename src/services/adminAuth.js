/* ═══ THE ADMINISTRATOR'S PASSWORD (16 Oct 2026) ═════════════════════════
 *
 * Until today the admin password sat in service_config as PLAIN TEXT, and its
 * first value - seeded by db/init.js - was written in the source code, which
 * is in a public repository. It had never been changed. Anybody who read the
 * code could open the payout list and the drivers' bank details.
 *
 * Now:
 *   - only a salted scrypt hash is stored; comparison is constant-time;
 *   - a plain-text password left in the table is RETIRED at boot (it stops
 *     working - that is the point);
 *   - Jeffery chooses the new one himself through a ONE-TIME link that
 *     expires, so no password ever travels through a chat;
 *   - repeated wrong guesses from one address are locked out for a while;
 *   - ADMIN_SECRET (a server-side environment value, never in the code)
 *     still opens the admin routes for maintenance and for minting the link.
 */
const crypto = require('crypto');
const pool = require('../db/pool');

const MIN_LEN = 12;
const SETUP_HOURS = 24;
const SETUP_PREFIX = 'admin_setup:';

function sha256(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }
function scrypt(pw, salt) { return crypto.scryptSync(String(pw), String(salt), 64).toString('hex'); }
function sameText(a, b) {
  const x = Buffer.from(String(a || ''), 'utf8');
  const y = Buffer.from(String(b || ''), 'utf8');
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

async function record() {
  try {
    const r = await pool.query("SELECT value FROM service_config WHERE key = 'admin_auth'");
    let v = r.rows[0] && r.rows[0].value;
    if (typeof v === 'string') { try { v = JSON.parse(v); } catch (e) { v = null; } }
    return v || null;
  } catch (e) {
    console.error('adminAuth: could not read the admin password record:', e.message);
    return null;
  }
}

/* true for the server's ADMIN_SECRET or the administrator's own password. */
async function verifyPassword(given) {
  if (!given) return false;
  const env = process.env.ADMIN_SECRET || '';
  if (env && sameText(given, env)) return true;
  const v = await record();
  if (!v || !v.hash || !v.salt) return false;          // a plain-text value is never accepted
  return sameText(scrypt(given, v.salt), v.hash);
}

function passwordProblem(pw) {
  const s = String(pw || '');
  if (s.length < MIN_LEN) return 'Use at least ' + MIN_LEN + ' characters.';
  if (s.length > 200) return 'Too long.';
  if (/^(.)\1+$/.test(s)) return 'Too simple.';
  if (/msouwout2026/i.test(s)) return 'Do not reuse the old password.';
  return null;
}

async function setPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const value = JSON.stringify({ hash: scrypt(pw, salt), salt, setAt: new Date().toISOString(), algo: 'scrypt64' });
  await pool.query(
    `INSERT INTO service_config (key, value) VALUES ('admin_auth', $1::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [value]);
}

/* A plain-text password left over from the old scheme stops working. */
async function retirePlaintext() {
  const v = await record();
  if (v && Object.prototype.hasOwnProperty.call(v, 'password')) {
    await pool.query(`UPDATE service_config SET value = '{}'::jsonb WHERE key = 'admin_auth'`);
    console.warn('[ADMIN] The plain-text admin password was RETIRED. A new one must be set ' +
      'through a one-time link (POST /api/admin-account/setup-link with ADMIN_SECRET).');
    return true;
  }
  return false;
}

/* ── one-time links ───────────────────────────────────────────────────── */
async function createSetupToken() {
  const raw = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SETUP_HOURS * 3600 * 1000).toISOString();
  await pool.query(`DELETE FROM service_config WHERE key LIKE '${SETUP_PREFIX}%'`);   // only one live link
  await pool.query(`INSERT INTO service_config (key, value) VALUES ($1, $2::jsonb)`,
    [SETUP_PREFIX + sha256(raw), JSON.stringify({ expiresAt })]);
  return { token: raw, expiresAt };
}

async function setupTokenValid(raw) {
  if (!/^[a-f0-9]{64}$/.test(String(raw || ''))) return false;
  const r = await pool.query('SELECT value FROM service_config WHERE key = $1', [SETUP_PREFIX + sha256(raw)]);
  let v = r.rows[0] && r.rows[0].value;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch (e) { v = null; } }
  return !!(v && v.expiresAt && new Date(v.expiresAt) > new Date());
}

/* Single use: the row is DELETED as it is used, so two attempts cannot both win. */
async function useSetupToken(raw, newPw) {
  const problem = passwordProblem(newPw);
  if (problem) return { ok: false, code: 400, message: problem };
  if (!/^[a-f0-9]{64}$/.test(String(raw || ''))) return { ok: false, code: 410, message: 'This link is not valid.' };
  const r = await pool.query('DELETE FROM service_config WHERE key = $1 RETURNING value', [SETUP_PREFIX + sha256(raw)]);
  let v = r.rows[0] && r.rows[0].value;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch (e) { v = null; } }
  if (!v) return { ok: false, code: 410, message: 'This link was already used or replaced.' };
  if (!v.expiresAt || new Date(v.expiresAt) <= new Date()) return { ok: false, code: 410, message: 'This link has expired.' };
  await setPassword(newPw);
  console.warn('[ADMIN] The administrator password was set through a one-time link at ' + new Date().toISOString());
  return { ok: true };
}

/* ── wrong guesses ────────────────────────────────────────────────────── */
const FAILS = new Map();            // ip -> { n, until }
const MAX_FAILS = 8, WINDOW_MS = 15 * 60 * 1000;
/* The address Render's edge saw. The FIRST X-Forwarded-For entry is whatever
   the caller chose to send, so keying on it would let a guesser dodge the
   lockout; the edge's own header, or the LAST entry (added by the proxy), is
   what the caller cannot set. */
function clientIp(req) {
  const h = (req && req.headers) || {};
  const cf = String(h['cf-connecting-ip'] || '').trim();
  if (cf) return cf;
  const parts = String(h['x-forwarded-for'] || '').split(',').map(function (x) { return x.trim(); }).filter(Boolean);
  return parts[parts.length - 1] || (req.socket && req.socket.remoteAddress) || 'unknown';
}
function lockedOut(req) {
  const f = FAILS.get(clientIp(req));
  return !!(f && f.n >= MAX_FAILS && f.until > Date.now());
}
function noteFailure(req) {
  const ip = clientIp(req), now = Date.now();
  const f = FAILS.get(ip);
  const cur = f && f.until > now ? f : { n: 0, until: now + WINDOW_MS };
  cur.n += 1; FAILS.set(ip, cur);
  if (cur.n === MAX_FAILS) console.warn('[ADMIN] ' + MAX_FAILS + ' wrong admin passwords from ' + ip + ' - locked for 15 minutes');
  if (FAILS.size > 5000) FAILS.clear();
}
function noteSuccess(req) { FAILS.delete(clientIp(req)); }

module.exports = {
  verifyPassword, setPassword, retirePlaintext, passwordProblem,
  createSetupToken, setupTokenValid, useSetupToken,
  lockedOut, noteFailure, noteSuccess, sameText, MIN_LEN
};
