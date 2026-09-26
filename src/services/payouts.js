/* ===========================================================================
   PAYING OUT WHAT THE LEDGER SAYS IS OWED.

   Jeffery, 26 Sep: "allow drivers to receive their earnings through their bank
   accounts as well as MonCash and NatCash... administrator-approved manual bank
   transfers. The administrator will make the transfer through our bank and
   enter the bank transaction reference to mark the payout as paid."

   This sits ON TOP of ride_earnings - the ledger built last week. It adds no
   second set of numbers and no second gateway, which is what he asked for:
   "reuse the existing earnings ledger and payout infrastructure."

   ── THE FOUR RULES HE WROTE DOWN, AND WHERE EACH ONE LIVES ─────────────────

   1. "Every payout has a unique reference and cannot be paid twice."
      driver_payouts.reference is UNIQUE in the database, and markPaid() only
      moves a payout that is still 'approved'. A second press finds it 'paid'
      and is refused with 409. The uniqueness is not enforced by this file -
      it is enforced by Postgres, which is the only place it cannot be
      forgotten. The same string is what the gateway's withdrawal API uses as
      its own duplicate key, so one reference protects both sides of the wire.

   2. "Drivers cannot change their payout information while a payment is being
      processed." A payout in 'pending_approval' or 'approved' locks the
      profile. Money already earmarked for account A must not land in account B
      because the number changed while it was in flight.

   3. "Bank account details are private and accessible only to authorized
      administrators." The account number is returned by exactly one function,
      bankDetailsForAdmin(), and the route that calls it is in the adminOnly
      list. Everything a driver can reach gets maskedDestination() instead.

   4. "Daily payouts still require administrator approval." createBatch() makes
      a payout in 'pending_approval'. Nothing here sends money - a bank payout
      is Jeffery at his bank, and a wallet payout still waits on the gateway
      credential Guy has not sent. This file records intent and settlement; it
      has no network code in it at all, deliberately.

   ── ⛔ WHY A DRIVER CANNOT TYPE HIS OWN ACCOUNT NUMBER ──────────────────────

   POST /api/drivers/login authenticates on a PHONE NUMBER ALONE. The driver
   app collects a PIN, sends it, and the server never looks at it - there is no
   pin column on drivers to compare it against. Anyone who knows a driver's
   number can open his account today.

   So self-service bank entry would not be a driver typing his account number.
   It would be anybody who knows his phone number typing THEIR account number
   over it, and the next approved payout going there. The method choice is
   self-service because the worst case is a payout to the wrong wallet the
   driver already listed; the account NUMBER is written by an administrator
   until that login verifies something. Told to Jeffery in writing, 26 Sep.
   =========================================================================== */

const pool = require('../db/pool');

const METHODS = ['moncash', 'natcash', 'bank'];
/* A payout in either of these states has money committed against it. */
const IN_FLIGHT = ['pending_approval', 'approved'];

/* Never the whole number, anywhere a driver or a screen can see it.
   Four digits is enough for a driver to recognise his own account and not
   enough for anybody to send money to it. */
function maskAccount(num) {
  const s = String(num || '').replace(/\s+/g, '');
  if (!s) return null;
  if (s.length <= 4) return '•'.repeat(s.length);
  return '•••• ' + s.slice(-4);
}

/* What the driver's money is set to go to, said in one line, safe to show. */
function describeDestination(d) {
  if (!d) return null;
  if (d.payout_method === 'bank') {
    if (!d.bank_account_number) return 'Bank account - not set up yet';
    return `${d.bank_name || 'Bank'} ${maskAccount(d.bank_account_number)}`;
  }
  const phone = d.payout_phone || d.phone || null;
  const label = d.payout_method === 'natcash' ? 'NatCash' : 'MonCash';
  return phone ? `${label} ${phone}` : `${label} - no number on file`;
}

/* ── RULE 2: is there money in flight for this recipient right now? ──────── */
async function lockedBy(recipientId) {
  const r = await pool.query(
    `SELECT id, reference, status, amount FROM driver_payouts
      WHERE recipient_id = $1 AND status = ANY($2::text[])
      ORDER BY created_at LIMIT 1`, [String(recipientId), IN_FLIGHT]);
  return r.rows[0] || null;
}

