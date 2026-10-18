/* DRIVER SCORES (18 Oct 2026).
 * Jeffery: "The passenger can leave a 5 star or 1 star."
 * One rating per ride, from the passenger who booked it (her private owner
 * key), only on a COMPLETED ride. A score is information for the driver and
 * for the administrator - nothing here blocks or punishes anybody by itself.
 */
const pool = require('../db/pool');

/* Below this average (with enough ratings to mean something) a driver is put
   in front of a person. Jeffery decides what happens next. */
const LOW_SCORE = Number(process.env.MW_LOW_SCORE || 3.5);
const MIN_RATINGS = Number(process.env.MW_LOW_SCORE_MIN || 3);

async function driverScore(driverId) {
  if (!driverId) return { avg: null, count: 0 };
  const r = await pool.query(
    `SELECT ROUND(AVG(stars)::numeric, 1) AS avg, COUNT(*)::int AS count
       FROM ride_ratings WHERE driver_id = $1`, [driverId]);
  const row = r.rows[0] || {};
  return { avg: row.count ? Number(row.avg) : null, count: row.count || 0 };
}

async function allScores() {
  const r = await pool.query(
    `SELECT d.id, d.full_name, d.phone, d.vehicle_type, d.status,
            ROUND(AVG(x.stars)::numeric, 1) AS avg, COUNT(x.*)::int AS count,
            COUNT(x.*) FILTER (WHERE x.stars <= 2)::int AS low_count,
            MAX(x.created_at) AS last_at,
            (SELECT y.comment FROM ride_ratings y WHERE y.driver_id = d.id AND COALESCE(y.comment,'') <> ''
              ORDER BY y.created_at DESC LIMIT 1) AS last_comment
       FROM drivers d JOIN ride_ratings x ON x.driver_id = d.id
      WHERE NOT COALESCE(d.is_test_account, false)
      GROUP BY d.id ORDER BY AVG(x.stars) ASC, COUNT(x.*) DESC`);
  return r.rows.map(function (x) { return Object.assign({}, x, { avg: Number(x.avg) }); });
}

async function lowScores() {
  return (await allScores()).filter(function (x) { return x.count >= MIN_RATINGS && x.avg < LOW_SCORE; });
}

module.exports = { driverScore, allScores, lowScores, LOW_SCORE, MIN_RATINGS };
