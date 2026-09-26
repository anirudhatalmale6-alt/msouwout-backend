/* ===========================================================================
   WHO IS OWED WHAT, FOR EVERY RIDE.

   Jeffery's priority, asked for four times: "Complete the earnings records for
   drivers, DASH and referral agents, reusing existing calculations. No live
   payouts until we approve the daily settlement process."

   The gap this closes, from the audit on 24 Sep: the money was already being
   worked out correctly on every ride and stored as COLUMNS ON THE RIDE, then
   added up with SUM() whenever a screen asked. Nothing anywhere said "this
   driver is owed this much for this ride, and it has not been paid." That
   sentence is what a payout run reads, what an argument with a driver is
   settled by, and what stops the same ride being paid twice.

   Three rules this file exists to keep:

   1. IT INVENTS NOTHING. Every amount is copied from a column the pricing
      service already wrote when the ride was created. If a number is wrong
      here it was wrong on the ride, and fixing it here would hide that.

   2. A RIDE EARNS ONCE. (ride_id, recipient_type) is UNIQUE, and every write
      is ON CONFLICT DO NOTHING. Calling this twice for the same ride - a retry,
      a double tap, a backfill running over rides already recorded - cannot
      create a second entitlement. In money code, idempotency is not an
      optimisation; it is the whole design.

   3. IT MOVES NO MONEY. Nothing here talks to a payment gateway. It writes
      rows with status 'pending' and stops. Approving and sending is a separate
      step that Jeffery has said must wait for his authorisation.
   =========================================================================== */

const pool = require('../db/pool');

/* Only a ride that is finished AND actually paid for creates an entitlement.
   A completed ride nobody paid for owes the driver nothing yet - and recording
   it as owed would put a debt on the platform for money it never received. */
/* 🚨 26 Sep - ALIAS-QUALIFIED, and it has to stay that way. This was written
   unqualified, and it is only ever used against RIDE_SELECT, which LEFT JOINs
   drivers - and drivers has a status column of its own. Postgres answered
   every call with `column reference "status" is ambiguous`, so recordForRide
   and backfill BOTH threw, silently: the boot backfill logs and moves on by
   design, and recordForRide is fired with .catch() on purpose so a ledger
   problem cannot fail a ride.

   The result was a ledger that had never recorded a single row in production
   while every test passed - because the stand-in database in the tests is not
   Postgres and has no opinion about ambiguity. What caught it was reading the
   service's own boot log after deploying, not the test suite. */
const ELIGIBLE = "r.status = 'completed' AND LOWER(COALESCE(r.payment_status,'')) = 'paid'";

/* What each party is owed on one ride, taken from the ride's own columns.
   The arithmetic mirrors the response /complete has always returned, so the
   ledger and the driver's screen cannot disagree. */
function splitFor(ride) {
  const driverGross = Number(ride.driver_earning) || 0;
  const driverDash = Number(ride.driver_dash_share) || 0;
  const rows = [
    { type: 'driver',
      amount: Math.round(driverGross - driverDash),          // 80% of the fare, less his DASH share
      recipient_id: ride.driver_id || null,
      phone: ride.driver_payout_phone || ride.driver_phone || null },
    { type: 'dash',
      amount: Math.round(Number(ride.dash_fee) || 0),         // the 20 HTG medical fund share
      recipient_id: null, phone: null },
    { type: 'msouwout',
      amount: Math.round((Number(ride.platform_fee) || 0) +
                         (Number(ride.msouwout_medical_fee) || 0)),
      recipient_id: null, phone: null }
  ];

  /* ⚠️ THE REFERRAL AGENT'S SHARE IS THE ONE NUMBER NOT ALREADY DECIDED.
     Every partner in the table is currently set to 0%, so nothing non-zero can
     be written today - which is the safe state to ship in.
     The base used here is MsouWout's own fee, because an agent commission
     normally comes out of the platform's cut rather than the driver's pocket.
     That is a business decision, not a technical one, so it is written down
     loudly and confirmed with Jeffery BEFORE any partner is given a rate. */
  const pct = Number(ride.referral_pct) || 0;
  if (pct > 0 && ride.referral_partner) {
    const base = (Number(ride.platform_fee) || 0);
    rows.push({ type: 'referral',
                amount: Math.round(base * pct / 100),
                recipient_id: ride.referral_partner,
                phone: ride.referral_phone || null });
  }
  return rows.filter(r => r.amount > 0);
}

