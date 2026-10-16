/* The administrator sets his own password through a one-time link (16 Oct 2026).
 *
 *   POST /api/admin-account/setup-link   x-admin-secret: <ADMIN_SECRET>
 *        -> { token, expiresAt }   (24 h, single use, replaces any older link)
 *   GET  /api/admin-account/setup-status?t=<token>  -> { valid }
 *   POST /api/admin-account/set-password  { token, password }
 *
 * Only ADMIN_SECRET - a server-side environment value that is in no code and
 * no chat - can mint a link. The link carries no password; Jeffery types his
 * own on the page, so nothing secret ever passes through a message. Used once,
 * the link is gone: if he ever finds it "already used", someone else opened it.
 */
const express = require('express');
const router = express.Router();
const auth = require('../services/adminAuth');
const audit = require('../services/adminAudit');
/* Every event on this router goes into the permanent admin record. */
router.use((req, res, next) => {
  /* /activity is recorded by middleware/adminOnly.js already; the two status
     reads are public, harmless and polled. */
  if (/^\/activity/.test(req.path) || (req.method === 'GET' && /status/.test(req.path))) return next();
  audit.onFinish(req, res, { ip: auth.clientIp(req), outcome: 'account:' + req.path.replace(/^\//, '').slice(0, 12),
    cred: audit.credKind(req.headers['x-admin-secret'] || req.headers['x-admin-pass']) });
  next();
});

router.post('/setup-link', async (req, res) => {
  const env = process.env.ADMIN_SECRET || '';
  if (auth.lockedOut(req)) return res.status(429).json({ error: 'Too many attempts. Wait 15 minutes.' });
  if (!env || !auth.sameText(req.headers['x-admin-secret'], env)) {
    auth.noteFailure(req);
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const out = await auth.createSetupToken();
    res.json(out);
  } catch (e) {
    console.error('setup-link:', e.message);
    res.status(500).json({ error: 'Could not create the link' });
  }
});

router.get('/setup-status', async (req, res) => {
  try { res.json({ valid: await auth.setupTokenValid(req.query.t) }); }
  catch (e) { res.json({ valid: false }); }
});

/* Step 1 of the page: the authenticator key that belongs to this link. */
router.post('/begin-setup', async (req, res) => {
  if (auth.lockedOut(req)) return res.status(429).json({ error: 'Too many attempts. Wait 15 minutes.' });
  try {
    const out = await auth.beginSetup((req.body || {}).token);
    if (!out.ok) { auth.noteFailure(req); return res.status(out.code || 400).json({ error: out.message }); }
    res.json({ secret: out.secret, uri: out.uri });
  } catch (e) { console.error('begin-setup:', e.message); res.status(500).json({ error: 'Could not start' }); }
});

/* The link is EMAILED by the server straight to the administrator's own
   address (ADMIN_EMAIL), so it never passes through a chat - or through the
   developer, who never sees it. Only ADMIN_SECRET can ask for it. */
router.post('/email-setup-link', async (req, res) => {
  const env = process.env.ADMIN_SECRET || '';
  if (auth.lockedOut(req)) return res.status(429).json({ error: 'Too many attempts. Wait 15 minutes.' });
  if (!env || !auth.sameText(req.headers['x-admin-secret'], env)) { auth.noteFailure(req); return res.status(401).json({ error: 'Unauthorized' }); }
  const to = String(process.env.ADMIN_EMAIL || '').trim();
  const key = process.env.BREVO_API_KEY || '', from = process.env.MAIL_FROM || '';
  if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(to) || !key || !from) return res.status(503).json({ error: 'ADMIN_EMAIL, BREVO_API_KEY and MAIL_FROM must be set on the server' });
  try {
    const out = await auth.createSetupToken();
    const link = 'https://msouwout.com/admin-setup.html#t=' + out.token;
    const html = '<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#0F172A">' +
      '<p><b>MsouWout - administrator password</b></p>' +
      '<p>Tap the button to choose your new administrator password and connect your authenticator app. ' +
      'The link works ONCE and expires ' + out.expiresAt.replace('T', ' ').slice(0, 16) + ' UTC.</p>' +
      '<p><a href="' + link + '" style="display:inline-block;background:#00209F;color:#fff;padding:12px 18px;border-radius:10px;text-decoration:none;font-weight:bold">Set my password</a></p>' +
      '<p style="color:#5B6478;font-size:13px">If you did not ask for this, do not open it and tell your developer. ' +
      'Kreyòl: Peze bouton an pou chwazi nouvo modpas ou. Lyen an mache yon sèl fwa.</p></div>';
    const r = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST', headers: { 'api-key': key, 'Content-Type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ sender: { email: from, name: process.env.MAIL_FROM_NAME || 'MsouWout' }, to: [{ email: to }],
        subject: 'MsouWout - set your administrator password', htmlContent: html })
    });
    if (!r.ok) { console.error('email-setup-link: Brevo answered ' + r.status); return res.status(502).json({ error: 'The email could not be sent (' + r.status + ')' }); }
    const masked = to.replace(/^(.)(.*)(.@.*)$/, function (m, a, b, c) { return a + b.replace(/./g, '*') + c; });
    res.json({ sent: true, to: masked, expiresAt: out.expiresAt });
  } catch (e) { console.error('email-setup-link:', e.message); res.status(500).json({ error: 'Could not send' }); }
});

/* password + 6-digit code -> a 12-hour admin session */
router.post('/login', async (req, res) => {
  if (auth.lockedOut(req)) return res.status(429).json({ error: 'Too many attempts. Wait 15 minutes.' });
  try {
    const b = req.body || {};
    const out = await auth.login(String(b.password || ''), String(b.code || ''));
    if (!out.ok) { auth.noteFailure(req); return res.status(out.code || 401).json({ error: out.message }); }
    auth.noteSuccess(req);
    res.json({ token: out.token, expiresAt: out.expiresAt, twoFactor: out.twoFactor });
  } catch (e) { console.error('admin login:', e.message); res.status(500).json({ error: 'Login failed' }); }
});
router.post('/logout', async (req, res) => {
  try { await auth.logout(req.headers['x-admin-pass'] || req.headers['x-admin-secret'] || (req.body || {}).token); } catch (e) {}
  res.json({ ok: true });
});
router.get('/status', async (req, res) => {
  try { res.json({ twoFactor: await auth.twoFactorOn() }); } catch (e) { res.json({ twoFactor: false }); }
});

router.post('/set-password', async (req, res) => {
  if (auth.lockedOut(req)) return res.status(429).json({ error: 'Too many attempts. Wait 15 minutes.' });
  try {
    const b = req.body || {};
    const out = await auth.useSetupToken(b.token, b.password, b.code);
    if (!out.ok) {
      if (out.code === 410) auth.noteFailure(req);
      return res.status(out.code || 400).json({ error: out.message });
    }
    res.json({ ok: true });
  } catch (e) {
    console.error('set-password:', e.message);
    res.status(500).json({ error: 'Could not save the password' });
  }
});

/* GET /api/admin-account/activity?limit=100 - the permanent admin record.
   Admin-only (middleware/adminOnly.js). */
router.get('/activity', async (req, res) => {
  try { res.json({ rows: await audit.recent(req.query.limit) }); }
  catch (e) { console.error('activity:', e.message); res.status(500).json({ error: 'Could not read the record' }); }
});

module.exports = router;
