const pool = require('../db/pool');

const DEFAULT_CONFIG = {
  base_fare_car: 75,
  base_fare_moto: 50,
  price_per_km_car: 35,
  price_per_km_moto: 25,
  price_per_min: 5,
  security_fee: 25,
  minimum_fare: 100,
  gas_price: 725,
  baseline_gas_price: 500,
  commission_rate: 0.15,
  surge_multiplier: 1.0,
  dynamic_pricing: true,
  peak_morning_start: 7,
  peak_morning_end: 9,
  peak_evening_start: 16,
  peak_evening_end: 19,
  night_start: 22,
  night_end: 5,
  peak_surge: 1.15,
  night_surge: 1.20,
  rain_surge: 1.10,
  high_demand_surge: 1.15,
  demand_threshold: 5,
  max_surge: 1.50
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

async function getDynamicSurge(config) {
  if (!config.dynamic_pricing) return { multiplier: config.surge_multiplier || 1.0, factors: [] };

  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Port-au-Prince' }));
  const hour = now.getHours();
  let multiplier = 1.0;
  const factors = [];

  const isPeakMorning = hour >= config.peak_morning_start && hour < config.peak_morning_end;
  const isPeakEvening = hour >= config.peak_evening_start && hour < config.peak_evening_end;
  if (isPeakMorning || isPeakEvening) {
    multiplier *= config.peak_surge;
    factors.push({ type: 'peak_traffic', label: 'Trafik wo', boost: config.peak_surge });
  }

  const isNight = hour >= config.night_start || hour < config.night_end;
  if (isNight) {
    multiplier *= config.night_surge;
    factors.push({ type: 'night', label: 'Lannwit', boost: config.night_surge });
  }

  const isRaining = await checkRain();
  if (isRaining) {
    multiplier *= config.rain_surge;
    factors.push({ type: 'rain', label: 'Lapli', boost: config.rain_surge });
  }

  const activeRides = await getActiveRideCount();
  if (activeRides >= config.demand_threshold) {
    multiplier *= config.high_demand_surge;
    factors.push({ type: 'demand', label: 'Demand wo', boost: config.high_demand_surge, active_rides: activeRides });
  }

  if (multiplier > config.max_surge) multiplier = config.max_surge;
  multiplier = parseFloat(multiplier.toFixed(2));

  return { multiplier, factors, hour, active_rides: activeRides, raining: isRaining };
}

async function getPricingConfig() {
  try {
    const result = await pool.query(
      `SELECT value FROM service_config WHERE key = 'pricing'`
    );
    if (result.rows.length > 0) {
      return { ...DEFAULT_CONFIG, ...result.rows[0].value };
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

function calculatePrice(rideType, distanceKm, durationMin, config) {
  const baseFare = rideType === 'car' ? config.base_fare_car : config.base_fare_moto;
  const pricePerKm = rideType === 'car' ? config.price_per_km_car : config.price_per_km_moto;
  const fuelFactor = config.gas_price / config.baseline_gas_price;
  const surge = config.surge_multiplier || 1.0;

  let price = baseFare +
    (distanceKm * pricePerKm * fuelFactor) +
    (durationMin * config.price_per_min) +
    config.security_fee;

  price = price * surge;

  if (price < config.minimum_fare) {
    price = config.minimum_fare;
  }

  return Math.round(price);
}

function calculateCommission(price, config) {
  const rate = config.commission_rate || 0.15;
  const platformFee = Math.round(price * rate);
  const driverEarning = price - platformFee;
  return { platform_fee: platformFee, driver_earning: driverEarning, commission_rate: rate };
}

async function calculateRide(pickupLat, pickupLng, dropoffLat, dropoffLng, rideType) {
  const config = await getPricingConfig();
  const surge = await getDynamicSurge(config);
  const dynamicConfig = { ...config, surge_multiplier: surge.multiplier };

  const distanceKm = parseFloat(haversineDistance(pickupLat, pickupLng, dropoffLat, dropoffLng).toFixed(1));
  const durationMin = estimateDuration(distanceKm);
  const price = calculatePrice(rideType, distanceKm, durationMin, dynamicConfig);
  const basePrice = calculatePrice(rideType, distanceKm, durationMin, { ...config, surge_multiplier: 1.0 });
  const commission = calculateCommission(price, dynamicConfig);

  const variance = Math.round(price * 0.08);

  return {
    distance_km: distanceKm,
    duration_min: durationMin,
    ride_type: rideType,
    price,
    base_price: basePrice,
    price_range: {
      min: price - variance,
      max: price + variance
    },
    breakdown: {
      base_fare: rideType === 'car' ? config.base_fare_car : config.base_fare_moto,
      distance_charge: Math.round(distanceKm * (rideType === 'car' ? config.price_per_km_car : config.price_per_km_moto) * (config.gas_price / config.baseline_gas_price)),
      time_charge: Math.round(durationMin * config.price_per_min),
      security_fee: config.security_fee,
      surge_multiplier: surge.multiplier,
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
  calculateRide,
  getDynamicSurge,
  haversineDistance,
  estimateDuration,
  DEFAULT_CONFIG
};