/* ── What a driver may change himself: WHICH method, and his wallet number ──
   Not the bank account number - see the header. */
async function setMethod(driverId, { payout_method, payout_phone }) {
  const method = String(payout_method || '').toLowerCase().trim();
  if (!METHODS.includes(method)) {
    return { error: `Choose one of: ${METHODS.join(', ')}`, code: 400 };
  }

  const held = await lockedBy(driverId);
  if (held) {
    return {
      error: 'A payment is being processed right now, so payout details are locked ' +
             'until it settles. This protects the money already on its way to you.',
      code: 409, locked_by: { reference: held.reference, status: held.status, amount: held.amount }
    };
  }

  const cur = await pool.query(
    `SELECT id, phone, payout_method, payout_phone, bank_name, bank_account_number
       FROM drivers WHERE id = $1`, [driverId]);
  if (!cur.rows.length) return { error: 'Driver not found', code: 404 };

  /* A wallet number is optional - blank means "use my login number", which is
     what every driver in the table has today. A bank account the driver cannot
     fill in himself, so choosing 'bank' before an administrator has entered one
     is allowed and simply shows as not set up yet; refusing it would leave him
     no way to ASK for a bank transfer. */
  let phone = payout_phone === undefined ? cur.rows[0].payout_phone
                                         : String(payout_phone || '').trim() || null;
  if (phone && !/^[0-9+][0-9\s\-()]{6,}$/.test(phone)) {
    return { error: 'That does not look like a phone number', code: 400 };
  }

  const r = await pool.query(
    `UPDATE drivers SET payout_method = $1, payout_phone = $2 WHERE id = $3
     RETURNING id, phone, payout_method, payout_phone, bank_name, bank_account_number`,
    [method, phone, driverId]);

  const d = r.rows[0];
  return {
    saved: true,
    payout_method: d.payout_method,
    payout_phone: d.payout_phone,
    destination: describeDestination(d),
    bank_on_file: !!d.bank_account_number,
    note: method === 'bank' && !d.bank_account_number
      ? 'Bank chosen. An administrator still has to enter your account details before a transfer can be made.'
      : null
  };
}

/* ── RULE 3: the account number, for an administrator only ────────────────
   One function returns it. One route calls that function. That route is in
   the adminOnly list. Keeping it to a single path is the only reason the
   claim "administrators only" can be checked rather than believed. */
async function bankDetailsForAdmin(driverId) {
  const r = await pool.query(
    `SELECT id, full_name, phone, payout_method, payout_phone,
            bank_name, bank_account_name, bank_account_number
       FROM drivers WHERE id = $1`, [driverId]);
  if (!r.rows.length) return { error: 'Driver not found', code: 404 };
  return { driver: r.rows[0], locked_by: await lockedBy(driverId) };
}

async function setBankDetailsAsAdmin(driverId, body = {}) {
  const held = await lockedBy(driverId);
  if (held) {
    return { error: 'A payout is in flight for this driver. Settle or cancel it first.',
             code: 409, locked_by: held };
  }
  const name = body.bank_name === undefined ? undefined : (String(body.bank_name || '').trim() || null);
  const holder = body.bank_account_name === undefined ? undefined : (String(body.bank_account_name || '').trim() || null);
  const acct = body.bank_account_number === undefined
    ? undefined : (String(body.bank_account_number || '').replace(/\s+/g, '') || null);

  if (acct && !/^[0-9A-Za-z-]{4,34}$/.test(acct)) {
    return { error: 'Account number looks wrong (4-34 letters, digits or dashes)', code: 400 };
  }

  const sets = [], params = [];
  if (name !== undefined) { params.push(name); sets.push(`bank_name = $${params.length}`); }
  if (holder !== undefined) { params.push(holder); sets.push(`bank_account_name = $${params.length}`); }
  if (acct !== undefined) { params.push(acct); sets.push(`bank_account_number = $${params.length}`); }
  if (!sets.length) return { error: 'Nothing to save', code: 400 };

  params.push(driverId);
  const r = await pool.query(
    `UPDATE drivers SET ${sets.join(', ')} WHERE id = $${params.length}
     RETURNING id, full_name, payout_method, payout_phone, bank_name,
               bank_account_name, bank_account_number`, params);
  if (!r.rows.length) return { error: 'Driver not found', code: 404 };
  const d = r.rows[0];
  return { saved: true, driver_id: d.id, bank_name: d.bank_name,
           bank_account_name: d.bank_account_name,
           bank_account_masked: maskAccount(d.bank_account_number),
           destination: describeDestination(d) };
}

