/* Paying out what the ledger says is owed. The rules, and the reasoning behind
   which side of the admin line each route falls on, are in
   src/services/payouts.js - read that first.

   ⚠️ ROUTE ORDER. '/driver/...' is registered BEFORE '/:id/...' so that a
   driver path can never be swallowed by the payout-id patterns. Express takes
   the first match, and the admin gate uses anchored regexes over the same
   paths, so the two have to agree about which is which. */
const express = require('express');
const router = express.Router();
const payouts = require('../services/payouts');

/* Every handler answers the same way: a service result carrying `error` and
   `code` becomes that status, anything else is 200. Keeping the mapping in one
   place is what stops a 409 quietly going out as a 200 on some later route. */
function reply(res, out) {
  if (out && out.error) return res.status(out.code || 400).json(out);
  return res.json(out);
}
function wrap(fn) {
  return async (req, res) => {
    try { reply(res, await fn(req)); }
    catch (err) {
      console.error('Payout error:', err);
      res.status(500).json({ error: 'Payout operation failed' });
    }
  };
}

/* ── DRIVER-FACING ────────────────────────────────────────────────────────
   These carry no credential, exactly like POST /api/drivers/login, because
   they are reached from the same dashboard. That is also precisely why
   neither of them can see or write a bank account number. */

// GET /api/payouts/driver/:id — his earnings and the state of his payouts.
router.get('/driver/:id', wrap(req => payouts.statementFor(req.params.id)));

// PUT /api/payouts/driver/:id/method — MonCash / NatCash / Bank, and his
// wallet number. Refused with 409 while a payout of his is in flight.
router.put('/driver/:id/method', wrap(req => payouts.setMethod(req.params.id, req.body || {})));

/* ── ADMINISTRATOR ONLY ───────────────────────────────────────────────────
   Listed in middleware/adminOnly.js. The gate is mounted app-wide in
   server.js BEFORE the routers, so it cannot be missed by adding a route
   here later - but a route added here still has to be ADDED to that list. */

// GET /api/payouts/driver/:id/bank — the full account details. One route.
router.get('/driver/:id/bank', wrap(req => payouts.bankDetailsForAdmin(req.params.id)));

// PUT /api/payouts/driver/:id/bank — bank name, account holder, account number.
router.put('/driver/:id/bank', wrap(req => payouts.setBankDetailsAsAdmin(req.params.id, req.body || {})));

// GET /api/payouts?status=pending_approval — the payout run.
router.get('/', wrap(req => payouts.list(req.query || {})));

// POST /api/payouts/batch — gather everything owed to one recipient.
router.post('/batch', wrap(req => payouts.createBatch(req.body || {})));

// POST /api/payouts/:id/approve — the authorisation Jeffery asked to keep.
router.post('/:id/approve', wrap(req => payouts.approve(req.params.id)));

// POST /api/payouts/:id/paid — settle it with the reference from the bank or
// the wallet. This is the only place a payout becomes 'paid', and it refuses
// to do it twice.
router.post('/:id/paid', wrap(req => payouts.markPaid(req.params.id, req.body || {})));

// POST /api/payouts/:id/cancel — hand the entitlements back to the next run.
router.post('/:id/cancel', wrap(req => payouts.cancel(req.params.id, (req.body || {}).reason)));

module.exports = router;
