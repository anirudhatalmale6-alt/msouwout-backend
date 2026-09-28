/* ===========================================================================
   WHETHER A RIDE CAN ACTUALLY BE SERVED, AND WHAT TO DO WHEN IT CANNOT.

   Written because of one real customer. Wilkendy Guerrier found MsouWout on
   his own on 27 September, booked Hinche to Thomonde, and waited five hours
   for a car that was never coming. Three things went wrong at once:

     1. There were two approved drivers in the country and both were ~120 km
        away. Nothing checked.
     2. Nothing notifies a driver. He only sees a ride if he happens to have
        the page open at that moment.
     3. GET /available only ever showed rides from the last 120 minutes, so at
        19:54 his booking became invisible to every driver - while staying
        'searching' in the database for ever. Open, and unreachable.

   Jeffery, 28 Sep: "A ride must NEVER silently disappear from the driver list
   after 2 hours while remaining open forever in the database."

   ⛔ NOTHING HERE DELETES ANYTHING. An unservable ride becomes 'expired' with
   a reason and a timestamp. The row, the addresses, the price and the
   passenger stay exactly where they are, because the whole point of knowing
   Wilkendy existed is being able to count people like him.
   =========================================================================== */

const pool = require('./../db/pool');

/* How far away a driver can be and still plausibly come. Haiti is long and
   thin and the roads are slow; 25 km is generous within Port-au-Prince and
   correctly refuses Port-au-Prince to Hinche. Deliberately ONE number rather
   than a per-town table: a wrong table is worse than a blunt radius. */
const COVERAGE_KM = 25;
/* A position from yesterday does not tell us where he is now. */
const POSITION_FRESH_MIN = 60;

/* When to speak up, and when to stop pretending. Both are small and both are
   here rather than scattered through the routes. */
const NUDGE_AFTER_MIN = 10;      // "nobody yet - keep waiting, or message us?"
const EXPIRE_AFTER_MIN = 60;     // if she never answers, stop claiming a car is coming
const KEEP_WAITING_MIN = 30;     // she pressed keep waiting: give it this long again

/* Is there an approved, active driver within reach of this pickup?
   Returns {covered, nearest_km, drivers_online}. A ride with no coordinates
   cannot be judged, so it is treated as covered - refusing an order because we
   could not geocode her street would be worse than the wait. */
async function coverage(lat, lng, rideType) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return { covered: true, nearest_km: null, drivers_online: null, unknown: true };
  }
  const q = await pool.query(
    `SELECT
        COUNT(*) FILTER (WHERE status='approved' AND is_verified AND is_active)::int AS approved,
        COUNT(*) FILTER (WHERE status='approved' AND is_verified AND is_active
                           AND current_lat IS NOT NULL AND current_lng IS NOT NULL
                           AND last_location_update > NOW() - make_interval(mins => $3))::int AS locatable,
        MIN(CASE WHEN status='approved' AND is_verified AND is_active
                  AND current_lat IS NOT NULL AND current_lng IS NOT NULL
                  AND last_location_update > NOW() - make_interval(mins => $3)
            THEN 6371 * 2 * asin(sqrt(
                power(sin(radians(current_lat - $1) / 2), 2) +
                cos(radians($1)) * cos(radians(current_lat)) *
                power(sin(radians(current_lng - $2) / 2), 2)
              )) END) AS nearest
       FROM drivers`,
    [lat, lng, POSITION_FRESH_MIN]);
  const row = q.rows[0] || {};
  const approved = Number(row.approved) || 0;
  const locatable = Number(row.locatable) || 0;
  const nearest = row.nearest === null || row.nearest === undefined ? null : Number(row.nearest);

  /* 🚨 THIS RULE IS THE WHOLE FIX, AND MY FIRST VERSION GOT IT BACKWARDS.
     It said: a driver exists but we do not know where he is, so give the
     benefit of the doubt and call it covered. That is exactly Wilkendy's
     situation - and NOT ONE driver in the live system has ever sent a
     position, so the warning would never have fired for anybody. A guard that
     cannot fire is not a guard.

     So: we only claim coverage when we can SEE somebody. Unknown is not
     covered. The cost of being wrong the other way is small and visible - she
     is told it may be slow and can book anyway - while the cost of this
     silence was a real customer waiting five hours. */
  if (approved === 0)  return { covered: false, nearest_km: null, drivers_online: 0, reason: 'nobody_approved' };
  if (locatable === 0) return { covered: false, nearest_km: null, drivers_online: approved,
                                reason: 'nobody_locatable' };
  return { covered: nearest <= COVERAGE_KM, nearest_km: Math.round(nearest),
           drivers_online: locatable, reason: nearest <= COVERAGE_KM ? 'ok' : 'too_far' };
}

