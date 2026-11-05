/* ONE DRIVER, ONE JOB - the lock (5 Nov 2026). Jeffery: "I want the one-job-at-a-time rule guaranteed even
   when one server is temporarily unavailable. If either server cannot verify the driver's availability, the
   system must refuse a new assignment until it can confirm the driver is free."

   MsouWout owns the driver identity, so it holds the lock (table driver_job_locks, one row per driver):
     - MyPlopPlop gets the row here (POST /api/rides/internal/lock) before a parcel or shop delivery is his;
       no answer from here = MyPlopPlop refuses the job.
     - A passenger accept is refused while the row exists. Both sides take the driver row FOR UPDATE, so a
       lock and a passenger accept in the same instant cannot both win.
     - MyPlopPlop releases the row when the job ends (and re-sends releases every 10 s until they land).
       A row left behind is cleared only when MyPlopPlop itself says that job is over; if MyPlopPlop cannot
       be asked, the row stays and the driver gets no passenger ride ("refuse until it can confirm"). */
const pool = require('../db/pool');
const JOB = /^[A-Za-z0-9:_-]{1,64}$/;

async function current(driverId) {
  const r = await pool.query('SELECT job_id, source, created_at FROM driver_job_locks WHERE driver_id = $1', [driverId]);
  return r.rows[0] || null;
}

/* -> { ok:true } | { ok:false, reason:'not_found'|'on_ride'|'other_job', ... } */
async function acquire(driverId, jobId, source) {
  if (!JOB.test(String(jobId || ''))) return { ok: false, reason: 'bad_job' };
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const d = await c.query('SELECT id FROM drivers WHERE id = $1 FOR UPDATE', [driverId]);
    if (!d.rows.length) { await c.query('ROLLBACK'); return { ok: false, reason: 'not_found' }; }
    const held = (await c.query(`SELECT ${require('./oavctWatch').heldSql('d')} AS h FROM drivers d WHERE id = $1`, [driverId])).rows[0].h;
    if (held) { await c.query('ROLLBACK'); return { ok: false, reason: 'oavct_expired' }; }
    const ride = await c.query(`SELECT tracking_code FROM ride_requests WHERE driver_id = $1 AND status IN ('accepted','in_progress') LIMIT 1`, [driverId]);
    if (ride.rows.length) { await c.query('ROLLBACK'); return { ok: false, reason: 'on_ride', ride: ride.rows[0].tracking_code }; }
    const lockRow = await c.query('SELECT job_id FROM driver_job_locks WHERE driver_id = $1', [driverId]);
    if (lockRow.rows.length && lockRow.rows[0].job_id !== jobId) { await c.query('ROLLBACK'); return { ok: false, reason: 'other_job', job_id: lockRow.rows[0].job_id }; }
    if (!lockRow.rows.length) await c.query('INSERT INTO driver_job_locks (driver_id, source, job_id) VALUES ($1, $2, $3)', [driverId, source || 'mpp', jobId]);
    await c.query('COMMIT');
    return { ok: true };
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { c.release(); }
}

async function release(driverId, jobId) {
  const r = await pool.query('DELETE FROM driver_job_locks WHERE driver_id = $1 AND job_id = $2', [driverId, String(jobId || '')]);
  return r.rowCount;
}

/* A row whose job MyPlopPlop says is over is removed. -> 'free' | 'busy' | 'unverified' */
const healSeen = new Map();
async function heal(driverId, opts) {
  const row = await current(driverId);
  if (!row) return 'free';
  if (opts && opts.cached) {
    const c = healSeen.get(driverId);
    if (c && c.job === row.job_id && Date.now() - c.at < 20000) return c.v;
  }
  const mpp = await require('./mppJobs').jobsOnMpp(driverId);
  let v;
  if (!mpp.ok) v = 'unverified';
  else if (mpp.jobs.indexOf(row.job_id) !== -1) v = 'busy';
  else { await release(driverId, row.job_id); v = (await current(driverId)) ? 'busy' : 'free'; }
  healSeen.set(driverId, { at: Date.now(), job: row.job_id, v });
  if (healSeen.size > 2000) healSeen.clear();
  return v;
}

module.exports = { acquire, release, current, heal };
