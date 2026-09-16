/* ===========================================================================
   The payment service.

   Jeffery, 16 Sep 2026: "I want the payment flow to be designed as part of the
   HaitiBiznis ecosystem, not as a standalone solution for MsouWout."

   So nothing below knows what a ride is. A payment is taken against a SUBJECT
   — a ride today, an order or a ticket tomorrow — and providers are registered
   in one place. Adding Stripe means adding one object to PROVIDERS; it means
   changing nothing else and no database migration.

   Two facts about the gateway shape the whole design, and both were checked
   against the live code rather than assumed:

   1. There is NO webhook. SolutionIP never calls us back. The only way to learn
      a payment succeeded is to ask it. So the server polls, and a passenger who
      closes the app mid-payment still ends up with a ride marked paid.

   2. The browser is never believed. MyPlopPlop's card checkout is a warning:
      it redirects to a fixed Stripe link and then asks a DIFFERENT provider
      whether the money arrived, so a card order there can never be confirmed.
      Here, only a provider's own answer can set a payment to 'paid'.
   =========================================================================== */

const pool = require('../db/pool');

const SOLUTIONIP_URL = process.env.SOLUTIONIP_URL || 'https://plopplop.solutionip.app';
const CLIENT_ID = process.env.SOLUTIONIP_CLIENT_ID || 'pp_1ohu5zz2tcx';

/* The gateway refuses anything under 20 HTG. Worth knowing as a real number:
   it is what makes a genuine end-to-end test cost about 20 gourdes a run
   instead of the price of a ride. */
const MIN_HTG = 20;

/* How long to keep asking about a payment nobody finished. Roughly 30 minutes
   at the poll interval below, after which it becomes 'expired' — not 'failed',
   because we genuinely do not know. */
const MAX_ATTEMPTS = 60;
const POLL_EVERY_MS = 30 * 1000;

/* --- providers -----------------------------------------------------------
   Each provider implements create() and verify(). Keep them dumb: they talk to
   their gateway and normalise the answer. They do not touch the database.

   Stripe is deliberately NOT stubbed here. A provider that exists but cannot
   take money would surface as a payment option that silently fails — the same
   trap as a "coming soon" card left in front of a live feature. It gets added
   the day the account and keys are real, and not before.
   ------------------------------------------------------------------------- */
