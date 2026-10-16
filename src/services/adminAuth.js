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
const SESSION_PREFIX = 'admin_session:';
const SESSION_HOURS = 12;

/* ═══ TWO-FACTOR (16 Oct 2026, Jeffery: "an authenticator application rather
   than SMS") - standard TOTP (RFC 6238: 6 digits, 30 s, SHA-1), which Google
   and Microsoft Authenticator both read. Once it is switched on, the password
   ALONE opens nothing: a login with password + code returns an admin session
   (12 h), and the admin pages send that session instead of the password. */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function b32encode(buf) {
  let bits = 0, val = 0, out = '';
  for (const b of buf) { val = (val << 8) | b; bits += 8; while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
}
function b32decode(str) {
  const clean = String(str || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, val = 0; const out = [];
  for (const c of clean) { val = (val << 5) | B32.indexOf(c); bits += 5; if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; } }
  return Buffer.from(out);
}
function hotp(secretB32, counter) {
  const key = b32decode(secretB32);
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', key).update(msg).digest();
  const o = h[h.length - 1] & 15;
  const code = ((h[o] & 127) << 24 | h[o + 1] << 16 | h[o + 2] << 8 | h[o + 3]) % 1000000;
  return String(code).padStart(6, '0');
}
/* the counter that matched (to refuse a replay), or -1 */
function totpMatch(secretB32, code, nowMs) {
  const c = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c) || !secretB32) return -1;
  const t = Math.floor((nowMs || Date.now()) / 30000);
  for (const d of [0, -1, 1]) if (sameText(hotp(secretB32, t + d), c)) return t + d;
  return -1;
}
function newTotpSecret() { return b32encode(crypto.randomBytes(20)); }
function otpauthUri(secret) {
  return 'otpauth://totp/' + encodeURIComponent('MsouWout:admin') + '?secret=' + secret +
    '&issuer=MsouWout&algorithm=SHA1&digits=6&period=30';
}

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
  if (/^mws_[a-f0-9]{64}$/.test(String(given))) return sessionValid(given);
  const v = await record();
  if (!v || !v.hash || !v.salt) return false;          // a plain-text value is never accepted
  if (v.totp) return false;                            // two-factor on: the password alone opens nothing
  return sameText(scrypt(given, v.salt), v.hash);
}

/* password + 6-digit code -> a 12-hour admin session */
async function login(password, code) {
  const v = await record();
  if (!v || !v.hash || !v.salt || !sameText(scrypt(password, v.salt), v.hash)) return { ok: false, code: 401, message: 'Wrong password or code.' };
  if (v.totp) {
    const ctr = totpMatch(v.totp, code);
    const last = Number.isFinite(Number(v.lastCounter)) ? Number(v.lastCounter) : -1;
    if (ctr < 0 || ctr <= last) return { ok: false, code: 401, message: 'Wrong password or code.' };
    v.lastCounter = ctr;                                // a code is good once
    await pool.query(`UPDATE service_config SET value = $1::jsonb WHERE key = 'admin_auth'`, [JSON.stringify(v)]);
  }
  const raw = 'mws_' + crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_HOURS * 3600 * 1000).toISOString();
  await pool.query(`INSERT INTO service_config (key, value) VALUES ($1, $2::jsonb)`,
    [SESSION_PREFIX + sha256(raw), JSON.stringify({ expiresAt })]);
  await pool.query(`DELETE FROM service_config WHERE key LIKE '${SESSION_PREFIX}%' AND (value->>'expiresAt')::timestamptz < NOW()`).catch(() => {});
  return { ok: true, token: raw, expiresAt, twoFactor: !!v.totp };
}
async function sessionValid(raw) {
  const r = await pool.query('SELECT value FROM service_config WHERE key = $1', [SESSION_PREFIX + sha256(raw)]);
  let v = r.rows[0] && r.rows[0].value;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch (e) { v = null; } }
  return !!(v && v.expiresAt && new Date(v.expiresAt) > new Date());
}
async function logout(raw) {
  if (/^mws_[a-f0-9]{64}$/.test(String(raw || ''))) await pool.query('DELETE FROM service_config WHERE key = $1', [SESSION_PREFIX + sha256(raw)]);
}
async function twoFactorOn() { const v = await record(); return !!(v && v.totp); }

