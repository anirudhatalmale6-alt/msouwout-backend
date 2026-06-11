-- Migration: DASH settlements tracking & accident reporting
-- Settlement tracking for 24-hour DASH payment transfers
CREATE TABLE IF NOT EXISTS dash_settlements (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    period_start TIMESTAMP WITH TIME ZONE NOT NULL,
    period_end TIMESTAMP WITH TIME ZONE NOT NULL,
    total_rides INTEGER NOT NULL DEFAULT 0,
    total_protection_fees INTEGER NOT NULL DEFAULT 0,
    dash_amount INTEGER NOT NULL DEFAULT 0,
    msouwout_amount INTEGER NOT NULL DEFAULT 0,
    status VARCHAR(50) NOT NULL DEFAULT 'pending', -- pending, processing, completed, failed
    dash_bank_ref VARCHAR(255),
    transferred_at TIMESTAMP WITH TIME ZONE,
    notes TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dash_settlements_status ON dash_settlements (status);
CREATE INDEX IF NOT EXISTS idx_dash_settlements_period ON dash_settlements (period_start, period_end);

-- Accident reports with full incident details
CREATE TABLE IF NOT EXISTS accident_reports (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    ride_id UUID REFERENCES ride_requests(id),
    reporter_type VARCHAR(20) NOT NULL DEFAULT 'passenger', -- passenger, driver
    reporter_name VARCHAR(255),
    reporter_phone VARCHAR(50),
    driver_name VARCHAR(255),
    driver_phone VARCHAR(50),
    vehicle_info TEXT,
    gps_lat DOUBLE PRECISION,
    gps_lng DOUBLE PRECISION,
    description TEXT,
    severity VARCHAR(20) DEFAULT 'moderate', -- minor, moderate, severe, critical
    dash_notified BOOLEAN NOT NULL DEFAULT false,
    dash_notified_at TIMESTAMP WITH TIME ZONE,
    sms_sent BOOLEAN NOT NULL DEFAULT false,
    whatsapp_sent BOOLEAN NOT NULL DEFAULT false,
    nearest_facility TEXT,
    status VARCHAR(50) NOT NULL DEFAULT 'reported', -- reported, dash_contacted, in_treatment, resolved
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_accident_reports_ride ON accident_reports (ride_id);
CREATE INDEX IF NOT EXISTS idx_accident_reports_status ON accident_reports (status);

-- Add total_with_protection to ride_requests for easy reporting
ALTER TABLE ride_requests ADD COLUMN IF NOT EXISTS total_with_protection INTEGER NOT NULL DEFAULT 0;