/* ── RULE 1: the reference ────────────────────────────────────────────────
   Human-readable, because Jeffery will be typing it into a bank form and
   reading it back off a statement: MW-PO-20260926-A7F3. The uniqueness that
   matters is the UNIQUE constraint; this only has to be legible and unlikely
   to collide. A collision retries rather than overwriting anything. */
function makeReference(when) {
  const d = when || new Date();
  const day = d.toISOString().slice(0, 10).replace(/-/g, '');
  let tail = '';
  const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';  // no 0/O, no 1/I - it gets read aloud
  for (let i = 0; i < 4; i++) tail += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return `MW-PO-${day}-${tail}`;
}

/* Gather everything a recipient is owed and put it in one payout awaiting
   approval. The ledger rows are stamped with the payout id inside the SAME
   transaction, so a row cannot end up in two payouts: the WHERE clause only
   takes rows whose payout_id is still NULL, and the UPDATE is what claims
   them. If two runs happen at once, one claims the rows and the other finds
   none and makes nothing. */
async function createBatch({ recipient_type = 'driver', recipient_id, note = null } = {}) {
  if (!recipient_id) return { error: 'recipient_id is required', code: 400 };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const d = await client.query(
      `SELECT id, full_name, phone, payout_method, payout_phone,
              bank_name, bank_account_name, bank_account_number
         FROM drivers WHERE id = $1`, [recipient_id]);
    const driver = d.rows[0] || null;

    const held = await client.query(
      `SELECT reference, status FROM driver_payouts
        WHERE recipient_id = $1 AND status = ANY($2::text[]) LIMIT 1`,
      [String(recipient_id), IN_FLIGHT]);
    if (held.rows.length) {
      await client.query('ROLLBACK');
      return { error: `That driver already has payout ${held.rows[0].reference} ` +
                      `waiting (${held.rows[0].status}). Settle it before starting another.`,
               code: 409 };
    }

    /* Only rows that are owed, unpaid and not already in a payout. */
    const owed = await client.query(
      `SELECT id, amount FROM ride_earnings
        WHERE recipient_type = $1 AND recipient_id = $2
          AND status = 'pending' AND payout_id IS NULL
        FOR UPDATE`, [recipient_type, String(recipient_id)]);
    if (!owed.rows.length) {
      await client.query('ROLLBACK');
      return { error: 'Nothing is owed to that recipient right now.', code: 400 };
    }
    const total = owed.rows.reduce((a, r) => a + Number(r.amount || 0), 0);

    const method = (driver && driver.payout_method) || 'moncash';
    const destination = describeDestination(driver);

    /* Retry on the one-in-a-million reference collision. The UNIQUE index is
       what decides; this loop just tries again rather than failing the run. */
    let payout = null;
    for (let attempt = 0; attempt < 5 && !payout; attempt++) {
      try {
        const r = await client.query(
          `INSERT INTO driver_payouts
             (reference, recipient_type, recipient_id, recipient_name, method,
              destination, amount, status, note)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'pending_approval',$8)
           RETURNING *`,
          [makeReference(), recipient_type, String(recipient_id),
           driver ? driver.full_name : null, method, destination, total, note]);
        payout = r.rows[0];
      } catch (e) {
        if (e.code !== '23505') throw e;          // 23505 = unique_violation
        await client.query('ROLLBACK'); await client.query('BEGIN');
      }
    }
    if (!payout) { await client.query('ROLLBACK'); return { error: 'Could not allocate a reference', code: 500 }; }

    await client.query(
      `UPDATE ride_earnings SET payout_id = $1
        WHERE id = ANY($2::uuid[]) AND payout_id IS NULL`,
      [payout.id, owed.rows.map(r => r.id)]);

    await client.query('COMMIT');
    return {
      payout: { ...payout, bank_account_number: undefined },
      entitlements: owed.rows.length,
      note: 'Recorded and waiting for your approval. No money has moved.'
    };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw err;
  } finally {
    client.release();
  }
}

