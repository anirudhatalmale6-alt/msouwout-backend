const pool = require('../db/pool');

/**
 * Ray-casting point-in-polygon algorithm.
 * Checks if a point [lng, lat] is inside a polygon defined by coordinates array.
 */
function pointInPolygon(lng, lat, polygon) {
  const coords = polygon.coordinates[0]; // outer ring
  let inside = false;
  for (let i = 0, j = coords.length - 1; i < coords.length; j = i++) {
    const xi = coords[i][0], yi = coords[i][1];
    const xj = coords[j][0], yj = coords[j][1];
    const intersect = ((yi > lat) !== (yj > lat)) &&
      (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * Check if a line segment intersects a polygon.
 * Uses simplified check: test multiple points along the line.
 */
function lineIntersectsPolygon(lng1, lat1, lng2, lat2, polygon) {
  const steps = 20;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const lng = lng1 + t * (lng2 - lng1);
    const lat = lat1 + t * (lat2 - lat1);
    if (pointInPolygon(lng, lat, polygon)) return true;
  }
  return false;
}

/**
 * Check if a point falls within any active zone of a given type.
 */
async function findZoneForPoint(lat, lng, serviceType = 'both') {
  const result = await pool.query(`
    SELECT id, name, zone_type, service_rule, active_from, active_until, active_days, geometry
    FROM zones
    WHERE is_active = true
      AND (service_rule = 'both' OR service_rule = $1)
    ORDER BY
      CASE zone_type
        WHEN 'red' THEN 1
        WHEN 'yellow' THEN 2
        WHEN 'green' THEN 3
      END
  `, [serviceType]);

  return result.rows.filter(zone => {
    const geojson = typeof zone.geometry === 'string' ? JSON.parse(zone.geometry) : zone.geometry;
    return pointInPolygon(lng, lat, geojson);
  });
}

/**
 * Check if a zone is currently active based on time rules.
 */
function isZoneActiveNow(zone) {
  if (!zone.active_from && !zone.active_until) return true;

  const now = new Date();
  const currentTime = now.getHours() * 60 + now.getMinutes();
  const currentDay = now.getDay();

  if (zone.active_days && zone.active_days.length > 0) {
    if (!zone.active_days.includes(currentDay)) return false;
  }

  if (zone.active_from && zone.active_until) {
    const [fromH, fromM] = zone.active_from.split(':').map(Number);
    const [toH, toM] = zone.active_until.split(':').map(Number);
    const fromMinutes = fromH * 60 + fromM;
    const toMinutes = toH * 60 + toM;

    if (fromMinutes <= toMinutes) {
      return currentTime >= fromMinutes && currentTime <= toMinutes;
    } else {
      return currentTime >= fromMinutes || currentTime <= toMinutes;
    }
  }

  return true;
}

/**
 * Validate a trip request.
 */
async function validateTrip(pickupLat, pickupLng, destLat, destLng, serviceType = 'ride') {
  const svcType = serviceType === 'delivery' ? 'delivery' : 'ride';

  const pickupZones = await findZoneForPoint(pickupLat, pickupLng, svcType);
  const pickupResult = evaluatePoint(pickupZones, 'pickup');

  if (pickupResult.blocked) {
    return {
      allowed: false,
      status: 'rejected',
      reason: pickupResult.reason,
      details: { pickup: pickupResult, destination: null }
    };
  }

  const destZones = await findZoneForPoint(destLat, destLng, svcType);
  const destResult = evaluatePoint(destZones, 'destination');

  if (destResult.blocked) {
    return {
      allowed: false,
      status: 'rejected',
      reason: destResult.reason,
      details: { pickup: pickupResult, destination: destResult }
    };
  }

  const routeCrossesRed = await checkRouteCrossesRedZone(
    pickupLat, pickupLng, destLat, destLng, svcType
  );

  if (routeCrossesRed) {
    return {
      allowed: false,
      status: 'rejected',
      reason: 'Route crosses a restricted area. Please choose a different destination.',
      details: { pickup: pickupResult, destination: destResult, route_blocked: true }
    };
  }

  if (pickupResult.needsApproval || destResult.needsApproval) {
    return {
      allowed: false,
      status: 'manual_review',
      reason: 'Trip requires manual approval from an operator.',
      details: { pickup: pickupResult, destination: destResult }
    };
  }

  return {
    allowed: true,
    status: 'approved',
    reason: 'Trip is within approved service zones.',
    details: {
      pickup: pickupResult,
      destination: destResult,
      pickup_zone_id: pickupResult.zoneId,
      destination_zone_id: destResult.zoneId
    }
  };
}

function evaluatePoint(zones, label) {
  if (zones.length === 0) {
    return {
      blocked: true,
      needsApproval: false,
      reason: `${label === 'pickup' ? 'Pickup' : 'Destination'} location is outside all service zones.`,
      zoneId: null,
      zoneType: null
    };
  }

  const redZone = zones.find(z => z.zone_type === 'red');
  if (redZone && isZoneActiveNow(redZone)) {
    return {
      blocked: true,
      needsApproval: false,
      reason: `${label === 'pickup' ? 'Pickup' : 'Destination'} is in a restricted area (${redZone.name}).`,
      zoneId: redZone.id,
      zoneType: 'red'
    };
  }

  const yellowZone = zones.find(z => z.zone_type === 'yellow');
  if (yellowZone && isZoneActiveNow(yellowZone)) {
    const greenZone = zones.find(z => z.zone_type === 'green' && isZoneActiveNow(z));
    if (!greenZone) {
      return {
        blocked: false,
        needsApproval: true,
        reason: `${label === 'pickup' ? 'Pickup' : 'Destination'} is in a zone requiring manual approval (${yellowZone.name}).`,
        zoneId: yellowZone.id,
        zoneType: 'yellow'
      };
    }
  }

  const greenZone = zones.find(z => z.zone_type === 'green' && isZoneActiveNow(z));
  if (greenZone) {
    return {
      blocked: false,
      needsApproval: false,
      reason: 'OK',
      zoneId: greenZone.id,
      zoneType: 'green'
    };
  }

  return {
    blocked: true,
    needsApproval: false,
    reason: `Service is not available at ${label === 'pickup' ? 'pickup' : 'destination'} location at this time.`,
    zoneId: zones[0].id,
    zoneType: zones[0].zone_type
  };
}

/**
 * Check if a straight-line route crosses any red zone.
 */
async function checkRouteCrossesRedZone(lat1, lng1, lat2, lng2, serviceType) {
  const result = await pool.query(`
    SELECT id, name, geometry FROM zones
    WHERE is_active = true
      AND zone_type = 'red'
      AND (service_rule = 'both' OR service_rule = $1)
  `, [serviceType]);

  for (const zone of result.rows) {
    const geojson = typeof zone.geometry === 'string' ? JSON.parse(zone.geometry) : zone.geometry;
    if (lineIntersectsPolygon(lng1, lat1, lng2, lat2, geojson)) {
      return true;
    }
  }
  return false;
}

module.exports = { validateTrip, findZoneForPoint, isZoneActiveNow, pointInPolygon };
