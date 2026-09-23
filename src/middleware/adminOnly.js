/* One gate in front of every route that only an administrator should reach.
 *
 * MsouWout already had two working locks, and both of them were fitted to a
 * handful of doors:
 *
 *   - adminAuth in server.js, checking ADMIN_SECRET, mounted only on /api/zones
 *   - adminPass in routes/drivers.js, checking the password stored in
 *     service_config('admin_auth'), on six routes under /api/drivers/admin/*
 *
 * Meanwhile PATCH /api/drivers/:id/approve - a second door to the same action -
 * had nothing on it, and answered anybody. So did the fare table, the business
 * approvals, the fleet verifications and the driver list with everybody's phone
 * number and licence in it. The lock was never the problem; the number of doors
 * it was fitted to was.
 *
 * This checks the SAME two credentials, so the two admin pages that already
 * send them keep working untouched: admin.html sends X-Admin-Secret, and
 * driver-admin.html sends x-admin-pass.
 *
 * It fails CLOSED. The old adminAuth read
 *
 *     if (process.env.ADMIN_SECRET && secret !== process.env.ADMIN_SECRET)
 *
 * which quietly lets the whole world through the day that variable goes
 * missing - a guard that stops guarding without anything looking broken. If
 * neither credential is configured this refuses every request and says so in
 * the log, loudly, rather than pretending to be a lock.
 */
const pool = require('../db/pool');

// method + path patterns that require an administrator. Anything not listed
// here is untouched - the driver app, the passenger app and the sign-up forms
// carry no credential and must keep working.
const ADMIN_ONLY = [
  // Driver approval. The /admin/* copies of these already had adminPass on
  // them; these are the older unguarded doors to the same rows.
  ['PATCH', /^\/api\/drivers\/[^/]+\/(approve|reject|suspend)$/],
  ['PATCH', /^\/api\/drivers\/admin\/[^/]+$/],
  ['POST', /^\/api\/drivers\/admin\/[^/]+\/(approve|reject)$/],
  /* 🚨 22 Sep: GET /api/rides was PUBLIC and its own comment says "(admin)".
     It returns r.* for every ride - customer_name AND customer_phone - and
     with no ?limit it returns the WHOLE table to anyone who knows the URL.
     ⚠️ The pattern is anchored so it can only ever match the bare list. The
     driver board (/api/rides/available), a single ride (/api/rides/MW-xxxx)
     and the driver's active ride must all stay open - the apps carry no
     credential and would break instantly. */
  ['GET', /^\/api\/rides\/?$/],

  // The full driver list: name, phone, e-mail, licence number, plate.
  ['GET', /^\/api\/drivers\/?$/],
  ['GET', /^\/api\/drivers\/stats\/?$/],

  // Businesses
  ['PATCH', /^\/api\/businesses\/[^/]+\/(approve|reject)$/],
  ['GET', /^\/api\/businesses\/?$/],
  ['GET', /^\/api\/businesses\/stats\/?$/],

  // Logistics: verifying a fleet or a truck is an approval decision.
  ['PATCH', /^\/api\/logistics\/(fleets|trucks)\/[^/]+\/verify$/],

  // The fare table for the whole country.
  ['PUT', /^\/api\/pricing\/?$/],
  ['POST', /^\/api\/pricing\/reset$/],

  // Trip review
  ['PATCH', /^\/api\/trips\/[^/]+\/(approve|reject)$/],

  // Turning a payment provider on or off decides whether anybody can pay at
  // all, and which of Jeffery's gateways the money goes through.
  ['GET', /^\/api\/payments\/admin\/providers\/?$/],
  ['PUT', /^\/api\/payments\/admin\/providers\/?$/],
  // Recent payments: references, amounts and payer phone numbers.
  ['GET', /^\/api\/payments\/admin\/recent\/?$/],

  // Medical claims and settlements move money.
  ['PATCH', /^\/api\/medical\/(claims|settlement)\/[^/]+$/],
  ['POST', /^\/api\/medical\/settlement$/],
  ['GET', /^\/api\/medical\/(dashboard|export)$/]
];

function isAdminOnly(method, path) {
  for (const [m, re] of ADMIN_ONLY) {
    if (m === method && re.test(path)) return true;
  }
  return false;
}

async function storedPassword() {
  try {
    const r = await pool.query("SELECT value FROM service_config WHERE key = 'admin_auth'");
    return (r.rows[0] && r.rows[0].value && r.rows[0].value.password) || null;
  } catch (e) {
    console.error('adminOnly: could not read the stored admin password:', e.message);
    return null;
  }
}

async function adminOnly(req, res, next) {
  const path = req.path.split('?')[0];
  if (!isAdminOnly(req.method, path)) return next();

  const envSecret = process.env.ADMIN_SECRET || null;
  const given = req.headers['x-admin-secret'] || req.headers['x-admin-pass'] ||
    (req.body || {}).admin_pass || req.query.secret || req.query.pass || '';

  if (envSecret && given && given === envSecret) return next();

  const dbPass = await storedPassword();
  if (dbPass && given && given === dbPass) return next();

  if (!envSecret && !dbPass) {
    console.error('ADMIN LOCKOUT: neither ADMIN_SECRET nor the stored admin ' +
      'password is set, so ' + req.method + ' ' + path + ' is being refused. ' +
      'Set one of them - this route is NOT open in the meantime.');
  }
  return res.status(401).json({ error: 'Unauthorized' });
}

module.exports = { adminOnly, isAdminOnly, ADMIN_ONLY };
