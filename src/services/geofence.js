const pool = require('../db/pool');

/**
 * Check if a point falls within any active zone of a given type.
 * Returns the zone if found, null otherwise.
 */
async function findZoneForPoint(lat, lng, serviceType = 'both') {
  const query = `
    SELECT id, name, zone_type, service_rule, active_from, active_until, active_days
    FROM zones
    WHERE is_active = true
      AND ST_Contains(geometry, ST_SetSRID(ST_Point($1, $2), 4326))
      AND (service_rule = 'both' OR service_rule = $3)
    ORDER BY
      CASE zone_type
        WHEN 'red' THEN 1
        WHEN 'yellow' THEN 2
        WHEN 'green' THEN 3
      END
  `;
  const result = await pool.query(query, [lng, lat, serviceType]);
  return result.rows;
}

/**
 * Check if a zone is currently active based on time rules.
 */
function isZoneActiveNow(zone) {
  if (!zone.active_from && !zone.active_until) return true;

  const now = new Date();
  const currentTime = now.getHours() * 60 + now.getMinutes();
  const currentDay = now.getDay(); // 0=Sun

  // Check day restriction
  if (zone.active_days && zone.active_days.length > 0) {
    if (!zone.active_days.includes(currentDay)) return false;
  }

  // Check time restriction
  if (zone.active_from && zone.active_until) {
    const [fromH, fromM] = zone.active_from.split(':').map(Number);
    const [toH, toM] = zone.active_until.split(':').map(Number);
    const fromMinutes = fromH * 60 + fromM;
    const toMinutes = toH * 60 + toM;

    if (fromMinutes <= toMinutes) {
      return currentTime >= fromMinutes && currentTime <= toMinutes;
    } else {
      // Overnight range (e.g., 22:00 - 06:00)
      return currentTime >= fromMinutes || currentTime <= toMinutes;
    }
  }

  return true;
}

/**
 * Validate a trip request.
 * Returns { allowed: boolean, status: string, reason: string, details: object }
 */
async function validateTrip(pickupLat, pickupLng, destLat, destLng, serviceType = 'ride') {
  const svcType = serviceType === 'delivery' ? 'delivery' : 'ride';

  // 1. Check pickup point
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

  // 2. Check destination point
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

  // 3. Check if route crosses any red zones
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

  // 4. Determine final status
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

  // Red zones take priority
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

  // Yellow = manual approval
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

  // Green = allowed
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

  // Has zones but none active right now (time restriction)
  return {
    blocked: true,
    needsApproval: false,
    reason: `Service is not available at ${label === 'pickup' ? 'pickup' : 'destination'} location at this time.`,
    zoneId: zones[0].id,
    zoneType: zones[0].zone_type
  };
}

/**
 * Check if a straight-line route between two points crosses any red zone.
 */
async function checkRouteCrossesRedZone(lat1, lng1, lat2, lng2, serviceType) {
  const query = `
    SELECT id, name FROM zones
    WHERE is_active = true
      AND zone_type = 'red'
      AND (service_rule = 'both' OR service_rule = $5)
      AND ST_Intersects(
        geometry,
        ST_SetSRID(ST_MakeLine(ST_Point($1, $2), ST_Point($3, $4)), 4326)
      )
    LIMIT 1
  `;
  const result = await pool.query(query, [lng1, lat1, lng2, lat2, serviceType]);
  return result.rows.length > 0;
}

module.exports = { validateTrip, findZoneForPoint, isZoneActiveNow };
