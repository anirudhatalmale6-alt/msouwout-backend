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

router.post('/set-password', async (req, res) => {
  if (auth.lockedOut(req)) return res.status(429).json({ error: 'Too many attempts. Wait 15 minutes.' });
  try {
    const b = req.body || {};
    const out = await auth.useSetupToken(b.token, b.password);
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

module.exports = router;