/* ── RULE 4: approval is a separate act from creating the run ────────────── */
async function approve(payoutId) {
  const r = await pool.query(
    `UPDATE driver_payouts SET status = 'approved', approved_at = NOW()
      WHERE id = $1 AND status = 'pending_approval' RETURNING *`, [payoutId]);
  if (!r.rows.length) {
    const cur = await pool.query(`SELECT reference, status FROM driver_payouts WHERE id = $1`, [payoutId]);
    if (!cur.rows.length) return { error: 'Payout not found', code: 404 };
    return { error: `That payout is already ${cur.rows[0].status}.`, code: 409, payout: cur.rows[0] };
  }
  return { approved: true, payout: r.rows[0],
           note: 'Approved. Make the transfer, then enter the reference from your bank or wallet to close it.' };
}

/* ── RULE 1 again, at the only moment it can be broken ────────────────────
   Settlement. The UPDATE carries `AND status = 'approved'` in its WHERE
   clause, so two people pressing at the same time cannot both succeed: the
   second one updates zero rows and is told the payout is already paid. This
   is the difference between checking a status and acting on it atomically. */
async function markPaid(payoutId, { bank_reference, note } = {}) {
  const ref = String(bank_reference || '').trim();
  if (!ref) {
    return { error: 'Enter the transaction reference from your bank or wallet. ' +
                    'It is the only proof this payout was made.', code: 400 };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    /* The same bank reference twice means one transfer being recorded against
       two payouts - the exact double-pay this is meant to stop. */
    const dupe = await client.query(
      `SELECT reference FROM driver_payouts
        WHERE bank_reference = $1 AND id <> $2 LIMIT 1`, [ref, payoutId]);
    if (dupe.rows.length) {
      await client.query('ROLLBACK');
      return { error: `That transaction reference is already on payout ${dupe.rows[0].reference}. ` +
                      'One transfer cannot settle two payouts.', code: 409 };
    }

    const r = await client.query(
      `UPDATE driver_payouts
          SET status = 'paid', bank_reference = $1, paid_at = NOW(),
              note = COALESCE($2, note)
        WHERE id = $3 AND status = 'approved'
        RETURNING *`, [ref, note || null, payoutId]);

    if (!r.rows.length) {
      await client.query('ROLLBACK');
      const cur = await pool.query(
        `SELECT reference, status, bank_reference, paid_at FROM driver_payouts WHERE id = $1`, [payoutId]);
      if (!cur.rows.length) return { error: 'Payout not found', code: 404 };
      if (cur.rows[0].status === 'paid') {
        return { error: `Already paid on ${cur.rows[0].paid_at}, reference ${cur.rows[0].bank_reference}. ` +
                        'Nothing was sent a second time.', code: 409, payout: cur.rows[0] };
      }
      return { error: `That payout is ${cur.rows[0].status} - approve it first.`, code: 409, payout: cur.rows[0] };
    }

    /* The ledger rows follow the payout, never the other way round. */
    const rows = await client.query(
      `UPDATE ride_earnings
          SET status = 'paid', payout_reference = $1, paid_at = NOW()
        WHERE payout_id = $2 AND status <> 'paid' RETURNING id`, [ref, payoutId]);

    await client.query('COMMIT');
    return { paid: true, payout: r.rows[0], entitlements_closed: rows.rows.length };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw err;
  } finally {
    client.release();
  }
}

/* Cancelling before settlement hands the entitlements back so they can go into
   the next run. It cannot touch a paid payout. */