const PROVIDERS = {
  solutionip: {
    name: 'solutionip',
    /* Named as the gateway names them. 'all' lets the payer choose on the
       gateway's own page. No card entry here: the live route accepts only
       moncash, natcash, kashpaw and all — cards are an open question with
       SolutionIP, and inventing one would be inventing a capability. */
    methods: ['moncash', 'natcash', 'kashpaw', 'all'],

    async create({ reference_id, amount, method }) {
      const r = await fetch(`${SOLUTIONIP_URL}/api/paiement-marchand`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: CLIENT_ID,
          refference_id: reference_id,   // their spelling, not a typo of ours
          montant: amount,
          payment_method: method
        })
      });
      const data = await r.json();
      if (data.status !== true) {
        return { ok: false, error: data.message || 'Payment creation refused', raw: data };
      }
      return {
        ok: true,
        payment_url: data.url,
        provider_ref: data.transaction_id || null,
        raw: data
      };
    },

    async verify({ reference_id }) {
      const r = await fetch(`${SOLUTIONIP_URL}/api/paiement-verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: CLIENT_ID, refference_id: reference_id })
      });
      const data = await r.json();
      if (data.status !== true) {
        /* Not the same as "not paid". The gateway could not answer, so we keep
           the payment pending and ask again rather than calling it failed. */
        return { ok: false, error: data.message || 'Verification refused', raw: data };
      }
      return {
        ok: true,
        paid: data.trans_status === 'ok',
        provider_ref: data.id_transaction || null,
        amount: data.montant,
        method: data.method,
        raw: data
      };
    }
  }
};

function getProvider(name) {
  return PROVIDERS[name] || null;
}

/* --- which providers are switched on -------------------------------------
   Stored in service_config('payment_providers'), not in this file, so a
   provider or a single method can be turned off from an admin screen without
   a code change or a redeploy. Shape:

     { "solutionip": { "enabled": true,
                       "methods": { "moncash": true, "natcash": false, ... } } }

   Cached briefly: this is read on every payment, but switching MonCash off
   during an outage should take effect in seconds, not on the next restart.
   ------------------------------------------------------------------------- */
let cfgCache = null, cfgAt = 0;
const CFG_TTL_MS = 30 * 1000;

async function providerConfig({ fresh } = {}) {
  if (!fresh && cfgCache && (Date.now() - cfgAt) < CFG_TTL_MS) return cfgCache;
  try {
    const q = await pool.query(
      `SELECT value FROM service_config WHERE key = 'payment_providers'`);
    cfgCache = (q.rows[0] && q.rows[0].value) || {};
  } catch (err) {
    /* If the config cannot be read, fall back to "everything registered is on"
       rather than refusing all payments because of a settings lookup. */
    console.error('payment provider config unreadable:', err.message);
    cfgCache = {};
  }
  cfgAt = Date.now();
  return cfgCache;
}

function invalidateProviderConfig() { cfgCache = null; cfgAt = 0; }

function isEnabled(cfg, providerName, method) {
  const c = cfg[providerName];
  if (c === undefined) return true;          // registered but never configured
  if (c.enabled === false) return false;
  if (c.methods && c.methods[method] === false) return false;
  return true;
}

/* Which methods a caller may offer. Asked of the providers AND the config, so
   the apps show exactly what is currently switched on. */
async function availableMethods() {
  const cfg = await providerConfig();
  return Object.values(PROVIDERS).flatMap(p =>
    p.methods
      .filter(m => isEnabled(cfg, p.name, m))
      .map(m => ({ provider: p.name, method: m })));
}

/* Every method this build knows about, on or off. For the admin screen, which
   has to be able to show you a switch for something currently switched off. */
function allMethods() {
  return Object.values(PROVIDERS).flatMap(p =>
    p.methods.map(m => ({ provider: p.name, method: m })));
}

async function providerForMethod(method) {
  const cfg = await providerConfig();
  return Object.values(PROVIDERS).find(
    p => p.methods.includes(method) && isEnabled(cfg, p.name, method)) || null;
}

async function setProviderConfig(next) {
  await pool.query(
    `INSERT INTO service_config (key, value, updated_at)
     VALUES ('payment_providers', $1::jsonb, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $1::jsonb, updated_at = NOW()`,
    [JSON.stringify(next)]);
  invalidateProviderConfig();
  return providerConfig({ fresh: true });
}

/* A reference the gateway will accept and we can find again.
 *
 * The first version of this reused the ride tracking-code shape — a base-36
 * millisecond plus four random characters — and a test generating 3000 of them
 * in one loop produced a duplicate, exactly as the load test did for tracking
 * codes. Inside a single millisecond the timestamp contributes nothing, so all
 * the protection came from those four characters: about 1.7 million
 * combinations, which the birthday bound makes a coin flip well before 3000.
 *
 * reference_id is UNIQUE, so a collision is not a cosmetic problem: the insert
 * throws and the passenger cannot pay. Hence crypto randomness, ten characters
 * of it, AND the retry in startPayment — belt and braces, because this one has
 * already bitten once on this project. */
const crypto = require('crypto');
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';  // no I, L, O, U — read aloud over the phone

function newReference(prefix) {
  const bytes = crypto.randomBytes(10);
  let out = '';
  for (let i = 0; i < 10; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return `${prefix || 'MW'}-${out}`;
}

/* --- the operations the rest of the app uses ----------------------------- */

/**
 * Start a payment. Records it BEFORE sending the payer anywhere, so a payment
 * that succeeds while the app is closed is still something we know to ask about.
 */
async function startPayment({ subject_type, subject_id, amount, method, payer_phone,
                              currency, platform, user_id, metadata }) {
  const cur = (currency || 'HTG').toUpperCase();
  const amt = Math.ceil(Number(amount));

  if (!Number.isFinite(amt) || amt <= 0) {
    return { ok: false, code: 'bad_amount', error: 'A positive amount is required' };
  }
  if (cur === 'HTG' && amt < MIN_HTG) {
    return { ok: false, code: 'below_minimum',
             error: `The gateway will not take less than ${MIN_HTG} HTG` };
  }
  const provider = await providerForMethod(method);
  if (!provider) {
    const on = (await availableMethods()).map(m => m.method);
    const known = allMethods().some(m => m.method === method);
    return known
      ? { ok: false, code: 'method_disabled',
          error: `${method} is switched off. Available: ${on.join(', ') || 'none'}` }
      : { ok: false, code: 'bad_method',
          error: `Unknown payment method. Available: ${on.join(', ') || 'none'}` };
  }

  /* Tapping Pay twice must not start two payments.
   *
   * Without this, a passenger on a slow connection who taps again gets a
   * SECOND gateway transaction for the same ride - two payment pages, and a
   * real chance of paying twice. If there is already a live attempt for the
   * same subject at the same amount and method, hand back that one.
   *
   * Deliberately NOT keyed on time: a payment page opened four minutes ago is
   * still the page the passenger is looking at. It is keyed on the attempt
   * still being pending, which is exactly what "not finished yet" means. */
  if (subject_id) {
    const live = await pool.query(
      `SELECT * FROM payments
        WHERE subject_type = $1 AND subject_id = $2
          AND status = 'pending' AND amount = $3 AND method = $4
          AND payment_url IS NOT NULL
        ORDER BY created_at DESC LIMIT 1`,
      [subject_type || 'ride', String(subject_id), amt, method]);
    if (live.rows.length) {
      return { ok: true, payment: live.rows[0], reused: true };
    }
  }

  /* reference_id is UNIQUE. Even with crypto randomness, the right response to
     a collision is to take another reference rather than to fail the payment —
     23505 is Postgres's unique-violation code. */
  let payment = null, reference_id = null;
  for (let attempt = 0; attempt < 5 && !payment; attempt++) {
    reference_id = newReference('MW');
    try {
      const ins = await pool.query(
        `INSERT INTO payments (provider, reference_id, subject_type, subject_id,
                               amount, currency, method, status, payer_phone,
                               platform, user_id, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8,$9,$10,$11::jsonb)
         RETURNING *`,
        [provider.name, reference_id, subject_type || 'ride',
         subject_id ? String(subject_id) : null,
         amt, cur, method, payer_phone || null,
         platform || 'msouwout', user_id || null,
         JSON.stringify(metadata || {})]
      );
      payment = ins.rows[0];
    } catch (err) {
      if (err && err.code === '23505') continue;
      throw err;
    }
  }
  if (!payment) {
    return { ok: false, code: 'reference_collision',
             error: 'Could not allocate a payment reference' };
  }

  let created;
  try {
    created = await provider.create({ reference_id, amount: amt, method });
  } catch (err) {
    await pool.query(
      `UPDATE payments SET status='failed', last_response=$2, updated_at=NOW() WHERE id=$1`,
      [payment.id, JSON.stringify({ error: String(err && err.message || err) })]
    );
    return { ok: false, code: 'provider_unreachable', error: 'Payment service unavailable' };
  }

  if (!created.ok) {
    await pool.query(
      `UPDATE payments SET status='failed', last_response=$2, updated_at=NOW() WHERE id=$1`,
      [payment.id, JSON.stringify(created.raw || {})]
    );
    return { ok: false, code: 'provider_refused', error: created.error };
  }

  const upd = await pool.query(
    `UPDATE payments
        SET payment_url=$2, provider_ref=$3, last_response=$4, updated_at=NOW()
      WHERE id=$1 RETURNING *`,
    [payment.id, created.payment_url, created.provider_ref,
     JSON.stringify(created.raw || {})]
  );

  return { ok: true, payment: upd.rows[0] };
}

/**
 * Ask the provider about one payment and record the answer.
 * This is the ONLY function that may set a payment to 'paid'.
 */
async function checkPayment(payment) {
  const provider = getProvider(payment.provider);
  if (!provider) return { ok: false, error: `No provider named ${payment.provider}` };

  let res;
  try {
    res = await provider.verify({ reference_id: payment.reference_id });
  } catch (err) {
    res = { ok: false, error: String(err && err.message || err), raw: {} };
  }

  const attempts = payment.attempts + 1;

  /* Could not get an answer: count the attempt, keep it pending, try later.
     Only give up once, and say 'expired' rather than 'failed' — we do not
     actually know that the passenger did not pay. */
  if (!res.ok) {
    const status = attempts >= MAX_ATTEMPTS ? 'expired' : 'pending';
    const out = await pool.query(
      `UPDATE payments SET attempts=$2, last_checked_at=NOW(), status=$3,
              last_response=$4, updated_at=NOW()
         WHERE id=$1 RETURNING *`,
      [payment.id, attempts, status, JSON.stringify(res.raw || { error: res.error })]
    );
    return { ok: true, payment: out.rows[0], changed: status !== payment.status };
  }

  if (res.paid) {
    const out = await pool.query(
      `UPDATE payments SET status='paid', paid_at=COALESCE(paid_at, NOW()),
              provider_ref=COALESCE($3, provider_ref), attempts=$2,
              last_checked_at=NOW(), last_response=$4, updated_at=NOW()
         WHERE id=$1 RETURNING *`,
      [payment.id, attempts, res.provider_ref, JSON.stringify(res.raw || {})]
    );
    const paid = out.rows[0];
    await applyToSubject(paid);
    return { ok: true, payment: paid, changed: payment.status !== 'paid' };
  }

  const status = attempts >= MAX_ATTEMPTS ? 'expired' : 'pending';
  const out = await pool.query(
    `UPDATE payments SET attempts=$2, last_checked_at=NOW(), status=$3,
            last_response=$4, updated_at=NOW()
       WHERE id=$1 RETURNING *`,
    [payment.id, attempts, status, JSON.stringify(res.raw || {})]
  );
  return { ok: true, payment: out.rows[0], changed: status !== payment.status };
}

/**
 * Tell whatever was being paid for that it has been paid.
 *
 * Kept separate from checkPayment so that the day a ticket or a shop order is
 * paid through this same service, only this function grows a branch — and so
 * that Stage 2 has exactly one place to also write the central ledger entry.
 */
async function applyToSubject(payment) {
  if (payment.status !== 'paid' || !payment.subject_id) return;

  if (payment.subject_type === 'ride') {
    await pool.query(
      `UPDATE ride_requests
          SET payment_status='paid', payment_id=$2,
              payment_method=$3, updated_at=NOW()
        WHERE id=$1`,
      [payment.subject_id, payment.id, payment.method]
    );
  }
  /* Stage 2: mirror into the HaitiBiznis Transaction ledger here, with
     subject_type/subject_id as the reference back. One place, not many. */
}

/** Find a payment by our reference or by what it was paid for. */
async function getPayment({ reference_id, id }) {
  const q = reference_id
    ? await pool.query('SELECT * FROM payments WHERE reference_id=$1', [reference_id])
    : await pool.query('SELECT * FROM payments WHERE id=$1', [id]);
  return q.rows[0] || null;
}

async function paymentsForSubject(subject_type, subject_id) {
  const q = await pool.query(
    `SELECT * FROM payments WHERE subject_type=$1 AND subject_id=$2
      ORDER BY created_at DESC`, [subject_type, String(subject_id)]);
  return q.rows;
}

/**
 * The poller. Started once by the server.
 *
 * Without this, the whole thing depends on the passenger returning to the app
 * with the page still open — which, on a Haitian phone on mobile data, is the
 * case we should expect to fail rather than the one we should design for.
 */
let timer = null;
function startPoller({ everyMs } = {}) {
  if (timer) return timer;
  const interval = everyMs || POLL_EVERY_MS;

  timer = setInterval(async () => {
    try {
      const due = await pool.query(
        `SELECT * FROM payments
          WHERE status='pending' AND attempts < $1
          ORDER BY last_checked_at NULLS FIRST
          LIMIT 20`, [MAX_ATTEMPTS]);
      for (const p of due.rows) {
        try { await checkPayment(p); }
        catch (err) { console.error('payment poll failed', p.reference_id, err.message); }
      }
    } catch (err) {
      /* Never let a polling failure take the server down. */
      console.error('payment poller error:', err.message);
    }
  }, interval);

  if (timer.unref) timer.unref();
  return timer;
}

function stopPoller() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = {
  startPayment, checkPayment, getPayment, paymentsForSubject,
  availableMethods, allMethods, providerForMethod, newReference,
  providerConfig, setProviderConfig, invalidateProviderConfig,
  startPoller, stopPoller,
  MIN_HTG, MAX_ATTEMPTS, PROVIDERS
};
