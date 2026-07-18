const pool = require('../db/pool');

// ── Confirmed fare + money model (Jeffery, 2026-07-18) ──────────────────────
// Per-vehicle fare = base + (distance_km × per_km), × single highest surge,
// floored at the vehicle minimum. Commission 20% MsouWout / 80% driver.
// DASH Protection is a FLAT 25 HTG per completed ride: 12.50 from the rider
// (added on top of the fare) + 12.50 from the driver (deducted from his share).
// The 25 pot splits 80% to the DASH medical fund (20) / 20% to MsouWout (5).
// Only ONE surge applies at a time — the highest applicable, never stacked.
const DEFAULT_CONFIG = {
  // Base + per-km + minimum, per vehicle
  base_fare_moto: 175,
  base_fare_car: 200,
  price_per_km_moto: 40,
  price_per_km_car: 60,
  minimum_fare_moto: 200,
  minimum_fare_car: 250,
  // Waiting fee (charged per minute after the free window; applied by the driver app)
  waiting_per_min_moto: 5,
  waiting_per_min_car: 8,
  waiting_free_min: 3,
  // Money split
  commission_rate: 0.20,        // MsouWout share of the fare
  dash_fee_rider: 12.5,         // rider pays on top of the fare
  dash_fee_driver: 12.5,        // deducted from the driver share
  dash_msouwout_share: 0.20,    // MsouWout cut of the 25 HTG DASH pot (→ 5); rest (20) to DASH fund
  road_factor: 1.30,            // straight-line → road distance factor
  // Cancellation
  cancel_fee: 50,               // charged to rider after the grace window, paid to the driver
  cancel_grace_sec: 120,        // free-cancel window after a driver accepts
  // Surge — expressed as a fraction added (0.15 = +15%). Single highest applies.
  dynamic_pricing: 1,
  surge_peak_moto: 0.15,
  surge_peak_car: 0.15,
  surge_night_moto: 0.15,
  surge_night_car: 0.15,
  surge_demand_moto: 0.20,
  surge_demand_car: 0.25,
  surge_rain_moto: 0.20,
  surge_rain_car: 0.25,
  peak_morning_start: 7,
  peak_morning_end: 9,
  peak_evening_start: 16,
  peak_evening_end: 19,
  night_start: 22,
  night_end: 5,
  demand_threshold: 5,
  max_surge_pct: 0.50
};

let weatherCache = { rain: false, ts: 0 };
const WEATHER_TTL = 10 * 60 * 1000;
const PAP_LAT = 18.54;
const PAP_LNG = -72.34;

async function checkRain() {
  if (Date.now() - weatherCache.ts < WEATHER_TTL) return weatherCache.rain;
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${PAP_LAT}&longitude=${PAP_LNG}&current=rain,showers&timezone=America/Port-au-Prince`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(4000) });
    const data = await resp.json();
    const rain = (data.current?.rain || 0) > 0 || (data.current?.showers || 0) > 0;
    weatherCache = { rain, ts: Date.now() };
    return rain;
  } catch (err) {
    console.error('Weather check failed:', err.message);
    return weatherCache.rain;
  }
}

async function getActiveRideCount() {
  try {
    const result = await pool.query(
      `SELECT COUNT(*) FROM ride_requests WHERE status IN ('searching','accepted','in_progress') AND created_at > NOW() - INTERVAL '30 minutes'`
    );
    return parseInt(result.rows[0].count) || 0;
  } catch (err) {
    return 0;
  }
}

// Returns the SINGLE highest applicable surge for a vehicle (never stacked).
// { multiplier, pct, type, factors } — multiplier is 1 + pct.
async function getDynamicSurge(config, rideType) {
  const v = rideType === 'car' ? 'car' : 'moto';
  if (!config.dynamic_pricing) {
    return { multiplier: 1.0, pct: 0, type: null, factors: [] };
  }

  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Port-au-Prince' }));
  const hour = now.getHours();
  const candidates = [];

  const isPeakMorning = hour >= config.peak_morning_start && hour < config.peak_morning_end;
  const isPeakEvening = hour >= config.peak_evening_start && hour < config.peak_evening_end;
  if (isPeakMorning || isPeakEvening) {
    candidates.push({ type: 'peak_traffic', label: 'Trafik wo', pct: config[`surge_peak_${v}`] });
  }

  const isNight = hour >= config.night_start || hour < config.night_end;
  if (isNight) {
    candidates.push({ type: 'night', label: 'Lannwit', pct: config[`surge_night_${v}`] });
  }

  const isRaining = await checkRain();
  if (isRaining) {
    candidates.push({ type: 'rain', label: 'Lapli', pct: config[`surge_rain_${v}`] });
  }

  const activeRides = await getActiveRideCount();
  if (activeRides >= config.demand_threshold) {
    candidates.push({ type: 'demand', label: 'Demand wo', pct: config[`surge_demand_${v}`], active_rides: activeRides });
  }

  // Apply only the single highest surge, capped at max.
  let best = { type: null, label: null, pct: 0 };
  for (const c of candidates) {
    if ((c.pct || 0) > best.pct) best = c;
  }
  if (best.pct > config.max_surge_pct) best.pct = config.max_surge_pct;
  const multiplier = parseFloat((1 + best.pct).toFixed(2));

  return {
    multiplier,
    pct: best.pct,
    type: best.type,
    factors: candidates,
    hour,
    active_rides: activeRides,
    raining: isRaining
  };
}

async function getPricingConfig() {
  try {
    const result = await pool.query(
      `SELECT value FROM service_config WHERE key = 'pricing'`
    );
    if (result.rows.length > 0) {
      const stored = typeof result.rows[0].value === 'string'
        ? JSON.parse(result.rows[0].value) : result.rows[0].value;
      return { ...DEFAULT_CONFIG, ...stored };
    }
  } catch (err) {
    console.error('Error fetching pricing config:', err.message);
  }
  return DEFAULT_CONFIG;
}

async function savePricingConfig(config) {
  const merged = { ...DEFAULT_CONFIG, ...config };
  await pool.query(
    `INSERT INTO service_config (key, value, updated_at)
     VALUES ('pricing', $1, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
    [JSON.stringify(merged)]
  );
  return merged;
}