async function cancel(payoutId, reason) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(
      `UPDATE driver_payouts SET status = 'cancelled', note = COALESCE($1, note)
        WHERE id = $2 AND status = ANY($3::text[]) RETURNING *`,
      [reason || null, payoutId, IN_FLIGHT]);
    if (!r.rows.length) {
      await client.query('ROLLBACK');
      const cur = await pool.query(`SELECT status FROM driver_payouts WHERE id = $1`, [payoutId]);
      if (!cur.rows.length) return { error: 'Payout not found', code: 404 };
      return { error: `A ${cur.rows[0].status} payout cannot be cancelled.`, code: 409 };
    }
    const back = await client.query(
      `UPDATE ride_earnings SET payout_id = NULL
        WHERE payout_id = $1 AND status <> 'paid' RETURNING id`, [payoutId]);
    await client.query('COMMIT');
    return { cancelled: true, payout: r.rows[0], entitlements_released: back.rows.length };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw err;
  } finally {
    client.release();
  }
}

/* The administrator's list. Carries the masked destination, never the number. */
async function list({ status, limit = 100 } = {}) {
  const params = [];
  let where = '';
  if (status) { params.push(status); where = `WHERE p.status = $${params.length}`; }
  params.push(Math.min(Number(limit) || 100, 500));
  const r = await pool.query(
    `SELECT p.id, p.reference, p.recipient_type, p.recipient_id, p.recipient_name,
            p.method, p.destination, p.amount, p.currency, p.status,
            p.bank_reference, p.note, p.approved_at, p.paid_at, p.created_at,
            (SELECT COUNT(*) FROM ride_earnings e WHERE e.payout_id = p.id)::INT AS entitlements
       FROM driver_payouts p ${where}
      ORDER BY p.created_at DESC LIMIT $${params.length}`, params);
  return { payouts: r.rows };
}

/* ── What a driver sees: his own money and where it is up to ──────────────
   "Drivers can see their earnings and payout status."
   ⛔ No account number. Not masked-and-also-present - absent. The SELECT below
   is the whole guarantee, so it must stay short enough to read in one glance. */
async function statementFor(driverId) {
  const d = await pool.query(
    `SELECT id, full_name, phone, payout_method, payout_phone,
            bank_name, bank_account_name, bank_account_number
       FROM drivers WHERE id = $1`, [driverId]);
  if (!d.rows.length) return { error: 'Driver not found', code: 404 };
  const driver = d.rows[0];

  const totals = await pool.query(
    `SELECT status, COUNT(*)::INT AS rides, COALESCE(SUM(amount),0)::INT AS total
       FROM ride_earnings WHERE recipient_type = 'driver' AND recipient_id = $1
      GROUP BY status`, [String(driverId)]);

  const recent = await pool.query(
    `SELECT tracking_code, amount, status, payout_reference, earned_at, paid_at
       FROM ride_earnings WHERE recipient_type = 'driver' AND recipient_id = $1
      ORDER BY earned_at DESC LIMIT 30`, [String(driverId)]);

  const payouts = await pool.query(
    `SELECT reference, method, amount, status, bank_reference,
            approved_at, paid_at, created_at
       FROM driver_payouts WHERE recipient_id = $1
      ORDER BY created_at DESC LIMIT 20`, [String(driverId)]);

  const by = Object.fromEntries(totals.rows.map(r => [r.status, r.total]));
  const held = payouts.rows.find(p => IN_FLIGHT.includes(p.status)) || null;

  return {
    driver_id: driver.id,
    payout_method: driver.payout_method || 'moncash',
    /* Masked, so he can tell his own account apart without the number being
       readable by whoever else opened his app. */
    destination: describeDestination(driver),
    bank_on_file: !!driver.bank_account_number,
    bank_name: driver.bank_name || null,
    bank_account_name: driver.bank_account_name || null,
    bank_account_masked: maskAccount(driver.bank_account_number),
    can_edit: !held,
    locked_by: held ? { reference: held.reference, status: held.status } : null,
    owed: by.pending || 0,
    in_payout: by.approved || 0,
    paid: by.paid || 0,
    rides: recent.rows,
    payouts: payouts.rows,
    note: 'Amounts marked owed have been recorded but not sent. A payout is only ' +
          'money in your hands once it shows paid with a reference.'
  };
}

module.exports = {
  METHODS, IN_FLIGHT, maskAccount, describeDestination, makeReference,
  lockedBy, setMethod, bankDetailsForAdmin, setBankDetailsAsAdmin,
  createBatch, approve, markPaid, cancel, list, statementFor
};
