-- MsouWout Initial Launch Zones - Haiti Rides
-- Service: Restricted daytime operation (06:00 - 18:00)
-- All zones: Green (SERVICE_ALLOWED), rides only, daytime only, verified drivers required

-- Clear existing zones for fresh seed
-- DELETE FROM zones;

-- 1. TURGEAU - Residential/commercial area south of Champ de Mars
INSERT INTO zones (name, description, zone_type, service_rule, is_active, active_from, active_until, active_days, geometry, created_by)
VALUES (
  'Turgeau',
  'Residential and commercial zone south of Champ de Mars. Initial launch zone.',
  'green', 'ride', true, '06:00', '18:00', NULL,
  ST_SetSRID(ST_GeomFromGeoJSON('{
    "type": "Polygon",
    "coordinates": [[
      [-72.3380, 18.5380],
      [-72.3310, 18.5380],
      [-72.3280, 18.5340],
      [-72.3290, 18.5300],
      [-72.3350, 18.5280],
      [-72.3400, 18.5300],
      [-72.3410, 18.5340],
      [-72.3380, 18.5380]
    ]]
  }'), 4326),
  'system_seed'
);

-- 2. CANAPE VERT - Major commercial corridor east of Turgeau
INSERT INTO zones (name, description, zone_type, service_rule, is_active, active_from, active_until, active_days, geometry, created_by)
VALUES (
  'Canape Vert',
  'Commercial corridor with hospitals and businesses. Initial launch zone.',
  'green', 'ride', true, '06:00', '18:00', NULL,
  ST_SetSRID(ST_GeomFromGeoJSON('{
    "type": "Polygon",
    "coordinates": [[
      [-72.3280, 18.5400],
      [-72.3200, 18.5410],
      [-72.3170, 18.5370],
      [-72.3180, 18.5320],
      [-72.3230, 18.5300],
      [-72.3290, 18.5310],
      [-72.3300, 18.5360],
      [-72.3280, 18.5400]
    ]]
  }'), 4326),
  'system_seed'
);

-- 3. BOURDON - Upscale residential area west of Petion-Ville road
INSERT INTO zones (name, description, zone_type, service_rule, is_active, active_from, active_until, active_days, geometry, created_by)
VALUES (
  'Bourdon',
  'Upscale residential area with embassies and international organizations. Initial launch zone.',
  'green', 'ride', true, '06:00', '18:00', NULL,
  ST_SetSRID(ST_GeomFromGeoJSON('{
    "type": "Polygon",
    "coordinates": [[
      [-72.3310, 18.5300],
      [-72.3240, 18.5310],
      [-72.3200, 18.5270],
      [-72.3210, 18.5220],
      [-72.3270, 18.5200],
      [-72.3330, 18.5220],
      [-72.3340, 18.5260],
      [-72.3310, 18.5300]
    ]]
  }'), 4326),
  'system_seed'
);

-- 4. JUVENAT - Residential area near Petion-Ville
INSERT INTO zones (name, description, zone_type, service_rule, is_active, active_from, active_until, active_days, geometry, created_by)
VALUES (
  'Juvenat',
  'Residential neighborhood near Petion-Ville. Schools and institutions. Initial launch zone.',
  'green', 'ride', true, '06:00', '18:00', NULL,
  ST_SetSRID(ST_GeomFromGeoJSON('{
    "type": "Polygon",
    "coordinates": [[
      [-72.3120, 18.5260],
      [-72.3050, 18.5270],
      [-72.3020, 18.5230],
      [-72.3030, 18.5180],
      [-72.3080, 18.5160],
      [-72.3140, 18.5180],
      [-72.3150, 18.5220],
      [-72.3120, 18.5260]
    ]]
  }'), 4326),
  'system_seed'
);

-- 5. DELMAS 19 TO PETION-VILLE CORRIDOR - Major transit corridor
INSERT INTO zones (name, description, zone_type, service_rule, is_active, active_from, active_until, active_days, geometry, created_by)
VALUES (
  'Delmas 19 to Petion-Ville Corridor',
  'Major transit corridor connecting Delmas 19 through to Petion-Ville center. Corridor polygon.',
  'green', 'ride', true, '06:00', '18:00', NULL,
  ST_SetSRID(ST_GeomFromGeoJSON('{
    "type": "Polygon",
    "coordinates": [[
      [-72.3200, 18.5430],
      [-72.3050, 18.5380],
      [-72.2920, 18.5280],
      [-72.2870, 18.5190],
      [-72.2850, 18.5130],
      [-72.2890, 18.5100],
      [-72.2950, 18.5150],
      [-72.3000, 18.5240],
      [-72.3100, 18.5330],
      [-72.3240, 18.5400],
      [-72.3200, 18.5430]
    ]]
  }'), 4326),
  'system_seed'
);

-- 6. MONTAGNE NOIRE - Upscale hillside area above Petion-Ville
INSERT INTO zones (name, description, zone_type, service_rule, is_active, active_from, active_until, active_days, geometry, created_by)
VALUES (
  'Montagne Noire',
  'Upscale hillside residential area above Petion-Ville. Initial launch zone.',
  'green', 'ride', true, '06:00', '18:00', NULL,
  ST_SetSRID(ST_GeomFromGeoJSON('{
    "type": "Polygon",
    "coordinates": [[
      [-72.2950, 18.5130],
      [-72.2880, 18.5140],
      [-72.2840, 18.5090],
      [-72.2850, 18.5030],
      [-72.2910, 18.5010],
      [-72.2970, 18.5040],
      [-72.2980, 18.5090],
      [-72.2950, 18.5130]
    ]]
  }'), 4326),
  'system_seed'
);

-- 7. PELERIN - Mountain community above Petion-Ville
INSERT INTO zones (name, description, zone_type, service_rule, is_active, active_from, active_until, active_days, geometry, created_by)
VALUES (
  'Pelerin',
  'Mountain residential community above Petion-Ville. Initial launch zone.',
  'green', 'ride', true, '06:00', '18:00', NULL,
  ST_SetSRID(ST_GeomFromGeoJSON('{
    "type": "Polygon",
    "coordinates": [[
      [-72.2880, 18.5030],
      [-72.2810, 18.5040],
      [-72.2780, 18.4990],
      [-72.2790, 18.4940],
      [-72.2840, 18.4920],
      [-72.2900, 18.4940],
      [-72.2910, 18.4990],
      [-72.2880, 18.5030]
    ]]
  }'), 4326),
  'system_seed'
);

-- 8. LABOULE - Affluent hillside community
INSERT INTO zones (name, description, zone_type, service_rule, is_active, active_from, active_until, active_days, geometry, created_by)
VALUES (
  'Laboule',
  'Affluent hillside residential community. Initial launch zone.',
  'green', 'ride', true, '06:00', '18:00', NULL,
  ST_SetSRID(ST_GeomFromGeoJSON('{
    "type": "Polygon",
    "coordinates": [[
      [-72.2950, 18.4940],
      [-72.2870, 18.4950],
      [-72.2830, 18.4900],
      [-72.2840, 18.4840],
      [-72.2900, 18.4820],
      [-72.2960, 18.4850],
      [-72.2970, 18.4900],
      [-72.2950, 18.4940]
    ]]
  }'), 4326),
  'system_seed'
);

-- 9. THOMASSIN - Mountain town on Route de Kenscoff
INSERT INTO zones (name, description, zone_type, service_rule, is_active, active_from, active_until, active_days, geometry, created_by)
VALUES (
  'Thomassin',
  'Mountain town along Route de Kenscoff. Initial launch zone.',
  'green', 'ride', true, '06:00', '18:00', NULL,
  ST_SetSRID(ST_GeomFromGeoJSON('{
    "type": "Polygon",
    "coordinates": [[
      [-72.3050, 18.4870],
      [-72.2970, 18.4880],
      [-72.2930, 18.4830],
      [-72.2940, 18.4770],
      [-72.3000, 18.4750],
      [-72.3060, 18.4780],
      [-72.3070, 18.4830],
      [-72.3050, 18.4870]
    ]]
  }'), 4326),
  'system_seed'
);

-- 10. FERMATE - Junction area connecting Petion-Ville to mountain routes
INSERT INTO zones (name, description, zone_type, service_rule, is_active, active_from, active_until, active_days, geometry, created_by)
VALUES (
  'Fermate',
  'Key junction connecting Petion-Ville to Kenscoff mountain route. Initial launch zone.',
  'green', 'ride', true, '06:00', '18:00', NULL,
  ST_SetSRID(ST_GeomFromGeoJSON('{
    "type": "Polygon",
    "coordinates": [[
      [-72.2870, 18.5100],
      [-72.2810, 18.5110],
      [-72.2780, 18.5070],
      [-72.2790, 18.5020],
      [-72.2830, 18.5000],
      [-72.2880, 18.5020],
      [-72.2890, 18.5060],
      [-72.2870, 18.5100]
    ]]
  }'), 4326),
  'system_seed'
);

-- 11. KENSCOFF TO LE FLORVILLE CORRIDOR - Mountain road corridor
INSERT INTO zones (name, description, zone_type, service_rule, is_active, active_from, active_until, active_days, geometry, created_by)
VALUES (
  'Kenscoff to Le Florville Corridor',
  'Mountain road corridor from Kenscoff down to Le Florville. Corridor polygon.',
  'green', 'ride', true, '06:00', '18:00', NULL,
  ST_SetSRID(ST_GeomFromGeoJSON('{
    "type": "Polygon",
    "coordinates": [[
      [-72.3100, 18.4760],
      [-72.3020, 18.4710],
      [-72.2960, 18.4620],
      [-72.2930, 18.4530],
      [-72.2920, 18.4450],
      [-72.2960, 18.4420],
      [-72.3000, 18.4480],
      [-72.3030, 18.4570],
      [-72.3080, 18.4660],
      [-72.3140, 18.4730],
      [-72.3100, 18.4760]
    ]]
  }'), 4326),
  'system_seed'
);

-- Create a system config table for global settings
CREATE TABLE IF NOT EXISTS service_config (
    key VARCHAR(100) PRIMARY KEY,
    value JSONB NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Insert global config
INSERT INTO service_config (key, value) VALUES
  ('service_area_name', '"haiti_rides_initial_launch_zone"'),
  ('timezone', '"America/Port-au-Prince"'),
  ('service_mode', '"restricted_daytime_operation"'),
  ('service_hours', '{"start": "06:00", "end": "18:00"}'),
  ('cash_allowed', 'false'),
  ('verified_driver_required', 'true'),
  ('verified_rider_required', 'false'),
  ('live_tracking_required', 'true'),
  ('manual_emergency_override', 'true')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW();
