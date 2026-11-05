/* ONE DRIVER, ONE JOB (5 Nov 2026), the MsouWout half. A driver on an unfinished MyPlopPlop job (a parcel
   or a shop delivery) holds a row in driver_job_locks (services/jobLock.js) and is shown no passenger ride.
   This file only asks MyPlopPlop (shared INTERNAL_SERVICE_KEY, its routes/internalJobs.js) which jobs are
   still open for a driver, so a lock whose job has ended can be cleared.
   No answer = { ok:false }: the lock is KEPT ("refuse a new assignment until it can confirm the driver is free"). */
const MPP = process.env.KOUTYE_API_URL || 'https://myplopplop-api.onrender.com';

async function jobsOnMpp(driverId) {
  const key = process.env.INTERNAL_SERVICE_KEY;
  if (!key || !driverId) return { ok: false };
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 8000);
  try {
    const r = await fetch(MPP + '/api/internal/driver-busy?msouwout_id=' + encodeURIComponent(driverId),
      { headers: { 'x-internal-key': key }, signal: ctl.signal });
    if (!r.ok) return { ok: false };
    const j = await r.json().catch(() => null);
    if (!j || !Array.isArray(j.jobs)) return { ok: false };
    return { ok: true, jobs: j.jobs.map(String) };
  } catch (e) {
    return { ok: false };
  } finally { clearTimeout(t); }
}

module.exports = { jobsOnMpp };
