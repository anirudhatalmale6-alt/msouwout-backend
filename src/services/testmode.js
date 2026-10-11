/* ═══ TEST RIDES THAT COST NOTHING ════════════════════════════════════════
 *
 * Jeffery, 9 Oct 2026: "asking us to perform 10 consecutive real rides is not
 * financially reasonable. The minimum ride costs approximately 250 HTG…
 * IMPLEMENT COST-EFFECTIVE TESTING. Use simulated transactions and a safe
 * test environment to identify problems without requiring us to spend money
 * on every test."
 *
 * He is right, and the reason this was needed is written in the comments of
 * my own end-to-end scripts: "the one thing this cannot do is put real money
 * through MonCash." The only step that costs money was the only step never
 * covered, which is exactly the step he was being asked to pay to exercise.
 *
 * ═══ WHAT MAKES A RIDE A TEST RIDE ═══
 *
 * The passenger's telephone number, and nothing else. A number in the
 * reserved block is a test; everything else is real.
 *
 * 🔑 WHY THE NUMBER AND NOT A FLAG IN THE REQUEST BODY: a flag in the body is
 * something anybody can send. The whole point of this is that a real customer
 * can NEVER create a free ride, by accident or on purpose. A Haitian mobile
 * number begins 3, 4 or 5 after the country code - +509 0000 xxxx cannot be
 * dialled and cannot be owned, so nobody can arrive at it by mistyping.
 *
 * ⛔ And there is no route, header or query parameter anywhere that turns
 * test mode on. If there were, it would be the first thing somebody tried.
 *
 * ⚠️ The driver side already had this idea: drivers.is_test_account, set for
 * +50900000000, the number Apple's reviewers sign in with. Same block, same
 * reasoning, so this is one convention rather than two.
 * ═══════════════════════════════════════════════════════════════════════════ */

/* +509 0000 0000 … +509 0000 9999. Overridable so the block can be moved
   without a deploy, but the default is what the code and the tests assume. */
const PREFIX = process.env.TEST_PHONE_PREFIX || '+5090000';

/* Phones arrive written every way a person can write them: with spaces, with
   dashes, with or without +509, sometimes just the local eight digits. This
   has to recognise the same number in all of those forms, or a test ride
   books as a real one and somebody is charged. */
function normalise(raw) {
  let s = String(raw === undefined || raw === null ? '' : raw).replace(/[^\d+]/g, '');
  if (!s) return '';
  if (s.startsWith('+')) return s;
  if (s.startsWith('509') && s.length >= 11) return '+' + s;
  if (s.length === 8) return '+509' + s;          /* a local Haitian number */
  return '+' + s;
}

function isTestPhone(raw) {
  const n = normalise(raw);
  return !!n && n.startsWith(PREFIX);
}

/* A ride is a test when the person TRAVELLING is on a test number. On a
   delegated booking - somebody ordering a ride for someone else - either end
   being a test number makes it a test, because both are used in my runs and
   the safe direction is to settle nothing rather than to settle something. */
function rideIsTest(body) {
  const b = body || {};
  return isTestPhone(b.customer_phone) ||
         isTestPhone(b.passenger_phone) ||
         isTestPhone(b.orderer_phone);
}

module.exports = { isTestPhone, rideIsTest, normalise, PREFIX };