function passwordProblem(pw) {
  const s = String(pw || '');
  if (s.length < MIN_LEN) return 'Use at least ' + MIN_LEN + ' characters.';
  if (s.length > 200) return 'Too long.';
  if (/^(.)\1+$/.test(s)) return 'Too simple.';
  if (/msouwout2026/i.test(s)) return 'Do not reuse the old password.';
  return null;
}

async function setPassword(pw, totpSecret) {
  const salt = crypto.randomBytes(16).toString('hex');
  const rec = { hash: scrypt(pw, salt), salt, setAt: new Date().toISOString(), algo: 'scrypt64' };
  if (totpSecret) { rec.totp = totpSecret; rec.lastCounter = -1; }
  const value = JSON.stringify(rec);
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

/* Step 1 on the page: the authenticator key for THIS link (kept with the link). */
async function beginSetup(raw) {
  if (!(await setupTokenValid(raw))) return { ok: false, code: 410, message: 'This link was already used or has expired.' };
  const key = SETUP_PREFIX + sha256(raw);
  const r = await pool.query('SELECT value FROM service_config WHERE key = $1', [key]);
  let v = r.rows[0] && r.rows[0].value; if (typeof v === 'string') v = JSON.parse(v);
  if (!v.totp) { v.totp = newTotpSecret(); await pool.query('UPDATE service_config SET value = $2::jsonb WHERE key = $1', [key, JSON.stringify(v)]); }
  return { ok: true, secret: v.totp, uri: otpauthUri(v.totp) };
}

/* Single use: the row is DELETED as it is used, so two attempts cannot both win.
   With two-factor, the 6-digit code from the app must match first - proof
   the authenticator really holds the key before the old way in is closed. */
async function useSetupToken(raw, newPw, code) {
  const problem = passwordProblem(newPw);
  if (problem) return { ok: false, code: 400, message: problem };
  if (/^[a-f0-9]{64}$/.test(String(raw || ''))) {
    const r0 = await pool.query('SELECT value FROM service_config WHERE key = $1', [SETUP_PREFIX + sha256(raw)]);
    let v0 = r0.rows[0] && r0.rows[0].value; if (typeof v0 === 'string') { try { v0 = JSON.parse(v0); } catch (e) { v0 = null; } }
    if (v0 && v0.totp && totpMatch(v0.totp, code) < 0) return { ok: false, code: 400, message: 'The 6-digit code does not match. Check the app and try again.' };
    if (v0 && !v0.totp) return { ok: false, code: 400, message: 'Add the key to your authenticator app first.' };
  }
  if (!/^[a-f0-9]{64}$/.test(String(raw || ''))) return { ok: false, code: 410, message: 'This link is not valid.' };
  const r = await pool.query('DELETE FROM service_config WHERE key = $1 RETURNING value', [SETUP_PREFIX + sha256(raw)]);
  let v = r.rows[0] && r.rows[0].value;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch (e) { v = null; } }
  if (!v) return { ok: false, code: 410, message: 'This link was already used or replaced.' };
  if (!v.expiresAt || new Date(v.expiresAt) <= new Date()) return { ok: false, code: 410, message: 'This link has expired.' };
  await setPassword(newPw, v.totp);
  await pool.query(`DELETE FROM service_config WHERE key LIKE '${SESSION_PREFIX}%'`).catch(() => {});   // every old session ends
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
  createSetupToken, setupTokenValid, useSetupToken, beginSetup,
  login, logout, sessionValid, twoFactorOn, totpMatch, hotp, b32encode, b32decode,
  lockedOut, noteFailure, noteSuccess, sameText, MIN_LEN, clientIp
};
