-- MsouWout Initial Launch Zones - Haiti Rides
-- Service: Restricted daytime operation (06:00 - 20:00)
-- All zones: Green (SERVICE_ALLOWED), rides only, daytime only, verified drivers required
-- Geometry stored as GeoJSON in JSONB (no PostGIS required)

-- 1. TURGEAU
INSERT INTO zones (name, description, zone_type, service_rule, is_active, active_from, active_until, active_days, geometry, created_by)
VALUES (
  'Turgeau',
  'Residential and commercial zone south of Champ de Mars. Initial launch zone.',
  'green', 'ride', true, '06:00', '20:00', NULL,
  '{"type":"Polygon","coordinates":[[[-72.338,18.538],[-72.331,18.538],[-72.328,18.534],[-72.329,18.53],[-72.335,18.528],[-72.34,18.53],[-72.341,18.534],[-72.338,18.538]]]}',
  'system_seed'
) ON CONFLICT DO NOTHING;

-- 2. CANAPE VERT
INSERT INTO zones (name, description, zone_type, service_rule, is_active, active_from, active_until, active_days, geometry, created_by)
VALUES (
  'Canape Vert',
  'Commercial corridor with hospitals and businesses. Initial launch zone.',
  'green', 'ride', true, '06:00', '20:00', NULL,
  '{"type":"Polygon","coordinates":[[[-72.328,18.54],[-72.32,18.541],[-72.317,18.537],[-72.318,18.532],[-72.323,18.53],[-72.329,18.531],[-72.33,18.536],[-72.328,18.54]]]}',
  'system_seed'
) ON CONFLICT DO NOTHING;

-- 3. BOURDON
INSERT INTO zones (name, description, zone_type, service_rule, is_active, active_from, active_until, active_days, geometry, created_by)
VALUES (
  'Bourdon',
  'Upscale residential area with embassies and international organizations. Initial launch zone.',
  'green', 'ride', true, '06:00', '20:00', NULL,
  '{"type":"Polygon","coordinates":[[[-72.331,18.53],[-72.324,18.531],[-72.32,18.527],[-72.321,18.522],[-72.327,18.52],[-72.333,18.522],[-72.334,18.526],[-72.331,18.53]]]}',
  'system_seed'
) ON CONFLICT DO NOTHING;

-- 4. JUVENAT
INSERT INTO zones (name, description, zone_type, service_rule, is_active, active_from, active_until, active_days, geometry, created_by)
VALUES (
  'Juvenat',
  'Residential neighborhood near Petion-Ville. Schools and institutions. Initial launch zone.',
  'green', 'ride', true, '06:00', '20:00', NULL,
  '{"type":"Polygon","coordinates":[[[-72.312,18.526],[-72.305,18.527],[-72.302,18.523],[-72.303,18.518],[-72.308,18.516],[-72.314,18.518],[-72.315,18.522],[-72.312,18.526]]]}',
  'system_seed'
) ON CONFLICT DO NOTHING;

-- 5. DELMAS 19 TO PETION-VILLE CORRIDOR
INSERT INTO zones (name, description, zone_type, service_rule, is_active, active_from, active_until, active_days, geometry, created_by)
VALUES (
  'Delmas 19 to Petion-Ville Corridor',
  'Major transit corridor connecting Delmas 19 through to Petion-Ville center. Corridor polygon.',
  'green', 'ride', true, '06:00', '20:00', NULL,
  '{"type":"Polygon","coordinates":[[[-72.32,18.543],[-72.305,18.538],[-72.292,18.528],[-72.287,18.519],[-72.285,18.513],[-72.289,18.51],[-72.295,18.515],[-72.3,18.524],[-72.31,18.533],[-72.324,18.54],[-72.32,18.543]]]}',
  'system_seed'
) ON CONFLICT DO NOTHING;

-- 6. MONTAGNE NOIRE
INSERT INTO zones (name, description, zone_type, service_rule, is_active, active_from, active_until, active_days, geometry, created_by)
VALUES (
  'Montagne Noire',
  'Upscale hillside residential area above Petion-Ville. Initial launch zone.',
  'green', 'ride', true, '06:00', '20:00', NULL,
  '{"type":"Polygon","coordinates":[[[-72.295,18.513],[-72.288,18.514],[-72.284,18.509],[-72.285,18.503],[-72.291,18.501],[-72.297,18.504],[-72.298,18.509],[-72.295,18.513]]]}',
  'system_seed'
) ON CONFLICT DO NOTHING;

