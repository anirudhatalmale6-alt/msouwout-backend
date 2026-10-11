/* ===========================================================================
   TELLING A DRIVER A RIDE EXISTS, WITHOUT HIM STARING AT THE PAGE.

   Jeffery, 28 Sep: "we need a reliable new ride notification/alert for
   drivers. MsouWout cannot depend on drivers having the webpage open at
   exactly the moment somebody requests a ride."

   He is right, and it is why Wilkendy waited five hours. Until now the only
   alert was a sound played by a page that had to already be open.

   ── WHY WEB PUSH AND NOT SOMETHING ELSE ────────────────────────────────────
   SMS costs money per message and needs an account nobody has opened.
   WhatsApp needs the Cloud API, which is still blocked on Meta credentials.
   Web Push is free, needs no third-party account, and on Android - which is
   what the drivers carry - it wakes the phone with the browser CLOSED. That
   is the entire requirement, and it is the only option that meets it today.

   ⚠️ iOS only delivers Web Push to a site the user has added to the home
   screen. Said out loud rather than discovered later.

   ── THE KEYS ───────────────────────────────────────────────────────────────
   VAPID keys identify this server to the push services. They are generated
   ONCE and then live in the database, not in the source: a key pair in a
   public repository is a key pair anybody can send notifications with. If
   VAPID_PUBLIC/VAPID_PRIVATE are set in the environment they win, so the
   client can move them later without a migration.
   =========================================================================== */

const webpush = require('web-push');
const pool = require('./../db/pool');

const SUBJECT = 'mailto:kontak@msouwout.com';
let ready = null;

async function keys() {
  if (process.env.VAPID_PUBLIC && process.env.VAPID_PRIVATE) {
    return { publicKey: process.env.VAPID_PUBLIC, privateKey: process.env.VAPID_PRIVATE };
  }
  const got = await pool.query(`SELECT value FROM service_config WHERE key = 'vapid'`);
  if (got.rows.length && got.rows[0].value && got.rows[0].value.publicKey) {
    return got.rows[0].value;
  }
  /* First boot on a given database. Generated once and kept. */
  const made = webpush.generateVAPIDKeys();
  await pool.query(
    `INSERT INTO service_config (key, value) VALUES ('vapid', $1)
     ON CONFLICT (key) DO NOTHING`, [JSON.stringify(made)]);
  const again = await pool.query(`SELECT value FROM service_config WHERE key = 'vapid'`);
  console.warn('[ALERTS] VAPID keys created for this database.');
  return (again.rows[0] && again.rows[0].value) || made;
}

async function init() {
  if (!ready) {
    ready = (async () => {
      const k = await keys();
      webpush.setVapidDetails(SUBJECT, k.publicKey, k.privateKey);
      return k;
    })().catch(e => { ready = null; throw e; });
  }
  return ready;
}

/** The public key the driver's browser needs in order to subscribe. */
async function publicKey() { return (await init()).publicKey; }

/** Remember where to reach this driver's phone. */
async function subscribe(driverId, subscription) {
  if (!driverId || !subscription || !subscription.endpoint) {
    return { error: 'driver_id and a subscription are required', code: 400 };
  }
  await pool.query(
    `INSERT INTO driver_push (driver_id, endpoint, subscription, created_at, last_ok)
     VALUES ($1, $2, $3, NOW(), NOW())
     ON CONFLICT (endpoint) DO UPDATE
       SET driver_id = EXCLUDED.driver_id,
           subscription = EXCLUDED.subscription,
           failures = 0,
           last_ok = NOW()`,
    [driverId, subscription.endpoint, JSON.stringify(subscription)]);
  return { ok: true };
}

async function unsubscribe(endpoint) {
  await pool.query('DELETE FROM driver_push WHERE endpoint = $1', [endpoint]);
  return { ok: true };
}

/* Send to every driver who can take this ride.
 *
 * ⛔ Never awaited by the route that creates a ride. A push service being slow
 *    must not make a passenger's booking slow, and a push service being down
 *    must not make it fail. This is an alert, not the system of record - the
 *    board is still there and still polled.
 */
