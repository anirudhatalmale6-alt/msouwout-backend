/* ═══ CARDS, FOR THE WHOLE PLATFORM ════════════════════════════════════════
 *
 * ⚠️ THE SAME FILE AS haitibiznis-backend/utils/stripe.js, byte for byte apart
 * from this note. Copied rather than imported because the two services are
 * separate deployments with separate node_modules; a shared package for one
 * 140-line file that calls fetch three times would cost more than it saves.
 * 🔑 IF YOU CHANGE ONE, CHANGE THE OTHER. The money conversion in
 * toMinorUnit() is the part that must never drift.
 */
/* ───────────────────────────────────────────────────────────────────────────
 *
 * Jeffery, 4 Oct 2026: "What we need is to make the Stripe card flow a real
 * integrated payment, not just a payment link. When the customer pays
 * successfully through Stripe, the server must confirm the payment, mark the
 * ticket/order/ride as PAID, record the Stripe transaction/reference and
 * amount, and then continue the normal confirmation/receipt flow
 * automatically... MonCash + NatCash = SolutionIP. Credit/Debit Cards =
 * Stripe. Please keep those two payment flows separate."
 *
 * What existed before this file: three hosted payment LINKS. One of them
 * charged a flat $1.00 for any basket on MyPlopPlop and was reconciled against
 * SolutionIP, which had never seen it. Nothing anywhere recorded a Stripe
 * payment. This is the first real integration.
 *
 * 🔑 NO WEBHOOK, ON PURPOSE. The server ASKS Stripe whether a session was
 * paid, the same way utils/ticketSweep.js already asks SolutionIP every three
 * minutes. One less secret to hold, and it still settles when a buyer closes
 * the browser on the way back - which on a Haitian phone is the normal case,
 * not the edge case.
 *
 * ⛔ The key is a RESTRICTED key. It can create a Checkout Session and read a
 * payment back. It cannot read the balance, list customers, list charges or
 * create a payout. See STRIPE_RESTRICTED_KEY on the service.
 * ═══════════════════════════════════════════════════════════════════════════ */

const KEY = () => process.env.STRIPE_RESTRICTED_KEY || '';
const API = 'https://api.stripe.com/v1';

function configured() { return !!KEY(); }

/* Stripe takes form-encoded bodies, and nested keys use a[b] notation. */
function form(obj, prefix, out) {
  out = out || [];
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object' && !Array.isArray(v)) form(v, key, out);
    else if (Array.isArray(v)) v.forEach((item, i) => {
      if (typeof item === 'object') form(item, `${key}[${i}]`, out);
      else out.push(`${key}[${i}]=${encodeURIComponent(item)}`);
    });
    else out.push(`${key}=${encodeURIComponent(v)}`);
  }
  return out;
}

async function call(path, method, body) {
  if (!configured()) return { ok: false, error: 'Stripe is not configured' };
  const opts = {
    method,
    headers: {
      Authorization: 'Basic ' + Buffer.from(KEY() + ':').toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded'
    }
  };
  if (body) opts.body = form(body).join('&');
  let r, data;
  try {
    r = await fetch(API + path, opts);
    data = await r.json();
  } catch (e) {
    /* Unreachable is NOT "not paid". The caller must leave the order pending
       and ask again rather than deciding anything. */
    return { ok: false, unreachable: true, error: e.message };
  }
  if (data && data.error) return { ok: false, error: data.error.message, raw: data };
  return { ok: true, data };
}

/* ─── create ──────────────────────────────────────────────────────────────
   amount is in the CURRENCY'S SMALLEST UNIT. HTG has two decimal places, so
   1,075 HTG is 107500. Getting this wrong by a factor of 100 is the classic
   way to charge somebody a hundred times too much, so the conversion lives
   here and nowhere else.                                                    */
const ZERO_DECIMAL = ['bif','clp','djf','gnf','jpy','kmf','krw','mga','pyg',
                      'rwf','ugx','vnd','vuv','xaf','xof','xpf'];

function toMinorUnit(amount, currency) {
  const c = String(currency || 'htg').toLowerCase();
  return ZERO_DECIMAL.includes(c) ? Math.round(amount) : Math.round(amount * 100);
}

async function createCheckout({ amount, currency, label, reference, successUrl,
                                cancelUrl, email, metadata }) {
  const cur = String(currency || 'HTG').toLowerCase();
  const body = {
    mode: 'payment',
    /* Our own reference travels with the payment, so when we ask Stripe about
       it later we know which ticket, order or ride it belongs to. */
    client_reference_id: reference,
    success_url: successUrl,
    cancel_url: cancelUrl || successUrl,
    line_items: [{
      quantity: 1,
      price_data: {
        currency: cur,
        unit_amount: toMinorUnit(amount, cur),
        product_data: { name: String(label || 'Payment').slice(0, 120) }
      }
    }],
    metadata: Object.assign({ reference: String(reference) }, metadata || {})
  };
  if (email) body.customer_email = email;

  const out = await call('/checkout/sessions', 'POST', body);
  if (!out.ok) return out;
  return { ok: true, id: out.data.id, url: out.data.url, raw: out.data };
}

/* ─── confirm ─────────────────────────────────────────────────────────────
   The ONLY thing that may mark something paid. Returns paid:true solely when
   Stripe itself says the session is paid AND the amount matches what we asked
   for - a session can be completed for a different amount if anybody ever
   edits the flow, and silently accepting that would be how a 1,075 HTG ticket
   gets settled for 1 HTG.                                                    */
async function confirmCheckout(sessionId, expectedAmount, currency) {
  const out = await call('/checkout/sessions/' + encodeURIComponent(sessionId), 'GET');
  if (!out.ok) return out;
  const s = out.data;
  const paid = s.payment_status === 'paid';
  const expected = expectedAmount == null
    ? null : toMinorUnit(expectedAmount, currency || s.currency);
  const amountOk = expected == null || Number(s.amount_total) === expected;

  return {
    ok: true,
    paid: paid && amountOk,
    stripe_paid: paid,
    amount_matches: amountOk,
    amount_total: s.amount_total,
    currency: s.currency,
    reference: s.client_reference_id,
    payment_intent: typeof s.payment_intent === 'string'
      ? s.payment_intent : (s.payment_intent && s.payment_intent.id) || null,
    status: s.status,
    raw: s
  };
}

module.exports = { configured, createCheckout, confirmCheckout, toMinorUnit };
