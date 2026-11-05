/* OAVCT EXPIRY (5 Nov 2026). Jeffery: "Any approved driver whose OAVCT expires must automatically become
   unavailable for new rides and deliveries until a valid document is uploaded and verified. Notify the driver
   and Jennifer, preferably before expiration as well. Do not interrupt a trip already in progress. Block new
   assignments after the current job is safely completed."

   - HELD = approved AND oavct_expiry is a date AND it is before today (Haiti time). Computed from the date
     itself, everywhere it matters (board, accept, ride alerts, the MyPlopPlop lock), so there is no flag that
     can drift out of step with the document. A driver with NO date is not held (nothing says it expired);
     Jennifer sees him in her console instead.
   - Only NEW work is refused. Start / arrived / complete of a job he already has are never checked here.
   - Lifted by Jennifer's console only: a new photo (console / Ajan login, logged) + the new date she reads on
     it (POST /internal/console/:id/oavct, logged). The moment the date is valid again he can work.
   - sweep() (hourly): reminders 30 / 7 / 1 day(s) before, the hold notice, the "you can work again" notice,
     each sent once (drivers.oavct_notice), each written to driver_events. */
const pool = require('../db/pool');
const TODAY = `(NOW() AT TIME ZONE 'America/Port-au-Prince')::date`;
const heldSql = (a) => `(${a}.status = 'approved' AND ${a}.oavct_expiry IS NOT NULL AND ${a}.oavct_expiry < ${TODAY})`;

function fmt(d) {
  if (!d) return '';
  const x = d instanceof Date ? d : new Date(d);
  return String(x.getUTCDate()).padStart(2, '0') + '/' + String(x.getUTCMonth() + 1).padStart(2, '0') + '/' + x.getUTCFullYear();
}

/* -> { state:'ok'|'soon'|'expired'|'missing', expiry:'YYYY-MM-DD'|null, days:int|null, held:boolean } */
async function state(driverId) {
  const r = await pool.query(`SELECT status, oavct_expiry, (oavct_expiry - ${TODAY})::int AS days, ${heldSql('d')} AS held
                                FROM drivers d WHERE id = $1`, [driverId]);
  if (!r.rows.length) return null;
  const x = r.rows[0];
  const exp = x.oavct_expiry ? new Date(x.oavct_expiry).toISOString().slice(0, 10) : null;
  const st = !exp ? 'missing' : (x.days < 0 ? 'expired' : (x.days <= 30 ? 'soon' : 'ok'));
  return { state: st, expiry: exp, days: exp ? x.days : null, held: !!x.held };
}

async function isHeld(driverId) {
  const r = await pool.query(`SELECT ${heldSql('d')} AS held FROM drivers d WHERE id = $1`, [driverId]);
  return !!(r.rows[0] && r.rows[0].held);
}

const FIX = 'Voye nouvo OAVCT a bay Ajan ou oswa bay Jennifer (WhatsApp). Lè yo verifye l epi yo mete nouvo dat la, ou ka travay ankò.';
const MSG = {
  d30: (d, n) => ({ title: '⚠️ OAVCT ou ap ekspire nan ' + n + ' jou', body: 'Li ekspire ' + d + '. Renouvle l bonè pou w pa pèdi kous. ' + FIX }),
  d7: (d, n) => ({ title: '⚠️ OAVCT ou ap ekspire nan ' + n + ' jou', body: 'Li ekspire ' + d + '. Apre dat sa a, ou p ap resevwa nouvo kous ni livrezon. ' + FIX }),
  d1: (d, n) => ({ title: n <= 0 ? '⛔ OAVCT ou ekspire jodi a' : '⛔ OAVCT ou ekspire demen', body: 'Dat: ' + d + '. Apre sa, ou p ap resevwa nouvo kous ni livrezon jiskaske li renouvle. ' + FIX }),
  hold: (d) => ({ title: '⛔ OAVCT ekspire: nouvo kous kanpe', body: 'OAVCT ou ekspire ' + d + '. Ou p ap resevwa nouvo kous ni livrezon. Kous ou te deja genyen an pa chanje. ' + FIX }),
  lifted: (d) => ({ title: '✅ OAVCT ou an règ', body: 'Nouvo dat: ' + d + '. Ou ka resevwa kous ak livrezon ankò.' })
};
const RANK = { d30: 1, d7: 2, d1: 3, hold: 4 };

async function event(driverId, kind, detail) {
  await pool.query('INSERT INTO driver_events (driver_id, kind, by, detail) VALUES ($1, $2, $3, $4)',
    [driverId, kind, 'system', JSON.stringify(detail || {})]).catch(() => {});
}
async function notify(driverId, key, m) {
  let sent = 0;
  try { sent = (await require('./driverAlerts').alertDriver(driverId, Object.assign({ tag: 'oavct' }, m))).sent || 0; } catch (e) { /* recorded anyway */ }
  return sent;
}

