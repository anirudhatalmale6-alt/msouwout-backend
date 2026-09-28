/* ===========================================================================
   DRIVER SIGN-IN THAT ACTUALLY CHECKS SOMETHING.

   Jeffery, 28 Sep: "A driver dashboard cannot be accessible simply by knowing
   someone's phone number. Passenger names, phone numbers and addresses are
   private information. Please design a safe migration so existing drivers are
   not suddenly locked out, then enforce real PIN authentication server-side."

   Until now POST /api/drivers/login took a phone number and nothing else. The
   app asked for a PIN and threw it away — there was no pin column to check it
   against. Anyone with a driver's number could open his dashboard and read the
   name, phone number and address of every passenger he had carried.

   ── WHY NOBODY GETS LOCKED OUT ─────────────────────────────────────────────
   Not one driver has a PIN today, so "require a PIN from now on" would lock
   out the entire fleet at once — a security control whose failure mode is
   "nobody can work" is the wrong control.

   So the PIN is ENROLLED, not imposed:

     no pin_hash yet  → he signs in with his phone exactly as before, and the
                        answer says enrollment_required. He sets his PIN in
                        that moment, on the phone he already has in his hand.
     pin_hash set     → the PIN is required and verified, every time.

   The fleet migrates itself, one driver at a time, at the moment each man next
   opens the app. No announcement, no support queue, nobody stranded.

   ⚠️ A 4-digit PIN is 10,000 possibilities. The hash is not what protects it —
   the LOCKOUT is. Five wrong tries and the account stops answering for fifteen
   minutes, which turns a two-minute guessing run into weeks.

   ⛔ NO SMS RECOVERY, because there is no SMS in this system and pretending
   otherwise would strand a driver who forgot his PIN. An administrator clears
   it and he enrolls again on his next sign-in.
   =========================================================================== */

const crypto = require('crypto');
const pool = require('./../db/pool');

const PIN_LEN = 4;
const MAX_ATTEMPTS = 5;
const LOCK_MINUTES = 15;

/* scrypt from Node's own crypto — no new dependency to audit, and the cost
   parameters are explicit rather than inherited from a library default. */
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

function hashPin(pin, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(pin), salt, SCRYPT.keylen, SCRYPT, (err, key) => {
      if (err) return reject(err);
      resolve(key.toString('hex'));
    });
  });
}

/** `scrypt$<salt>$<hex>` — the format carries its own algorithm so a later
 *  change does not have to guess what the stored rows are. */
async function makeHash(pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  return 'scrypt$' + salt + '$' + (await hashPin(pin, salt));
}

