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
  surge_multiplier: 1.0
};

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
  const distanceKm = parseFloat(haversineDistance(pickupLat, pickupLng, dropoffLat, dropoffLng).toFixed(1));
  const durationMin = estimateDuration(distanceKm);
  const price = calculatePrice(rideType, distanceKm, durationMin, config);
  const commission = calculateCommission(price, config);

  const variance = Math.round(price * 0.08);

  return {
    distance_km: distanceKm,
    duration_min: durationMin,
    ride_type: rideType,
    price,
    price_range: {
      min: price - variance,
      max: price + variance
    },
    breakdown: {
      base_fare: rideType === 'car' ? config.base_fare_car : config.base_fare_moto,
      distance_charge: Math.round(distanceKm * (rideType === 'car' ? config.price_per_km_car : config.price_per_km_moto) * (config.gas_price / config.baseline_gas_price)),
      time_charge: Math.round(durationMin * config.price_per_min),
      security_fee: config.security_fee,
      surge_multiplier: config.surge_multiplier || 1.0
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
  haversineDistance,
  estimateDuration,
  DEFAULT_CONFIG
};