const RIDE_SELECT = `
  SELECT r.id, r.tracking_code, r.driver_id, r.completed_at,
         r.driver_earning, r.driver_dash_share, r.dash_fee,
         r.platform_fee, r.msouwout_medical_fee,
         d.phone AS driver_phone, d.referral_partner,
         p.commission_pct AS referral_pct, p.contact_phone AS referral_phone
    FROM ride_requests r
    LEFT JOIN drivers d ON r.driver_id = d.id
    LEFT JOIN referral_partners p
           ON p.code = d.referral_partner AND p.is_active = true
`;

/* Record the entitlements for ONE ride. Safe to call as often as you like. */
async function recordForRide(rideId) {
  const q = await pool.query(`${RIDE_SELECT} WHERE r.id = $1 AND ${ELIGIBLE}`, [rideId]);
  if (!q.rows.length) return { recorded: 0, reason: 'not completed and paid' };
  const ride = q.rows[0];
  let recorded = 0;
  for (const row of splitFor(ride)) {
    const ins = await pool.query(
      `INSERT INTO ride_earnings
         (ride_id, tracking_code, recipient_type, recipient_id, recipient_phone,
          amount, currency, status, earned_at)
       VALUES ($1,$2,$3,$4,$5,$6,'HTG','pending',COALESCE($7, NOW()))
       ON CONFLICT (ride_id, recipient_type) DO NOTHING
       RETURNING id`,
      [ride.id, ride.tracking_code, row.type, row.recipient_id, row.phone,
       row.amount, ride.completed_at]);
    recorded += ins.rows.length;
  }
  return { recorded, ride: ride.tracking_code };
}

/* Every eligible ride that has no entitlements yet. Run at boot and on demand;
   the unique constraint means a second run is a no-op rather than a disaster. */
async function backfill(limit = 500) {
  const q = await pool.query(
    `${RIDE_SELECT} WHERE ${ELIGIBLE}
       AND NOT EXISTS (SELECT 1 FROM ride_earnings e WHERE e.ride_id = r.id)
     ORDER BY r.completed_at NULLS LAST LIMIT $1`, [limit]);
  let rides = 0, rows = 0;
  for (const ride of q.rows) {
    const out = await recordForRide(ride.id);
    if (out.recorded) { rides++; rows += out.recorded; }
  }
  return { rides, rows };
}

/* What is owed, grouped the way a daily payout run needs it. Reads only. */
async function owed({ since, until, recipient_type } = {}) {
  /* Qualified with e. for the same reason as ELIGIBLE: this list is reused by
     the byDriver query below, which joins drivers - and d.status would make
     a bare `status` ambiguous. The totals query is given the same alias so one
     WHERE can serve both. */
  const where = [`e.status = 'pending'`];
  const params = [];
  if (since) { params.push(since); where.push(`e.earned_at >= $${params.length}`); }
  if (until) { params.push(until); where.push(`e.earned_at <= $${params.length}`); }
  if (recipient_type) { params.push(recipient_type); where.push(`e.recipient_type = $${params.length}`); }

  const totals = await pool.query(
    `SELECT e.recipient_type, COUNT(*) AS rides, COALESCE(SUM(e.amount),0)::INT AS total
       FROM ride_earnings e WHERE ${where.join(' AND ')}
      GROUP BY e.recipient_type ORDER BY e.recipient_type`, params);

  /* One line per driver - that IS the payout run, in the order it would go out. */
  const byDriver = await pool.query(
    `SELECT e.recipient_id, e.recipient_phone, d.full_name,
            COUNT(*) AS rides, COALESCE(SUM(e.amount),0)::INT AS total
       FROM ride_earnings e LEFT JOIN drivers d ON d.id::text = e.recipient_id::text
      WHERE ${where.join(' AND ')} AND e.recipient_type = 'driver'
      GROUP BY e.recipient_id, e.recipient_phone, d.full_name
      ORDER BY total DESC`, params);

  return {
    totals: totals.rows,
    drivers: byDriver.rows,
    /* Said out loud on every response so nobody reads this as "paid". */
    note: 'These are amounts OWED and recorded. Nothing here has been paid.'
  };
}

module.exports = { recordForRide, backfill, owed, splitFor };
