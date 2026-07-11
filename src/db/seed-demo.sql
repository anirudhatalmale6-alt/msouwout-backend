-- Demo accounts for App Store / Play review.
--
-- Apple rejected 1.0 (7) under Guideline 2.1(a) on 2026-07-07: "We are unable to
-- successfully access all or part of the app." The reviewer was given the demo
-- phone 0000 0000 and got nothing back, because the backend was down at the time
-- and, once it came back, the recreated database had no demo rows in it at all.
--
-- A reviewer who cannot log in is an automatic rejection, so this data is not
-- optional and it is not test scaffolding: it is a release requirement. It runs
-- on every boot, so a fresh or wiped database still comes up reviewable.
--
-- Everything here hangs off the reserved phone +50900000000. Keep it that way:
-- it is the number written into App Review Information and the release checklist.

-- Driver demo account. Login is by phone, so no PIN row is needed; the app sends
-- 0000 and the server ignores it.
INSERT INTO drivers (full_name, phone, email, vehicle_type, license_plate, status, is_verified, is_active)
VALUES ('Demo Driver', '+50900000000', 'demo@msouwout.com', 'moto', 'DEMO-01', 'approved', true, true)
ON CONFLICT (phone) DO UPDATE
  SET status = 'approved', is_verified = true, is_active = true;

-- Ride history for the customer demo account. The customer screen treats
-- total_rides = 0 as an error and refuses to open the dashboard, so the demo
-- customer must own at least one completed ride.
INSERT INTO ride_requests (
  customer_name, customer_phone, pickup_lat, pickup_lng, dropoff_lat, dropoff_lng,
  ride_type, distance_km, duration_min, price, platform_fee, driver_earning,
  payment_method, tracking_code, ride_pin, driver_id, status, started_at, completed_at
)
SELECT 'Demo Customer', '+50900000000', 18.5392, -72.3364, 18.5711, -72.2887,
       'moto', 5.2, 18, 350, 53, 297, 'cash', 'MW-DEMO1', '0000',
       d.id, 'completed', NOW() - INTERVAL '2 days', NOW() - INTERVAL '2 days' + INTERVAL '18 minutes'
FROM drivers d WHERE d.phone = '+50900000000'
ON CONFLICT (tracking_code) DO NOTHING;

INSERT INTO ride_requests (
  customer_name, customer_phone, pickup_lat, pickup_lng, dropoff_lat, dropoff_lng,
  ride_type, distance_km, duration_min, price, platform_fee, driver_earning,
  payment_method, tracking_code, ride_pin, driver_id, status, started_at, completed_at
)
SELECT 'Demo Customer', '+50900000000', 18.5711, -72.2887, 18.5392, -72.3364,
       'moto', 5.4, 21, 375, 56, 319, 'cash', 'MW-DEMO2', '0000',
       d.id, 'completed', NOW() - INTERVAL '1 day', NOW() - INTERVAL '1 day' + INTERVAL '21 minutes'
FROM drivers d WHERE d.phone = '+50900000000'
ON CONFLICT (tracking_code) DO NOTHING;

-- Logistics demo. The fleet and truck exist so the tracking screen has a vehicle,
-- a plate and a live position to draw instead of empty fields.
INSERT INTO fleets (owner_name, company_name, phone, email, status, is_verified)
SELECT 'Demo Fleet Owner', 'MsouWout Demo Logistics', '+50900000001', 'demo-fleet@msouwout.com', 'approved', true
WHERE NOT EXISTS (SELECT 1 FROM fleets WHERE phone = '+50900000001');

INSERT INTO trucks (
  fleet_id, driver_id, truck_type, make, model, year, license_plate,
  payload_capacity_kg, payload_capacity_desc, is_available, status, is_verified,
  current_lat, current_lng, last_location_update
)
SELECT f.id, d.id, 'flatbed', 'Isuzu', 'NPR', 2019, 'DEMO-TRK',
       5000, '5 tons', false, 'approved', true,
       18.5550, -72.3120, NOW()
FROM fleets f
CROSS JOIN drivers d
WHERE f.phone = '+50900000001' AND d.phone = '+50900000000'
  AND NOT EXISTS (SELECT 1 FROM trucks WHERE license_plate = 'DEMO-TRK');

-- The load the reviewer tracks with code MW-DEMO. Status is in_transit, not
-- posted, so it never shows up on the open job board that real drivers bid on.
INSERT INTO freight_loads (
  tracking_code, posted_by_phone, posted_by_name, cargo_type, cargo_description,
  weight_kg, quantity, truck_type_needed,
  pickup_address, pickup_lat, pickup_lng, pickup_contact, pickup_phone,
  dropoff_address, dropoff_lat, dropoff_lng, dropoff_contact, dropoff_phone,
  distance_km, price, currency, urgency, status,
  assigned_truck_id, assigned_driver_id, assigned_at, picked_up_at, in_transit_at
)
SELECT 'MW-DEMO', '+50900000000', 'Demo Customer', 'Construction materials',
       'Demo shipment used for app review', 1200, '20 bags', 'flatbed',
       'Port-au-Prince, Haiti', 18.5392, -72.3364, 'Demo Customer', '+50900000000',
       'Cap-Haitien, Haiti', 19.7594, -72.1981, 'Demo Recipient', '+50900000002',
       242.0, 18000, 'HTG', 'normal', 'in_transit',
       t.id, d.id, NOW() - INTERVAL '6 hours', NOW() - INTERVAL '5 hours', NOW() - INTERVAL '4 hours'
FROM trucks t
CROSS JOIN drivers d
WHERE t.license_plate = 'DEMO-TRK' AND d.phone = '+50900000000'
ON CONFLICT (tracking_code) DO NOTHING;