function haversineDistance(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function estimateDuration(distanceKm) {
  const avgSpeedKmh = 25;
  return Math.round((distanceKm / avgSpeedKmh) * 60);
}

// Fare = (base + distance×per_km) × surge, floored at the vehicle minimum.
function calculatePrice(rideType, distanceKm, config, surgeMultiplier) {
  const v = rideType === 'car' ? 'car' : 'moto';
  const base = config[`base_fare_${v}`];
  const perKm = config[`price_per_km_${v}`];
  const min = config[`minimum_fare_${v}`];
  const surge = surgeMultiplier || 1.0;

  let price = (base + distanceKm * perKm) * surge;
  if (price < min) price = min;
  return Math.round(price);
}

// MsouWout commission (20%) / driver gross (80%) of the fare.
function calculateCommission(price, config) {
  const rate = (config && config.commission_rate) || DEFAULT_CONFIG.commission_rate;
  const platformFee = Math.round(price * rate);
  const driverEarning = price - platformFee;
  return { platform_fee: platformFee, driver_earning: driverEarning, commission_rate: rate };
}

// DASH Protection — flat 25 HTG pot per completed ride (12.50 rider + 12.50 driver),
// split 80% DASH fund (20) / 20% MsouWout (5). No percentage of the fare.
function calculateMedicalFee(price, config) {
  const cfg = config || DEFAULT_CONFIG;
  const riderShare = cfg.dash_fee_rider;      // 12.5
  const driverShare = cfg.dash_fee_driver;    // 12.5
  const pot = riderShare + driverShare;       // 25
  const msouwoutFee = Math.round(pot * cfg.dash_msouwout_share); // 5
  const dashFee = pot - msouwoutFee;          // 20

  return {
    medical_fee: pot,                 // 25 — full DASH pot
    dash_fee: dashFee,                // 20 — to DASH medical fund
    msouwout_medical_fee: msouwoutFee,// 5  — MsouWout cut of DASH
    rider_share: riderShare,          // 12.5 — added to rider total
    driver_share: driverShare         // 12.5 — deducted from driver
  };
}

async function calculateRide(pickupLat, pickupLng, dropoffLat, dropoffLng, rideType) {
  const config = await getPricingConfig();
  const surge = await getDynamicSurge(config, rideType);

  const straight = haversineDistance(pickupLat, pickupLng, dropoffLat, dropoffLng);
  const distanceKm = parseFloat((straight * config.road_factor).toFixed(1));
  const durationMin = estimateDuration(distanceKm);
  const price = calculatePrice(rideType, distanceKm, config, surge.multiplier);
  const basePrice = calculatePrice(rideType, distanceKm, config, 1.0);
  const commission = calculateCommission(price, config);
  const v = rideType === 'car' ? 'car' : 'moto';

  return {
    distance_km: distanceKm,
    duration_min: durationMin,
    ride_type: rideType,
    price,
    base_price: basePrice,
    breakdown: {
      base_fare: config[`base_fare_${v}`],
      distance_charge: Math.round(distanceKm * config[`price_per_km_${v}`]),
      minimum_fare: config[`minimum_fare_${v}`],
      surge_multiplier: surge.multiplier,
      surge_type: surge.type,
      surge_factors: surge.factors
    },
    commission,
    currency: 'HTG'
  };
}

module.exports = {
  getPricingConfig,
  savePricingConfig,
  calculatePrice,
  calculateCommission,
  calculateMedicalFee,
  calculateRide,
  getDynamicSurge,
  haversineDistance,
  estimateDuration,
  DEFAULT_CONFIG
};
