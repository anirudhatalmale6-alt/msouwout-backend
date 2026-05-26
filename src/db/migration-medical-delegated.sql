-- Migration: Add medical assistance (DASH protection) and delegated ride columns
-- Run this on existing databases. schema.sql already includes these for fresh installs.

-- Medical assistance / DASH protection columns
ALTER TABLE ride_requests ADD COLUMN IF NOT EXISTS medical_protection BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE ride_requests ADD COLUMN IF NOT EXISTS medical_fee INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ride_requests ADD COLUMN IF NOT EXISTS dash_fee INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ride_requests ADD COLUMN IF NOT EXISTS msouwout_medical_fee INTEGER NOT NULL DEFAULT 0;

-- Delegated ride columns (order for someone else)
ALTER TABLE ride_requests ADD COLUMN IF NOT EXISTS is_delegated BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE ride_requests ADD COLUMN IF NOT EXISTS orderer_name VARCHAR(255);
ALTER TABLE ride_requests ADD COLUMN IF NOT EXISTS orderer_phone VARCHAR(50);
ALTER TABLE ride_requests ADD COLUMN IF NOT EXISTS passenger_name VARCHAR(255);
ALTER TABLE ride_requests ADD COLUMN IF NOT EXISTS passenger_phone VARCHAR(50);

-- ride_pin column (may already exist via app logic, ensure it's in the table)
ALTER TABLE ride_requests ADD COLUMN IF NOT EXISTS ride_pin VARCHAR(10);

-- Medical claims table
CREATE TABLE IF NOT EXISTS medical_claims (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    ride_id UUID NOT NULL REFERENCES ride_requests(id),
    claimant_name VARCHAR(255),
    claimant_phone VARCHAR(50),
    description TEXT NOT NULL,
    photos TEXT[],
    status VARCHAR(50) NOT NULL DEFAULT 'pending',
    admin_note TEXT,
    reviewed_by VARCHAR(255),
    reviewed_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_medical_claims_ride ON medical_claims (ride_id);
CREATE INDEX IF NOT EXISTS idx_medical_claims_status ON medical_claims (status);