async function alertNewRide(ride) {
  try {
    await init();
  } catch (e) {
    console.error('[ALERTS] no VAPID keys, cannot notify:', e.message);
    return { sent: 0, reason: 'no_keys' };
  }

  /* ═══ 🚨 A TEST RIDE MUST NEVER PAGE A REAL DRIVER ═══════════════════════
     This line used to be one-directional: a real ride never went to a demo
     phone. The reverse was missing, and it matters much more now that I am
     about to run the whole journey over and over for nothing.

     Without this, every single test ride sends a push notification - "🛵
     Nouvo kous — 250 HTG" - to EVERY approved driver in Haiti. Twenty test
     runs is twenty false alarms on every real driver's phone, for rides that
     do not exist. That is how a platform earns a reputation for being broken,
     and it would have been me doing it.

     So the rule is symmetrical now: a real ride reaches real drivers, a test
     ride reaches test accounts, and neither ever crosses. */
  const wantTest = !!(ride && ride.is_test);
  const subs = await pool.query(
    `SELECT p.endpoint, p.subscription, p.failures
       FROM driver_push p
       JOIN drivers d ON d.id = p.driver_id
      WHERE d.status = 'approved' AND d.is_verified = true AND d.is_active = true
        AND COALESCE(d.is_test_account, false) = $1
        AND p.failures < 5`, [wantTest]);
  if (!subs.rows.length) return { sent: 0, reason: 'nobody_subscribed' };

  const body = [
    ride.pickup_address || 'Yon kliyan',
    ride.dropoff_address ? '→ ' + ride.dropoff_address : ''
  ].filter(Boolean).join(' ');
  const payload = JSON.stringify({
    title: '🛵 Nouvo kous — ' + (ride.price ? ride.price + ' HTG' : 'MsouWout'),
    body: body.slice(0, 160),
    tag: 'ride-' + ride.id,           // a second alert REPLACES the first
    url: 'https://msouwout.com/driver-login.html',
    tracking_code: ride.tracking_code
  });

  let sent = 0, gone = 0;
  await Promise.all(subs.rows.map(async row => {
    try {
      await webpush.sendNotification(row.subscription, payload, { TTL: 900 });
      sent++;
      await pool.query('UPDATE driver_push SET last_ok = NOW(), failures = 0 WHERE endpoint = $1',
                       [row.endpoint]);
    } catch (err) {
      /* 404/410 mean the browser threw the subscription away - the phone was
         reset, or he cleared the site. Keeping it would mean trying for ever. */
      if (err.statusCode === 404 || err.statusCode === 410) {
        await pool.query('DELETE FROM driver_push WHERE endpoint = $1', [row.endpoint]);
        gone++;
      } else {
        await pool.query('UPDATE driver_push SET failures = failures + 1 WHERE endpoint = $1',
                         [row.endpoint]);
      }
    }
  }));
  console.warn(`[ALERTS] ${ride.tracking_code}: notified ${sent} driver phone(s)` +
               (gone ? `, dropped ${gone} dead subscription(s)` : ''));
  return { sent, gone };
}

/* Tell ONE driver that a ride he was holding is no longer his.
 *
 * 28 Sep, Jeffery: "She cancelled it but i never received a text and its still
 * active." He is right on both halves. The card staying put is fixed on the
 * page; this is the other half - alertNewRide was the ONLY notification in the
 * system, so a driver was told when work arrived and never when it went away.
 * He can be on his way to a passenger who cancelled ten minutes ago.
 *
 * ⛔ Sent to that driver's phones only, never broadcast: nobody else needs to
 * know, and the ride is already off the board for everybody.
 */
async function alertRideGone(driverId, ride, reason) {
  if (!driverId) return { sent: 0, reason: 'no_driver' };
  try {
    await init();
  } catch (e) {
    console.error('[ALERTS] no VAPID keys, cannot notify:', e.message);
    return { sent: 0, reason: 'no_keys' };
  }

  const subs = await pool.query(
    `SELECT endpoint, subscription FROM driver_push
      WHERE driver_id = $1 AND failures < 5`, [driverId]);
  if (!subs.rows.length) return { sent: 0, reason: 'nobody_subscribed' };

  const TITLES = {
    cancelled_by_rider: '❌ Kliyan an anile kous la',
    released: '⏳ Kous la retounen nan lis la',
    cancelled: '❌ Kous la anile'
  };
  const payload = JSON.stringify({
    title: TITLES[reason] || TITLES.cancelled,
    body: [ride.tracking_code, ride.pickup_address].filter(Boolean).join(' — ').slice(0, 160),
    /* ⚠️ The SAME tag as the new-ride alert for this ride, so "gone" REPLACES
       "here is a ride" on his lock screen instead of sitting under it. */
    tag: 'ride-' + ride.id,
    url: 'https://msouwout.com/driver-login.html',
    tracking_code: ride.tracking_code
  });

  let sent = 0;
  await Promise.all(subs.rows.map(async row => {
    try {
      await webpush.sendNotification(row.subscription, payload, { TTL: 900 });
      sent++;
      await pool.query('UPDATE driver_push SET last_ok = NOW(), failures = 0 WHERE endpoint = $1',
                       [row.endpoint]);
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        await pool.query('DELETE FROM driver_push WHERE endpoint = $1', [row.endpoint]);
      } else {
        await pool.query('UPDATE driver_push SET failures = failures + 1 WHERE endpoint = $1',
                         [row.endpoint]);
      }
    }
  }));
  console.warn(`[ALERTS] ${ride.tracking_code}: told ${sent} phone(s) the ride is gone (${reason})`);
  return { sent };
}

module.exports = { publicKey, subscribe, unsubscribe, alertNewRide, alertRideGone, init };
