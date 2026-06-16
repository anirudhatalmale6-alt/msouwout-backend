-- Referral Partner Tracking System
-- Partners: FTPH, COTRASMOTHA (receive commission based on drivers they bring)

CREATE TABLE IF NOT EXISTS referral_partners (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    code VARCHAR(50) NOT NULL UNIQUE,
    name VARCHAR(255) NOT NULL,
    contact_name VARCHAR(255),
    contact_phone VARCHAR(50),
    contact_email VARCHAR(255),
    commission_pct NUMERIC(5,2) NOT NULL DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

INSERT INTO referral_partners (code, name, commission_pct) VALUES
  ('FTPH/COTRASMOTHA', 'FTPH/COTRASMOTHA', 0)
ON CONFLICT (code) DO NOTHING;

ALTER TABLE drivers ADD COLUMN IF NOT EXISTS referral_partner VARCHAR(50);
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS referral_code VARCHAR(50);

CREATE INDEX IF NOT EXISTS idx_drivers_referral_partner ON drivers (referral_partner);
