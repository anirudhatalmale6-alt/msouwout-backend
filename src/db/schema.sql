-- MsouWout Geofencing Database Schema
-- No PostGIS required - uses JSONB for geometry, JS for spatial calculations

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Zone types: green (allowed), yellow (manual approval), red (blocked)
DO $$ BEGIN
  CREATE TYPE zone_type AS ENUM ('green', 'yellow', 'red');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE service_type AS ENUM ('ride', 'delivery', 'both');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- Zones table - stores geofenced polygons as GeoJSON in JSONB
CREATE TABLE IF NOT EXISTS zones (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    description TEXT,
    zone_type zone_type NOT NULL DEFAULT 'green',
    geometry JSONB NOT NULL, -- GeoJSON Polygon
    service_rule service_type NOT NULL DEFAULT 'both',
    is_active BOOLEAN NOT NULL DEFAULT true,
    active_from TIME,
    active_until TIME,
    active_days INTEGER[],
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    created_by VARCHAR(255)
);

CREATE INDEX IF NOT EXISTS idx_zones_active ON zones (is_active, zone_type);

-- Drivers table
CREATE TABLE IF NOT EXISTS drivers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    full_name VARCHAR(255) NOT NULL,
    phone VARCHAR(50) NOT NULL UNIQUE,
    email VARCHAR(255),
    vehicle_type VARCHAR(50) NOT NULL,
    license_plate VARCHAR(50),
    license_number VARCHAR(100),
    id_document_url TEXT,
    license_document_url TEXT,
    vehicle_document_url TEXT,
    photo_url TEXT,
    preferred_zones UUID[],
    preferred_service service_type DEFAULT 'both',
    status VARCHAR(50) NOT NULL DEFAULT 'pending',
    is_verified BOOLEAN NOT NULL DEFAULT false,
    is_active BOOLEAN NOT NULL DEFAULT true,
    rejection_reason TEXT,
    reviewed_at TIMESTAMP WITH TIME ZONE,
    reviewed_by VARCHAR(255),
    current_lat DOUBLE PRECISION,
    current_lng DOUBLE PRECISION,
    last_location_update TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_drivers_active ON drivers (is_active, is_verified);
CREATE INDEX IF NOT EXISTS idx_drivers_status ON drivers (status);

