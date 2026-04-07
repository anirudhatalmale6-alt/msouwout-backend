-- MsouWout Geofencing Database Schema
-- Requires PostgreSQL with PostGIS extension

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Zone types: green (allowed), yellow (manual approval), red (blocked)
CREATE TYPE zone_type AS ENUM ('green', 'yellow', 'red');
CREATE TYPE service_type AS ENUM ('ride', 'delivery', 'both');

-- Zones table - stores geofenced polygons
CREATE TABLE zones (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    description TEXT,
    zone_type zone_type NOT NULL DEFAULT 'green',
    geometry GEOMETRY(Polygon, 4326) NOT NULL,
    service_rule service_type NOT NULL DEFAULT 'both',
    is_active BOOLEAN NOT NULL DEFAULT true,
    -- Time-based rules (NULL = always active)
    active_from TIME,         -- e.g. 06:00 (daytime only)
    active_until TIME,        -- e.g. 18:00
    active_days INTEGER[],    -- days of week: 0=Sun, 1=Mon...6=Sat (NULL = all days)
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    created_by VARCHAR(255)
);

-- Spatial index for fast geospatial queries
CREATE INDEX idx_zones_geometry ON zones USING GIST (geometry);
CREATE INDEX idx_zones_active ON zones (is_active, zone_type);

-- Trip requests log
CREATE TABLE trip_requests (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    service_type service_type NOT NULL,
    pickup_lat DOUBLE PRECISION NOT NULL,
    pickup_lng DOUBLE PRECISION NOT NULL,
    destination_lat DOUBLE PRECISION NOT NULL,
    destination_lng DOUBLE PRECISION NOT NULL,
    pickup_zone_id UUID REFERENCES zones(id),
    destination_zone_id UUID REFERENCES zones(id),
    status VARCHAR(50) NOT NULL DEFAULT 'pending', -- pending, approved, rejected, manual_review, completed
    rejection_reason TEXT,
    customer_name VARCHAR(255),
    customer_phone VARCHAR(50),
    driver_id UUID REFERENCES drivers(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Drivers table
CREATE TABLE drivers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    full_name VARCHAR(255) NOT NULL,
    phone VARCHAR(50) NOT NULL UNIQUE,
    email VARCHAR(255),
    vehicle_type VARCHAR(50) NOT NULL, -- motorcycle, car, van, truck
    license_plate VARCHAR(50),
    license_number VARCHAR(100),
    id_document_url TEXT,
    license_document_url TEXT,
    vehicle_document_url TEXT,
    photo_url TEXT,
    preferred_zones UUID[],
    preferred_service service_type DEFAULT 'both',
    status VARCHAR(50) NOT NULL DEFAULT 'pending', -- pending, approved, rejected, suspended
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

CREATE INDEX idx_drivers_active ON drivers (is_active, is_verified);
CREATE INDEX idx_drivers_status ON drivers (status);

-- Businesses table
CREATE TABLE businesses (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    business_name VARCHAR(255) NOT NULL,
    contact_name VARCHAR(255) NOT NULL,
    phone VARCHAR(50) NOT NULL,
    email VARCHAR(255),
    business_type VARCHAR(100), -- restaurant, retail, grocery, pharmacy, other
    address TEXT,
    lat DOUBLE PRECISION,
    lng DOUBLE PRECISION,
    preferred_zone_id UUID REFERENCES zones(id),
    service_needed service_type DEFAULT 'delivery',
    estimated_daily_orders INTEGER,
    business_license_url TEXT,
    status VARCHAR(50) NOT NULL DEFAULT 'pending', -- pending, approved, rejected, suspended
    is_active BOOLEAN NOT NULL DEFAULT true,
    rejection_reason TEXT,
    reviewed_at TIMESTAMP WITH TIME ZONE,
    reviewed_by VARCHAR(255),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_businesses_status ON businesses (status);

-- Active trips (for live tracking)
CREATE TABLE active_trips (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    trip_request_id UUID NOT NULL REFERENCES trip_requests(id),
    driver_id UUID NOT NULL REFERENCES drivers(id),
    status VARCHAR(50) NOT NULL DEFAULT 'assigned', -- assigned, en_route_pickup, picked_up, en_route_destination, completed, cancelled, emergency
    driver_lat DOUBLE PRECISION,
    driver_lng DOUBLE PRECISION,
    emergency_triggered BOOLEAN DEFAULT false,
    emergency_at TIMESTAMP WITH TIME ZONE,
    started_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    completed_at TIMESTAMP WITH TIME ZONE,
    tracking_code VARCHAR(20) NOT NULL UNIQUE -- short code for sharing trip link
);

CREATE INDEX idx_active_trips_status ON active_trips (status);

-- Admin users
CREATE TABLE admins (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    username VARCHAR(100) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(50) NOT NULL DEFAULT 'operator', -- operator, admin
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Audit log for zone changes
CREATE TABLE zone_audit_log (
    id SERIAL PRIMARY KEY,
    zone_id UUID,
    action VARCHAR(50) NOT NULL, -- created, updated, activated, deactivated, deleted
    changed_by VARCHAR(255),
    details JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
