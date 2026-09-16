/* Payment endpoints.
 *
 * These existed before and were switched on, but no screen in either app ever
 * called them, and they recorded nothing — so even a successful payment left
 * the ride marked unpaid. They now go through src/services/payments.js, which
 * owns the provider list, the record, and the polling.
 *
 * The contract the apps use:
 *   POST /api/payments/create   start one, get a payment_url to send the payer to
 *   GET  /api/payments/:ref     where has it got to (safe to poll)
 *   POST /api/payments/verify   ask the provider RIGHT NOW (used on return)
 *   GET  /api/payments/methods  what can be offered
 *   GET  /api/payments/ride/:id every payment attempt against one ride
 */

const { Router } = require('express');
const pay = require('../services/payments');
const pool = require('../db/pool');

const router = Router();

/* What the caller is allowed to see. The provider's raw answer and the polling
   bookkeeping stay server-side — the app only needs to know where to send the
   payer and whether the money arrived. */
function publicView(p) {
  if (!p) return null;
  return {
    reference_id: p.reference_id,
    status: p.status,
    paid: p.status === 'paid',
    amount: p.amount,
    currency: p.currency,
    method: p.method,
    provider: p.provider,
    payment_url: p.payment_url,
    subject_type: p.subject_type,
    subject_id: p.subject_id,
    paid_at: p.paid_at,
    created_at: p.created_at
  };
}

/* Must stay ABOVE '/:reference_id' or Express reads "methods" as a reference —
   the same trap that /available hit on the rides router. */
router.get('/methods', (req, res) => {
  res.json({ methods: pay.availableMethods(), minimum_htg: pay.MIN_HTG });
});

router.post('/create', async (req, res) => {
  try {
    const { subject_type, subject_id, ride_id, amount, payment_method, method,
            payer_phone, currency } = req.body || {};

    const chosen = method || payment_method;
    const subject = subject_type || (ride_id ? 'ride' : 'ride');
    const subjectId = subject_id || ride_id || null;

    if (!amount || !chosen) {
      return res.status(400).json({ error: 'amount and payment_method are required' });
    }

    /* Charge what the ride actually costs, not what the caller says it costs.
       This is the MyPlopPlop card bug in miniature: there, the basket total is
       worked out in the browser and then never reaches the provider at all. */
    let amountToCharge = amount;
    if (subject === 'ride' && subjectId) {
      const r = await pool.query(
        `SELECT price, medical_fee, total_with_protection, payment_status
           FROM ride_requests WHERE id = $1`, [subjectId]);
      if (!r.rows.length) return res.status(404).json({ error: 'Ride not found' });
      const ride = r.rows[0];
      if (ride.payment_status === 'paid') {
        return res.status(409).json({ error: 'This ride is already paid' });
      }
      amountToCharge = ride.total_with_protection > 0
        ? ride.total_with_protection
        : ride.price;
    }

    const out = await pay.startPayment({
      subject_type: subject, subject_id: subjectId,
      amount: amountToCharge, method: chosen, payer_phone, currency
    });

    if (!out.ok) {
      const code = out.code === 'provider_unreachable' ? 503 : 400;
      return res.status(code).json({ success: false, error: out.error, code: out.code });
    }

    const p = out.payment;
    if (subject === 'ride' && subjectId) {
      await pool.query(
        `UPDATE ride_requests SET payment_status='pending', payment_id=$2,
                payment_method=$3, updated_at=NOW() WHERE id=$1`,
        [subjectId, p.id, p.method]);
    }

    res.json({ success: true, ...publicView(p) });
  } catch (err) {
    console.error('Payment create error:', err);
    res.status(500).json({ error: 'Payment service unavailable' });
  }
});

router.post('/verify', async (req, res) => {
  try {
    const { reference_id } = req.body || {};
    if (!reference_id) return res.status(400).json({ error: 'reference_id is required' });

    const p = await pay.getPayment({ reference_id });
    if (!p) return res.status(404).json({ error: 'Unknown payment' });

    /* Already settled: answer from the record rather than asking again. */
    if (p.status === 'paid') return res.json({ success: true, ...publicView(p) });

    const out = await pay.checkPayment(p);
    if (!out.ok) return res.status(503).json({ success: false, error: out.error });
    res.json({ success: true, ...publicView(out.payment) });
  } catch (err) {
    console.error('Payment verify error:', err);
    res.status(500).json({ error: 'Payment service unavailable' });
  }
});

router.get('/ride/:rideId', async (req, res) => {
  try {
    const rows = await pay.paymentsForSubject('ride', req.params.rideId);
    res.json({ payments: rows.map(publicView) });
  } catch (err) {
    /* A non-uuid id must read as "nothing here", not as a server error — the
       same treatment the rides router already gives a bad driver id. */
    res.json({ payments: [] });
  }
});

router.get('/:reference_id', async (req, res) => {
  try {
    const p = await pay.getPayment({ reference_id: req.params.reference_id });
    if (!p) return res.status(404).json({ error: 'Unknown payment' });
    res.json(publicView(p));
  } catch (err) {
    console.error('Payment lookup error:', err);
    res.status(500).json({ error: 'Payment service unavailable' });
  }
});

module.exports = router;