-- Businesses table
CREATE TABLE IF NOT EXISTS businesses (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    business_name VARCHAR(255) NOT NULL,
    contact_name VARCHAR(255) NOT NULL,
    phone VARCHAR(50) NOT NULL,
    email VARCHAR(255),
    business_type VARCHAR(100),
    address TEXT,
    lat DOUBLE PRECISION,
    lng DOUBLE PRECISION,
    preferred_zone_id UUID REFERENCES zones(id),
    service_needed service_type DEFAULT 'delivery',
    estimated_daily_orders INTEGER,
    business_license_url TEXT,
    status VARCHAR(50) NOT NULL DEFAULT 'pending',
    is_active BOOLEAN NOT NULL DEFAULT true,
    rejection_reason TEXT,
    reviewed_at TIMESTAMP WITH TIME ZONE,
    reviewed_by VARCHAR(255),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_businesses_status ON businesses (status);

-- Trip requests log
CREATE TABLE IF NOT EXISTS trip_requests (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    service_type service_type NOT NULL,
    pickup_lat DOUBLE PRECISION NOT NULL,
    pickup_lng DOUBLE PRECISION NOT NULL,
    destination_lat DOUBLE PRECISION NOT NULL,
    destination_lng DOUBLE PRECISION NOT NULL,
    pickup_zone_id UUID REFERENCES zones(id),
    destination_zone_id UUID REFERENCES zones(id),
    status VARCHAR(50) NOT NULL DEFAULT 'pending',
    rejection_reason TEXT,
    customer_name VARCHAR(255),
    customer_phone VARCHAR(50),
    driver_id UUID REFERENCES drivers(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Active trips (for live tracking)
CREATE TABLE IF NOT EXISTS active_trips (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    trip_request_id UUID NOT NULL REFERENCES trip_requests(id),
    driver_id UUID NOT NULL REFERENCES drivers(id),
    status VARCHAR(50) NOT NULL DEFAULT 'assigned',
    driver_lat DOUBLE PRECISION,
    driver_lng DOUBLE PRECISION,
    emergency_triggered BOOLEAN DEFAULT false,
    emergency_at TIMESTAMP WITH TIME ZONE,
    started_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    completed_at TIMESTAMP WITH TIME ZONE,
    tracking_code VARCHAR(20) NOT NULL UNIQUE
);

CREATE INDEX IF NOT EXISTS idx_active_trips_status ON active_trips (status);

-- Admin users
CREATE TABLE IF NOT EXISTS admins (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    username VARCHAR(100) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(50) NOT NULL DEFAULT 'operator',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Audit log for zone changes
CREATE TABLE IF NOT EXISTS zone_audit_log (
    id SERIAL PRIMARY KEY,
    zone_id UUID,
    action VARCHAR(50) NOT NULL,
    changed_by VARCHAR(255),
    details JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Service config
CREATE TABLE IF NOT EXISTS service_config (
    key VARCHAR(100) PRIMARY KEY,
    value JSONB NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Ride requests with pricing
CREATE TABLE IF NOT EXISTS ride_requests (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    customer_name VARCHAR(255),
    customer_phone VARCHAR(50) NOT NULL,
    user_id VARCHAR(255),
    pickup_lat DOUBLE PRECISION NOT NULL,
    pickup_lng DOUBLE PRECISION NOT NULL,
    dropoff_lat DOUBLE PRECISION NOT NULL,
    dropoff_lng DOUBLE PRECISION NOT NULL,
    ride_type VARCHAR(20) NOT NULL DEFAULT 'moto',
    distance_km DOUBLE PRECISION,
    duration_min INTEGER,
    price INTEGER NOT NULL,
    platform_fee INTEGER NOT NULL DEFAULT 0,
    driver_earning INTEGER NOT NULL DEFAULT 0,
    payment_method VARCHAR(50) NOT NULL DEFAULT 'cash',
    tracking_code VARCHAR(20) UNIQUE,
    ride_pin VARCHAR(10),
    driver_id UUID REFERENCES drivers(id),
    status VARCHAR(50) NOT NULL DEFAULT 'searching',
    cancel_reason TEXT,
    -- Medical assistance / DASH protection
    medical_protection BOOLEAN NOT NULL DEFAULT false,
    medical_fee INTEGER NOT NULL DEFAULT 0,
    dash_fee INTEGER NOT NULL DEFAULT 0,
    msouwout_medical_fee INTEGER NOT NULL DEFAULT 0,
    -- Delegated ride (order for someone else)
    is_delegated BOOLEAN NOT NULL DEFAULT false,
    orderer_name VARCHAR(255),
    orderer_phone VARCHAR(50),
    passenger_name VARCHAR(255),
    passenger_phone VARCHAR(50),
    started_at TIMESTAMP WITH TIME ZONE,
    completed_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Medical claims for DASH protection
CREATE TABLE IF NOT EXISTS medical_claims (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    ride_id UUID NOT NULL REFERENCES ride_requests(id),
    claimant_name VARCHAR(255),
    claimant_phone VARCHAR(50),
    description TEXT NOT NULL,
    photos TEXT[], -- array of photo URLs
    status VARCHAR(50) NOT NULL DEFAULT 'pending', -- pending, reviewing, approved, rejected
    admin_note TEXT,
    reviewed_by VARCHAR(255),
    reviewed_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_medical_claims_ride ON medical_claims (ride_id);
CREATE INDEX IF NOT EXISTS idx_medical_claims_status ON medical_claims (status);

CREATE INDEX IF NOT EXISTS idx_ride_requests_status ON ride_requests (status);
CREATE INDEX IF NOT EXISTS idx_ride_requests_driver ON ride_requests (driver_id);
CREATE INDEX IF NOT EXISTS idx_ride_requests_tracking ON ride_requests (tracking_code);