-- 7. PELERIN
INSERT INTO zones (name, description, zone_type, service_rule, is_active, active_from, active_until, active_days, geometry, created_by)
VALUES (
  'Pelerin',
  'Mountain residential community above Petion-Ville. Initial launch zone.',
  'green', 'ride', true, '06:00', '20:00', NULL,
  '{"type":"Polygon","coordinates":[[[-72.288,18.503],[-72.281,18.504],[-72.278,18.499],[-72.279,18.494],[-72.284,18.492],[-72.29,18.494],[-72.291,18.499],[-72.288,18.503]]]}',
  'system_seed'
) ON CONFLICT DO NOTHING;

-- 8. LABOULE
INSERT INTO zones (name, description, zone_type, service_rule, is_active, active_from, active_until, active_days, geometry, created_by)
VALUES (
  'Laboule',
  'Affluent hillside residential community. Initial launch zone.',
  'green', 'ride', true, '06:00', '20:00', NULL,
  '{"type":"Polygon","coordinates":[[[-72.295,18.494],[-72.287,18.495],[-72.283,18.49],[-72.284,18.484],[-72.29,18.482],[-72.296,18.485],[-72.297,18.49],[-72.295,18.494]]]}',
  'system_seed'
) ON CONFLICT DO NOTHING;

-- 9. THOMASSIN
INSERT INTO zones (name, description, zone_type, service_rule, is_active, active_from, active_until, active_days, geometry, created_by)
VALUES (
  'Thomassin',
  'Mountain town along Route de Kenscoff. Initial launch zone.',
  'green', 'ride', true, '06:00', '20:00', NULL,
  '{"type":"Polygon","coordinates":[[[-72.305,18.487],[-72.297,18.488],[-72.293,18.483],[-72.294,18.477],[-72.3,18.475],[-72.306,18.478],[-72.307,18.483],[-72.305,18.487]]]}',
  'system_seed'
) ON CONFLICT DO NOTHING;

-- 10. FERMATE
INSERT INTO zones (name, description, zone_type, service_rule, is_active, active_from, active_until, active_days, geometry, created_by)
VALUES (
  'Fermate',
  'Key junction connecting Petion-Ville to Kenscoff mountain route. Initial launch zone.',
  'green', 'ride', true, '06:00', '20:00', NULL,
  '{"type":"Polygon","coordinates":[[[-72.287,18.51],[-72.281,18.511],[-72.278,18.507],[-72.279,18.502],[-72.283,18.5],[-72.288,18.502],[-72.289,18.506],[-72.287,18.51]]]}',
  'system_seed'
) ON CONFLICT DO NOTHING;

-- 11. KENSCOFF TO LE FLORVILLE CORRIDOR
INSERT INTO zones (name, description, zone_type, service_rule, is_active, active_from, active_until, active_days, geometry, created_by)
VALUES (
  'Kenscoff to Le Florville Corridor',
  'Mountain road corridor from Kenscoff down to Le Florville. Corridor polygon.',
  'green', 'ride', true, '06:00', '20:00', NULL,
  '{"type":"Polygon","coordinates":[[[-72.31,18.476],[-72.302,18.471],[-72.296,18.462],[-72.293,18.453],[-72.292,18.445],[-72.296,18.442],[-72.3,18.448],[-72.303,18.457],[-72.308,18.466],[-72.314,18.473],[-72.31,18.476]]]}',
  'system_seed'
) ON CONFLICT DO NOTHING;

-- 12. NAZON
INSERT INTO zones (name, description, zone_type, service_rule, is_active, active_from, active_until, active_days, geometry, created_by)
VALUES (
  'Nazon',
  'Residential and commercial area along Avenue Nazon, north of Turgeau near Champ de Mars.',
  'green', 'ride', true, '06:00', '20:00', NULL,
  '{"type":"Polygon","coordinates":[[[-72.338,18.547],[-72.33,18.547],[-72.327,18.543],[-72.328,18.539],[-72.333,18.537],[-72.339,18.539],[-72.34,18.543],[-72.338,18.547]]]}',
  'system_seed'
) ON CONFLICT DO NOTHING;