async function verifyHash(pin, stored) {
  if (!stored) return false;
  const parts = String(stored).split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const got = await hashPin(pin, parts[1]);
  const a = Buffer.from(got, 'hex');
  const b = Buffer.from(parts[2], 'hex');
  /* Constant time: a plain === on a secret leaks its prefix to anyone patient
     enough to time the answers. */
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function validPin(pin) {
  return typeof pin === 'string' && new RegExp('^\\d{' + PIN_LEN + '}$').test(pin.trim());
}

/* ⛔ A PIN anyone would guess first is not a PIN. These are the ones a Haitian
   phone keypad gets by reflex; refusing them costs one retry and removes the
   only guesses worth making inside a 5-attempt lockout. */
const TOO_OBVIOUS = new Set([
  '0000', '1111', '2222', '3333', '4444', '5555', '6666', '7777', '8888', '9999',
  '1234', '4321', '1212', '2121', '0123', '1230'
]);

function pinRejectReason(pin) {
  if (!validPin(pin)) return 'pin_format';
  if (TOO_OBVIOUS.has(pin.trim())) return 'pin_too_simple';
  return null;
}

function lockedFor(driver, now = new Date()) {
  if (!driver.pin_locked_until) return 0;
  const ms = new Date(driver.pin_locked_until).getTime() - now.getTime();
  return ms > 0 ? Math.ceil(ms / 60000) : 0;
}

/** Wrong PIN: count it, and lock the account once the count is spent. */
async function recordFailure(driverId) {
  const q = await pool.query(
    `UPDATE drivers
        SET pin_attempts = COALESCE(pin_attempts, 0) + 1,
            pin_locked_until = CASE
              WHEN COALESCE(pin_attempts, 0) + 1 >= $2
              THEN NOW() + make_interval(mins => $3)
              ELSE pin_locked_until END
      WHERE id = $1
      RETURNING pin_attempts, pin_locked_until`,
    [driverId, MAX_ATTEMPTS, LOCK_MINUTES]);
  return q.rows[0] || {};
}

async function clearFailures(driverId) {
  await pool.query(
    `UPDATE drivers SET pin_attempts = 0, pin_locked_until = NULL WHERE id = $1`, [driverId]);
}

/* Decide what a sign-in attempt should do. Returns one of:
 *   {outcome:'enroll'}  — he has no PIN; let him in and make him set one now
 *   {outcome:'ok'}      — PIN correct
 *   {outcome:'locked', minutes}
 *   {outcome:'pin_required'} / {outcome:'pin_wrong', remaining}
 *
 * ⛔ Deliberately does NOT reveal whether a phone number exists — that is the
 *    caller's business, and it already 404s on an unknown number today. */
async function checkSignIn(driver, pin) {
  const mins = lockedFor(driver);
  if (mins > 0) return { outcome: 'locked', minutes: mins };

  if (!driver.pin_hash) return { outcome: 'enroll' };

  if (!validPin(pin || '')) return { outcome: 'pin_required' };

  if (await verifyHash(String(pin).trim(), driver.pin_hash)) {
    await clearFailures(driver.id);
    return { outcome: 'ok' };
  }

  const after = await recordFailure(driver.id);
  const left = Math.max(0, MAX_ATTEMPTS - Number(after.pin_attempts || 0));
  if (left === 0) return { outcome: 'locked', minutes: LOCK_MINUTES };
  return { outcome: 'pin_wrong', remaining: left };
}

/* Set a PIN for a driver who does not have one. This is the enrollment step.
 *
 * ⛔ It refuses when a PIN already exists. Otherwise the "set your PIN" call
 *    would be a way to OVERWRITE somebody else's PIN knowing only his phone
 *    number — which is the exact hole being closed. Changing an existing PIN
 *    requires the current one; forgetting it is an administrator's job. */
async function enroll(driverId, pin) {
  const bad = pinRejectReason(String(pin || '').trim());
  if (bad) return { error: bad, code: 400 };

  const hash = await makeHash(String(pin).trim());
  const q = await pool.query(
    `UPDATE drivers
        SET pin_hash = $2, pin_set_at = NOW(), pin_attempts = 0, pin_locked_until = NULL
      WHERE id = $1 AND pin_hash IS NULL
      RETURNING id`, [driverId, hash]);
  if (!q.rows.length) return { error: 'pin_already_set', code: 409 };
  return { ok: true };
}

/** Change a PIN he can still remember. Requires the current one. */
async function change(driverId, currentPin, nextPin) {
  const bad = pinRejectReason(String(nextPin || '').trim());
  if (bad) return { error: bad, code: 400 };

  const d = await pool.query(
    `SELECT id, pin_hash, pin_attempts, pin_locked_until FROM drivers WHERE id = $1`, [driverId]);
  if (!d.rows.length) return { error: 'driver_not_found', code: 404 };

  const check = await checkSignIn(d.rows[0], currentPin);
  if (check.outcome === 'enroll') return enroll(driverId, nextPin);
  if (check.outcome !== 'ok') return { error: 'pin_wrong', code: 403, detail: check };

  await pool.query(
    `UPDATE drivers SET pin_hash = $2, pin_set_at = NOW(), pin_attempts = 0,
            pin_locked_until = NULL WHERE id = $1`,
    [driverId, await makeHash(String(nextPin).trim())]);
  return { ok: true };
}

/** Administrator: he forgot it. Clear it so he enrolls again next sign-in.
 *  ⛔ Never sets a PIN on his behalf — a PIN somebody else chose is a PIN
 *     somebody else knows. */
async function adminReset(driverId) {
  const q = await pool.query(
    `UPDATE drivers SET pin_hash = NULL, pin_set_at = NULL, pin_attempts = 0,
            pin_locked_until = NULL WHERE id = $1 RETURNING id, full_name`, [driverId]);
  if (!q.rows.length) return { error: 'driver_not_found', code: 404 };
  console.warn('[AUTH] PIN cleared for driver ' + driverId + ' — re-enrolls on next sign-in');
  return { ok: true, driver: q.rows[0] };
}

module.exports = {
  PIN_LEN, MAX_ATTEMPTS, LOCK_MINUTES,
  makeHash, verifyHash, validPin, pinRejectReason, lockedFor,
  checkSignIn, enroll, change, adminReset
};