/* What the passenger's page should be told about a ride still searching.
   Pure reading - it changes nothing, so the tracking page can call it every
   few seconds without consequence. */
function waitState(ride, now = new Date()) {
  if (ride.status !== 'searching') return { phase: 'ok' };
  const started = new Date(ride.created_at).getTime();
  const mins = (now.getTime() - started) / 60000;
  const kept = ride.keep_waiting_until ? new Date(ride.keep_waiting_until).getTime() : 0;
  const stillPromised = kept > now.getTime();
  const limit = stillPromised ? (kept - started) / 60000 : EXPIRE_AFTER_MIN;

  if (mins >= limit) return { phase: 'expiring', waited_min: Math.round(mins) };
  if (mins >= NUDGE_AFTER_MIN && !stillPromised) {
    return { phase: 'slow', waited_min: Math.round(mins),
             nudge_after_min: NUDGE_AFTER_MIN };
  }
  return { phase: 'searching', waited_min: Math.round(mins) };
}

/* Close the ones nobody can serve. Idempotent: it only ever moves a row that
   is still 'searching', so running it twice does nothing the second time.
   Called on a timer AND opportunistically, so a quiet server still tidies up. */
async function expireStale(limit = 200) {
  const q = await pool.query(
    `UPDATE ride_requests
        SET status = 'expired',
            expired_at = NOW(),
            expire_reason = COALESCE(expire_reason, 'no_driver_accepted'),
            updated_at = NOW()
      WHERE id IN (
        SELECT id FROM ride_requests
         WHERE status = 'searching'
           AND COALESCE(payment_status, 'unpaid') <> 'paid'
           AND created_at < NOW() - make_interval(mins => $1)
           AND (keep_waiting_until IS NULL OR keep_waiting_until < NOW())
         ORDER BY created_at
         LIMIT $2)
      RETURNING tracking_code, customer_phone,
                EXTRACT(EPOCH FROM (NOW() - created_at))/60 AS waited_min`,
    [EXPIRE_AFTER_MIN, limit]);
  if (q.rows.length) {
    console.warn('[DISPATCH] closed ' + q.rows.length + ' ride(s) nobody accepted: ' +
      q.rows.map(r => `${r.tracking_code} after ${Math.round(r.waited_min)}min`).join(', '));
  }
  return q.rows;
}

/* ⛔ A PAID ride is never expired by a timer. Her money is on it; that needs a
   human decision and a refund, not a background job. They are reported
   instead, so they cannot be forgotten either. */
async function paidAndStranded() {
  const q = await pool.query(
    `SELECT tracking_code, customer_phone, total_with_protection,
            EXTRACT(EPOCH FROM (NOW() - created_at))/60 AS waited_min
       FROM ride_requests
      WHERE status = 'searching' AND LOWER(COALESCE(payment_status,'')) = 'paid'
        AND created_at < NOW() - make_interval(mins => $1)`,
    [EXPIRE_AFTER_MIN]);
  return q.rows;
}

let timer = null;
function startSweeper(everyMs = 5 * 60 * 1000) {
  if (timer) return;
  const tick = () => expireStale().catch(e =>
    console.error('[DISPATCH] sweep failed (rides unaffected):', e.message));
  timer = setInterval(tick, everyMs);
  if (timer.unref) timer.unref();
  tick();
}
function stopSweeper() { if (timer) { clearInterval(timer); timer = null; } }

module.exports = {
  COVERAGE_KM, POSITION_FRESH_MIN, NUDGE_AFTER_MIN, EXPIRE_AFTER_MIN, KEEP_WAITING_MIN,
  coverage, waitState, expireStale, paidAndStranded, startSweeper, stopSweeper
};