/* opts.now (tests): a Date to use as "now" is NOT supported - tests move the expiry date instead. */
async function sweep() {
  const out = { held: 0, lifted: 0, warned: 0 };
  /* 1. newly held */
  const h = await pool.query(`UPDATE drivers d SET oavct_hold_at = NOW(), oavct_notice = 'hold'
       WHERE ${heldSql('d')} AND d.oavct_hold_at IS NULL AND NOT COALESCE(d.is_test_account, false)
       RETURNING d.id, d.oavct_expiry`);
  for (const r of h.rows) {
    const sent = await notify(r.id, 'hold', MSG.hold(fmt(r.oavct_expiry)));
    await event(r.id, 'oavct_hold', { expiry: fmt(r.oavct_expiry), push_sent: sent });
    console.warn('[OAVCT] driver ' + r.id + ' held: OAVCT expired ' + fmt(r.oavct_expiry));
    out.held++;
  }
  /* 2. lifted: the date is valid again (or he is no longer approved) */
  const l = await pool.query(`UPDATE drivers d SET oavct_hold_at = NULL, oavct_notice = NULL
       WHERE d.oavct_hold_at IS NOT NULL AND NOT ${heldSql('d')}
       RETURNING d.id, d.status, d.oavct_expiry`);
  for (const r of l.rows) {
    let sent = 0;
    if (r.status === 'approved') sent = await notify(r.id, 'lifted', MSG.lifted(fmt(r.oavct_expiry)));
    await event(r.id, 'oavct_hold_lifted', { expiry: fmt(r.oavct_expiry), status: r.status, push_sent: sent });
    out.lifted++;
  }
  /* 3. a renewed date far away: forget earlier reminders so the next cycle reminds again */
  await pool.query(`UPDATE drivers d SET oavct_notice = NULL WHERE d.oavct_notice IN ('d30','d7','d1')
       AND d.oavct_expiry IS NOT NULL AND (d.oavct_expiry - ${TODAY}) > 30`);
  /* 4. reminders before the date */
  const w = await pool.query(`SELECT d.id, d.oavct_expiry, (d.oavct_expiry - ${TODAY})::int AS days, d.oavct_notice
       FROM drivers d WHERE d.status = 'approved' AND d.oavct_expiry IS NOT NULL AND NOT COALESCE(d.is_test_account, false)
        AND (d.oavct_expiry - ${TODAY}) BETWEEN 0 AND 30`);
  for (const r of w.rows) {
    const lvl = r.days <= 1 ? 'd1' : (r.days <= 7 ? 'd7' : 'd30');
    if ((RANK[r.oavct_notice] || 0) >= RANK[lvl]) continue;
    const won = await pool.query(`UPDATE drivers SET oavct_notice = $2 WHERE id = $1 AND COALESCE(oavct_notice, '') = $3 RETURNING id`,
      [r.id, lvl, r.oavct_notice || '']);
    if (!won.rows.length) continue;
    const sent = await notify(r.id, lvl, MSG[lvl](fmt(r.oavct_expiry), r.days));
    await event(r.id, 'oavct_warning', { level: lvl, days: r.days, expiry: fmt(r.oavct_expiry), push_sent: sent });
    out.warned++;
  }
  if (out.held || out.lifted || out.warned) console.log('[OAVCT] sweep ' + JSON.stringify(out));
  return out;
}

/* For Jennifer's console: approved drivers held, expiring within 30 days, or with no date. */
async function overview() {
  const r = await pool.query(`SELECT d.id, d.full_name, d.phone, d.whatsapp, d.oavct_expiry, (d.oavct_expiry - ${TODAY})::int AS days,
       d.oavct_hold_at, d.oavct_notice, d.referral_code, d.referral_partner,
       dd.created_at AS photo_at, dd.updated_by AS photo_by
       FROM drivers d LEFT JOIN driver_documents dd ON dd.driver_id = d.id AND dd.doc_type = 'oavct' WHERE d.status = 'approved' AND NOT COALESCE(d.is_test_account, false)
        AND (d.oavct_expiry IS NULL OR (d.oavct_expiry - ${TODAY}) <= 30)
       ORDER BY d.oavct_expiry NULLS FIRST LIMIT 300`);
  const rows = r.rows.map((x) => ({ id: x.id, name: x.full_name, phone: x.phone, whatsapp: x.whatsapp,
    expiry: x.oavct_expiry ? new Date(x.oavct_expiry).toISOString().slice(0, 10) : null, days: x.oavct_expiry ? x.days : null,
    state: !x.oavct_expiry ? 'missing' : (x.days < 0 ? 'expired' : 'soon'), held_since: x.oavct_hold_at, notice: x.oavct_notice,
    ajan: x.referral_code || x.referral_partner || null, photo_at: x.photo_at, photo_by: x.photo_by,
    /* a photo sent after the hold began / within the renewal window = waiting for Jennifer to check it */
    new_photo: !!(x.photo_at && x.oavct_expiry && new Date(x.photo_at) >= new Date(new Date(x.oavct_expiry).getTime() - 45 * 86400000)) }));
  return { held: rows.filter((x) => x.state === 'expired'), soon: rows.filter((x) => x.state === 'soon'), missing: rows.filter((x) => x.state === 'missing') };
}

/* "until a valid document is uploaded and verified": for an APPROVED driver, a date moved LATER is accepted
   only if the OAVCT photo itself was replaced in the renewal window (from 45 days before the old date). A
   date typed without a new photo would lift the hold on paper only. -> null (ok) | 'new_photo_first' */
async function renewalCheck(driverId, newExpiry) {
  const r = await pool.query(`SELECT d.status, d.oavct_expiry,
       (SELECT created_at FROM driver_documents dd WHERE dd.driver_id = d.id AND dd.doc_type = 'oavct') AS photo_at
       FROM drivers d WHERE d.id = $1`, [driverId]);
  const d = r.rows[0];
  if (!d || d.status !== 'approved' || !d.oavct_expiry) return null;
  const oldE = new Date(d.oavct_expiry), newE = new Date(newExpiry + 'T00:00:00Z');
  if (!(newE > oldE)) return null;
  const from = new Date(oldE.getTime() - 45 * 86400000);
  return d.photo_at && new Date(d.photo_at) >= from ? null : 'new_photo_first';
}

module.exports = { heldSql, TODAY, state, isHeld, sweep, overview, renewalCheck, MSG };
