/* ═══ "WHICH AJAN BROUGHT THIS DRIVER?" ══════════════════════════════════════
 *
 * Jeffery, 15 Oct 2026: "When an Enterprise Ajan recruits a driver, the system
 * should record both the Enterprise and the individual Ajan responsible."
 *
 * The Ajan (Koutye) engine lives on the MyPlopPlop service, in another
 * database. Until now a driver signup only kept a partner name picked from a
 * dropdown, so an Ajan who recruited a driver got no record of it anywhere
 * and no organisation could count its drivers.
 *
 * This asks the engine to attach the driver to the Ajan whose code came with
 * the signup, and gets back:
 *   - the Ajan the driver now belongs to (first agent wins - it can be an
 *     EARLIER agent than the code typed today), and
 *   - that Ajan's organisation (e.g. STARFLEX), '' for an independent Ajan.
 *
 * ⛔ IT NEVER BLOCKS OR FAILS A REGISTRATION. A driver signing up is the thing
 *    that matters; a bad code, a sleeping service or a missing key is logged
 *    and the signup carries on with whatever was typed.
 * ⛔ Attribution only. No money is written here.
 * ═══════════════════════════════════════════════════════════════════════════ */

const KOUTYE_API = process.env.KOUTYE_API_URL || 'https://myplopplop-api.onrender.com';

/* Agent codes are short, but people type them with spaces, '#' or '@' in
   them (real codes include "DODO789@#" and "@FREY25"), so only trim and cap
   the length - never strip characters that may be part of the code. */
function cleanCode(raw) {
  return String(raw || '').trim().slice(0, 40);
}

async function attachDriverAgent({ code, name, phone }) {
  const c = cleanCode(code);
  if (!c) return { ok: false, reason: 'no_code' };
  const key = process.env.INTERNAL_SERVICE_KEY;
  if (!key) {
    console.warn('[AJAN] no INTERNAL_SERVICE_KEY - driver ' + phone + ' kept code "' + c + '" unverified');
    return { ok: false, reason: 'not_configured' };
  }

  /* Render puts the free MyPlopPlop service to sleep, and waking it can take
     most of a minute. The driver is not kept waiting that long: after 12 s the
     signup completes and the code stays on the driver record as typed. */
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 12000);
  try {
    const r = await fetch(KOUTYE_API + '/api/referrals/attach', {
      method: 'POST',
      signal: ctl.signal,
      headers: { 'Content-Type': 'application/json', 'x-internal-key': key },
      body: JSON.stringify({
        code: c, platform: 'msouwout', entityType: 'driver',
        name: String(name || '').slice(0, 120), phone: String(phone || '').slice(0, 40),
        source: 'MsouWout driver signup'
      })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, reason: 'http_' + r.status };
    return {
      ok: true,
      attached: !!j.attached,
      reason: j.reason,
      /* The code the driver is credited to, written the way the engine
         stores it - not the way it was typed. Null when the code was not a
         real Ajan. */
      koutyeCode: j.koutyeCode || null,
      organization: j.organization || ''
    };
  } catch (e) {
    console.warn('[AJAN] attach failed for driver ' + phone + ': ' + e.message);
    return { ok: false, reason: e.name === 'AbortError' ? 'timeout' : 'error' };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { attachDriverAgent, cleanCode };