-- 13. DEBUSSY
INSERT INTO zones (name, description, zone_type, service_rule, is_active, active_from, active_until, active_days, geometry, created_by)
VALUES (
  'Debussy',
  'Residential neighborhood in Delmas along Rue Debussy. Mixed residential and commercial.',
  'green', 'ride', true, '06:00', '20:00', NULL,
  '{"type":"Polygon","coordinates":[[[-72.322,18.553],[-72.314,18.553],[-72.311,18.549],[-72.312,18.545],[-72.317,18.543],[-72.323,18.545],[-72.324,18.549],[-72.322,18.553]]]}',
  'system_seed'
) ON CONFLICT DO NOTHING;

-- 14. CATALPA
INSERT INTO zones (name, description, zone_type, service_rule, is_active, active_from, active_until, active_days, geometry, created_by)
VALUES (
  'Catalpa',
  'Neighborhood near Bourdon and Canapé Vert, western Port-au-Prince residential area.',
  'green', 'ride', true, '06:00', '20:00', NULL,
  '{"type":"Polygon","coordinates":[[[-72.349,18.538],[-72.341,18.538],[-72.338,18.534],[-72.339,18.53],[-72.344,18.528],[-72.35,18.53],[-72.351,18.534],[-72.349,18.538]]]}',
  'system_seed'
) ON CONFLICT DO NOTHING;

-- 15. PUIT BLAIN
INSERT INTO zones (name, description, zone_type, service_rule, is_active, active_from, active_until, active_days, geometry, created_by)
VALUES (
  'Puit Blain',
  'Neighborhood in Delmas area around Delmas 31-33. Active commercial and residential zone.',
  'green', 'ride', true, '06:00', '20:00', NULL,
  '{"type":"Polygon","coordinates":[[[-72.314,18.559],[-72.306,18.559],[-72.303,18.555],[-72.304,18.551],[-72.309,18.549],[-72.315,18.551],[-72.316,18.555],[-72.314,18.559]]]}',
  'system_seed'
) ON CONFLICT DO NOTHING;

-- 16. CLERCINE
INSERT INTO zones (name, description, zone_type, service_rule, is_active, active_from, active_until, active_days, geometry, created_by)
VALUES (
  'Clercine',
  'Area near Delmas 75 and Tabarre. Residential neighborhood with growing commercial activity.',
  'green', 'ride', true, '06:00', '20:00', NULL,
  '{"type":"Polygon","coordinates":[[[-72.3,18.562],[-72.291,18.562],[-72.288,18.558],[-72.289,18.553],[-72.294,18.551],[-72.301,18.553],[-72.302,18.558],[-72.3,18.562]]]}',
  'system_seed'
) ON CONFLICT DO NOTHING;

-- 17. ROUTE FRERES
INSERT INTO zones (name, description, zone_type, service_rule, is_active, active_from, active_until, active_days, geometry, created_by)
VALUES (
  'Route Frères',
  'Major road corridor connecting Delmas to Petion-Ville via the east side. High traffic route.',
  'green', 'ride', true, '06:00', '20:00', NULL,
  '{"type":"Polygon","coordinates":[[[-72.295,18.529],[-72.284,18.529],[-72.28,18.523],[-72.281,18.517],[-72.287,18.515],[-72.296,18.517],[-72.298,18.523],[-72.295,18.529]]]}',
  'system_seed'
) ON CONFLICT DO NOTHING;

-- 18. GIRARDO
INSERT INTO zones (name, description, zone_type, service_rule, is_active, active_from, active_until, active_days, geometry, created_by)
VALUES (
  'Girardo',
  'Neighborhood in the Delmas area. Residential zone with local businesses.',
  'green', 'ride', true, '06:00', '20:00', NULL,
  '{"type":"Polygon","coordinates":[[[-72.309,18.551],[-72.301,18.551],[-72.298,18.547],[-72.299,18.543],[-72.304,18.541],[-72.31,18.543],[-72.311,18.547],[-72.309,18.551]]]}',
  'system_seed'
) ON CONFLICT DO NOTHING;

-- Global config
INSERT INTO service_config (key, value) VALUES
  ('service_area_name', '"haiti_rides_initial_launch_zone"'),
  ('timezone', '"America/Port-au-Prince"'),
  ('service_mode', '"restricted_daytime_operation"'),
  ('service_hours', '{"start": "06:00", "end": "20:00"}'),
  ('cash_allowed', 'false'),
  ('verified_driver_required', 'true'),
  ('verified_rider_required', 'false'),
  ('live_tracking_required', 'true'),
  ('manual_emergency_override', 'true')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW();
