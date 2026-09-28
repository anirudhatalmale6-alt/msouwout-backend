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
        /* ⛔ NOT is_test_account. A demo account is not a car that can come
           and get her, and counting it would make the "no driver nearby"
           warning lie in exactly the way it was built to stop. */
        COUNT(*) FILTER (WHERE status='approved' AND is_verified AND is_active
                           AND NOT COALESCE(is_test_account, false))::int AS approved,
        COUNT(*) FILTER (WHERE status='approved' AND is_verified AND is_active
                           AND NOT COALESCE(is_test_account, false)
                           AND current_lat IS NOT NULL AND current_lng IS NOT NULL
                           AND last_location_update > NOW() - make_interval(mins => $3))::int AS locatable,
        MIN(CASE WHEN status='approved' AND is_verified AND is_active
                  AND NOT COALESCE(is_test_account, false)
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

  /* Her driver accepted and then never came, so we took the ride off him and
     put it back out. She has to be TOLD that - going quietly back to a
     spinner, after she had a driver, is the silence this whole module exists
     to stop. Carried on every phase, because it is true whatever the clock
     says. */
  const dropped = Number(ride.reassigned_count) > 0 ? { driver_dropped: true } : {};

  if (mins >= limit) return Object.assign({ phase: 'expiring', waited_min: Math.round(mins) }, dropped);
  if (mins >= NUDGE_AFTER_MIN && !stillPromised) {
    return Object.assign({ phase: 'slow', waited_min: Math.round(mins),
                           nudge_after_min: NUDGE_AFTER_MIN }, dropped);
  }
  return Object.assign({ phase: 'searching', waited_min: Math.round(mins) }, dropped);
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

/* 🚨 28 Sep. "The ride was accepted without my approval and why is the driver
   dashboard like this?" - he was looking at a ride HIS OWN driver account had
   accepted NINETEEN HOURS earlier and never finished. It had sat on his
   dashboard ever since, looking like something that had just happened.

   Same fault as Wilkendy, one state further along: 'searching' could rot for
   ever and now cannot, but 'accepted' still could. An unpaid ride a driver
   took and never started is a ride nobody is coming for.

   It goes BACK to searching rather than being closed: the passenger may still
   want it, and another driver may still take it. Her payment is untouched
   either way - a PAID ride is never released, because money on a ride makes it
   a human decision.

   🚨 CAUGHT ON PRODUCTION, NOT BY THE TESTS. The first version of this set the
   ride to 'searching' and then the very next line of the sweeper - expireStale
   - closed it again in the same tick, because expiry is judged on created_at
   and the ride was already older than the expiry window. Released and killed
   inside one second. My tests called releaseAbandoned() on its own, so they
   never saw the two run together; the live sweeper does.

   So a released ride gets a REAL second chance: keep_waiting_until is pushed
   out, which is the same mechanism the passenger's own "keep waiting" button
   uses, and expireStale already honours it. If nobody takes it in that window
   it expires properly, with a reason, exactly like any other. */
const RELEASE_ACCEPTED_AFTER_MIN = 45;

async function releaseAbandoned(limit = 100) {
  const q = await pool.query(
    `UPDATE ride_requests
        SET status = 'searching',
            /* ⛔ KEEP HIM ON THE RECORD FIRST. driver_id has to go so the ride
               can be offered again, but wiping it also wiped the only trace of
               who took the ride and never came - so the very first ride this
               ran on, MW-V64SWJB, lost its driver the moment it was released.
               In a module that exists to preserve records, that was the worst
               possible thing to throw away. */
            last_driver_id = COALESCE(driver_id, last_driver_id),
            released_at = NOW(),
            driver_id = NULL,
            accepted_at = NULL,
            keep_waiting_until = NOW() + make_interval(mins => $3),
            reassigned_count = COALESCE(reassigned_count, 0) + 1,
            updated_at = NOW()
      WHERE id IN (
        SELECT id FROM ride_requests
         WHERE status = 'accepted'
           AND COALESCE(payment_status, 'unpaid') <> 'paid'
           AND started_at IS NULL
           AND COALESCE(accepted_at, created_at) < NOW() - make_interval(mins => $1)
         ORDER BY created_at
         LIMIT $2)
      RETURNING id, tracking_code, pickup_address, last_driver_id`,
    [RELEASE_ACCEPTED_AFTER_MIN, limit, KEEP_WAITING_MIN]);
  if (q.rows.length) {
    console.warn('[DISPATCH] released ' + q.rows.length +
      ' ride(s) a driver took and never started: ' +
      q.rows.map(r => r.tracking_code).join(', '));
    /* Tell the driver it is no longer his, for the same reason the passenger
       is told: he may be on his way to her right now. Required lazily so this
       module still loads for anything that does not send notifications, and
       never awaited - a push service must not hold up the sweep. */
    for (const row of q.rows) {
      if (!row.last_driver_id) continue;
      try {
        require('./driverAlerts')
          .alertRideGone(row.last_driver_id, row, 'released')
          .catch(e => console.error('[DISPATCH] release notice failed:', e.message));
      } catch (e) {
        console.error('[DISPATCH] release notice unavailable:', e.message);
      }
    }
  }
  return q.rows;
}

/* A ride the driver STARTED and never finished.
 *
 * 28 Sep, sweeping the rest of the workflow for the same fault as Wilkendy's:
 * a row that enters a state with nothing to take it out again. 'searching'
 * could rot for ever, and now cannot. 'accepted' could, and now cannot.
 * 'in_progress' still can - it leaves only when the driver presses Finish or
 * somebody cancels.
 *
 * ⛔ NO TIMER TOUCHES THIS ONE. Completing a ride pays a driver and charges a
 * passenger; cancelling one takes a fare away from a man who may genuinely
 * have driven it. Neither is a decision a background job gets to make at three
 * in the morning on a guess about how long a trip should take.
 *
 * But it cannot stay invisible either, because a ride stuck here also makes
 * its driver permanently BUSY - one forgotten trip and he can never accept
 * another. So it is reported, loudly, for a person to settle.
 */
const STUCK_IN_PROGRESS_MIN = 240;      // four hours; the longest plausible trip in Haiti

async function stuckInProgress() {
  const q = await pool.query(
    `SELECT r.tracking_code, r.customer_phone, r.price, r.payment_status,
            r.started_at, d.full_name AS driver_name, d.phone AS driver_phone,
            EXTRACT(EPOCH FROM (NOW() - r.started_at))/60 AS running_min
       FROM ride_requests r
       LEFT JOIN drivers d ON d.id = r.driver_id
      WHERE r.status = 'in_progress'   /* safety lives in safety_state now, not here */
        AND r.started_at < NOW() - make_interval(mins => $1)
      ORDER BY r.started_at`,
    [STUCK_IN_PROGRESS_MIN]);
  return q.rows;
}

/* Everything a person needs to look at, in one answer.
 *
 * 🚨 paidAndStranded() existed, was tested, and was called from NOWHERE. I
 * wrote a long comment in coverage() about a guard that cannot fire, and then
 * built a report nobody reads. Reporting it to a function nobody calls is the
 * same as not reporting it. */
async function needsAttention() {
  const [stranded, stuck] = await Promise.all([paidAndStranded(), stuckInProgress()]);
  return {
    paid_but_no_driver: stranded,
    started_but_never_finished: stuck,
    total: stranded.length + stuck.length
  };
}

let timer = null;
function startSweeper(everyMs = 5 * 60 * 1000) {
  if (timer) return;
  const tick = () => releaseAbandoned()
    .then(() => expireStale())
    /* Say it in the log too. The report route needs somebody to go and look;
       this needs nobody. */
    .then(() => needsAttention())
    .then(a => {
      if (a.total) {
        console.warn('[DISPATCH] ' + a.total + ' ride(s) need a PERSON: ' +
          a.paid_but_no_driver.map(r => r.tracking_code + ' paid, no driver').join(', ') +
          (a.paid_but_no_driver.length && a.started_but_never_finished.length ? '; ' : '') +
          a.started_but_never_finished.map(r =>
            r.tracking_code + ' running ' + Math.round(r.running_min / 60) + 'h').join(', '));
      }
    })
    .catch(e => console.error('[DISPATCH] sweep failed (rides unaffected):', e.message));
  timer = setInterval(tick, everyMs);
  if (timer.unref) timer.unref();
  tick();
}
function stopSweeper() { if (timer) { clearInterval(timer); timer = null; } }

module.exports = {
  COVERAGE_KM, POSITION_FRESH_MIN, NUDGE_AFTER_MIN, EXPIRE_AFTER_MIN, KEEP_WAITING_MIN,
  RELEASE_ACCEPTED_AFTER_MIN,
  STUCK_IN_PROGRESS_MIN,
  coverage, waitState, expireStale, releaseAbandoned, paidAndStranded,
  stuckInProgress, needsAttention,
  startSweeper, stopSweeper
};
