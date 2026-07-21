const fs = require('fs');
const path = require('path');
const pool = require('./pool');

// App Store and Play reviewers log in with the demo phone 0000 0000. If those rows
// are missing the reviewer cannot get into the app and the submission is rejected,
// which is what happened to iOS 1.0 (7) on 2026-07-07. Re-seeding on every boot
// means a wiped or recreated database still comes up reviewable.
//
// A failure here must not take the API down — a live app with a broken demo login
// beats no app at all — so this logs loudly instead of throwing. The deploy
// workflow is what actually fails the release: it asserts the demo login returns
// 200 before the deploy is allowed to go green.
async function seedDemoAccounts(client) {
  try {
    const demo = fs.readFileSync(path.join(__dirname, 'seed-demo.sql'), 'utf8');
    await client.query(demo);
    console.log('Demo review accounts seeded.');
  } catch (err) {
    console.error('DEMO SEED FAILED — store review will be rejected:', err.message);
  }
}

async function initDatabase(retries = 3) {
  let client;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      client = await pool.connect();
      break;
    } catch (err) {
      console.error(`DB connect attempt ${attempt}/${retries} failed:`, err.message);
      if (attempt === retries) throw err;
      await new Promise(r => setTimeout(r, 5000 * attempt));
    }
  }
  try {
    // Check if zones table exists
    const tableCheck = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables WHERE table_name = 'zones'
      )
    `);

    if (!tableCheck.rows[0].exists) {
      console.log('Initializing database schema...');
      const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
      await client.query(schema);
      console.log('Schema created.');
    } else {
      console.log('Database already initialized.');
    }

    // Every statement in runMigrations is idempotent, but it used to run only when
    // the database already existed. schema.sql never creates the logistics tables,
    // so a freshly created database had no fleets/trucks/freight_loads until some
    // later boot happened to take the other branch. Run them every time.
    await runMigrations(client);

    const seed = fs.readFileSync(path.join(__dirname, 'seed-zones.sql'), 'utf8');
    await client.query(seed);
    await seedDemoAccounts(client);
    console.log('Zones synced. Database ready!');
  } catch (err) {
    console.error('Database init error:', err.message);
    throw err;
  } finally {
    client.release();
  }
}

async function runMigrations(client) {
      await client.query(`
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
          driver_id UUID REFERENCES drivers(id),
          status VARCHAR(50) NOT NULL DEFAULT 'searching',
          cancel_reason TEXT,
          started_at TIMESTAMP WITH TIME ZONE,
          completed_at TIMESTAMP WITH TIME ZONE,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_ride_requests_status ON ride_requests (status);
        CREATE INDEX IF NOT EXISTS idx_ride_requests_driver ON ride_requests (driver_id);
        CREATE INDEX IF NOT EXISTS idx_ride_requests_tracking ON ride_requests (tracking_code);
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS conversations (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          ride_id UUID REFERENCES ride_requests(id),
          driver_id UUID REFERENCES drivers(id),
          rider_phone VARCHAR(50) NOT NULL,
          rider_name VARCHAR(255),
          last_message TEXT,
          last_message_at TIMESTAMP WITH TIME ZONE,
          is_archived BOOLEAN DEFAULT false,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS messages (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          sender_type VARCHAR(10) NOT NULL DEFAULT 'rider',
          sender_id VARCHAR(255),
          content TEXT,
          type VARCHAR(10) NOT NULL DEFAULT 'text',
          file_url TEXT,
          read_at TIMESTAMP WITH TIME ZONE,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_conversations_driver ON conversations (driver_id);
        CREATE INDEX IF NOT EXISTS idx_conversations_phone ON conversations (rider_phone);
        CREATE INDEX IF NOT EXISTS idx_messages_convo ON messages (conversation_id);
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS sos_alerts (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          phone VARCHAR(50) NOT NULL,
          name VARCHAR(255),
          lat DOUBLE PRECISION,
          lng DOUBLE PRECISION,
          ride_id UUID REFERENCES ride_requests(id),
          platform VARCHAR(50) DEFAULT 'msouwout',
          status VARCHAR(30) DEFAULT 'active',
          admin_note TEXT,
          responded_at TIMESTAMP WITH TIME ZONE,
          resolved_at TIMESTAMP WITH TIME ZONE,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_sos_status ON sos_alerts (status);
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ride_shares (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          ride_id UUID NOT NULL REFERENCES ride_requests(id),
          share_code VARCHAR(20) NOT NULL UNIQUE,
          shared_with_name VARCHAR(255),
          shared_with_phone VARCHAR(50),
          expires_at TIMESTAMP WITH TIME ZONE,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_ride_shares_code ON ride_shares (share_code);
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS trusted_contacts (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          owner_phone VARCHAR(50) NOT NULL,
          contact_name VARCHAR(255),
          contact_phone VARCHAR(50) NOT NULL,
          relationship VARCHAR(50) DEFAULT 'family',
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_trusted_owner ON trusted_contacts (owner_phone);
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS route_checkpoints (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          ride_id UUID NOT NULL REFERENCES ride_requests(id),
          lat DOUBLE PRECISION NOT NULL,
          lng DOUBLE PRECISION NOT NULL,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_checkpoints_ride ON route_checkpoints (ride_id);
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS safety_events (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          sos_id UUID REFERENCES sos_alerts(id),
          ride_id UUID REFERENCES ride_requests(id),
          event_type VARCHAR(50) NOT NULL,
          data JSONB,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_safety_events_ride ON safety_events (ride_id);
      `);
      await client.query(`
        ALTER TABLE sos_alerts ADD COLUMN IF NOT EXISTS alert_level VARCHAR(20) DEFAULT 'warning';
        ALTER TABLE sos_alerts ADD COLUMN IF NOT EXISTS is_silent BOOLEAN DEFAULT false;
        ALTER TABLE sos_alerts ADD COLUMN IF NOT EXISTS trigger_reason VARCHAR(50) DEFAULT 'manual';
      `);
      await client.query(`
        ALTER TABLE ride_requests ADD COLUMN IF NOT EXISTS ride_pin VARCHAR(4);
      `);
      // Logistics module
      await client.query(`
        CREATE TABLE IF NOT EXISTS fleets (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          owner_name VARCHAR(255) NOT NULL,
          company_name VARCHAR(255),
          phone VARCHAR(50) NOT NULL,
          email VARCHAR(255),
          address TEXT,
          lat DOUBLE PRECISION,
          lng DOUBLE PRECISION,
          status VARCHAR(30) NOT NULL DEFAULT 'pending',
          is_verified BOOLEAN DEFAULT false,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_fleets_phone ON fleets (phone);
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS trucks (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          fleet_id UUID REFERENCES fleets(id),
          driver_id UUID REFERENCES drivers(id),
          truck_type VARCHAR(50) NOT NULL,
          make VARCHAR(100),
          model VARCHAR(100),
          year INTEGER,
          license_plate VARCHAR(50),
          registration_url TEXT,
          insurance_url TEXT,
          photo_url TEXT,
          payload_capacity_kg INTEGER,
          payload_capacity_desc VARCHAR(255),
          is_available BOOLEAN DEFAULT true,
          status VARCHAR(30) NOT NULL DEFAULT 'pending',
          is_verified BOOLEAN DEFAULT false,
          current_lat DOUBLE PRECISION,
          current_lng DOUBLE PRECISION,
          last_location_update TIMESTAMP WITH TIME ZONE,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_trucks_fleet ON trucks (fleet_id);
        CREATE INDEX IF NOT EXISTS idx_trucks_type ON trucks (truck_type);
        CREATE INDEX IF NOT EXISTS idx_trucks_available ON trucks (is_available, status);
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS freight_loads (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          tracking_code VARCHAR(20) UNIQUE,
          posted_by_phone VARCHAR(50) NOT NULL,
          posted_by_name VARCHAR(255),
          business_id UUID REFERENCES businesses(id),
          cargo_type VARCHAR(100) NOT NULL,
          cargo_description TEXT,
          weight_kg INTEGER,
          quantity VARCHAR(100),
          truck_type_needed VARCHAR(50),
          pickup_address TEXT,
          pickup_lat DOUBLE PRECISION NOT NULL,
          pickup_lng DOUBLE PRECISION NOT NULL,
          pickup_contact VARCHAR(255),
          pickup_phone VARCHAR(50),
          dropoff_address TEXT,
          dropoff_lat DOUBLE PRECISION NOT NULL,
          dropoff_lng DOUBLE PRECISION NOT NULL,
          dropoff_contact VARCHAR(255),
          dropoff_phone VARCHAR(50),
          distance_km DOUBLE PRECISION,
          price INTEGER,
          currency VARCHAR(10) DEFAULT 'HTG',
          urgency VARCHAR(20) DEFAULT 'normal',
          pickup_date TIMESTAMP WITH TIME ZONE,
          notes TEXT,
          pickup_pin VARCHAR(6),
          delivery_pin VARCHAR(6),
          status VARCHAR(30) NOT NULL DEFAULT 'posted',
          assigned_truck_id UUID REFERENCES trucks(id),
          assigned_driver_id UUID REFERENCES drivers(id),
          assigned_at TIMESTAMP WITH TIME ZONE,
          picked_up_at TIMESTAMP WITH TIME ZONE,
          in_transit_at TIMESTAMP WITH TIME ZONE,
          delivered_at TIMESTAMP WITH TIME ZONE,
          cancelled_at TIMESTAMP WITH TIME ZONE,
          cancel_reason TEXT,
          platform_fee INTEGER DEFAULT 0,
          driver_earning INTEGER DEFAULT 0,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_freight_status ON freight_loads (status);
        CREATE INDEX IF NOT EXISTS idx_freight_tracking ON freight_loads (tracking_code);
        CREATE INDEX IF NOT EXISTS idx_freight_poster ON freight_loads (posted_by_phone);
        CREATE INDEX IF NOT EXISTS idx_freight_truck ON freight_loads (assigned_truck_id);
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS delivery_receipts (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          load_id UUID NOT NULL REFERENCES freight_loads(id),
          receipt_type VARCHAR(20) NOT NULL DEFAULT 'delivery',
          photo_url TEXT,
          signature_url TEXT,
          confirmed_by_name VARCHAR(255),
          confirmed_by_phone VARCHAR(50),
          lat DOUBLE PRECISION,
          lng DOUBLE PRECISION,
          notes TEXT,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_receipts_load ON delivery_receipts (load_id);
      `);
      // DASH medical + settlements migration
      await client.query(`
        ALTER TABLE ride_requests ADD COLUMN IF NOT EXISTS medical_protection BOOLEAN NOT NULL DEFAULT false;
        ALTER TABLE ride_requests ADD COLUMN IF NOT EXISTS medical_fee INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE ride_requests ADD COLUMN IF NOT EXISTS dash_fee INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE ride_requests ADD COLUMN IF NOT EXISTS msouwout_medical_fee INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE ride_requests ADD COLUMN IF NOT EXISTS total_with_protection INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE ride_requests ADD COLUMN IF NOT EXISTS is_delegated BOOLEAN NOT NULL DEFAULT false;
        ALTER TABLE ride_requests ADD COLUMN IF NOT EXISTS orderer_name VARCHAR(255);
        ALTER TABLE ride_requests ADD COLUMN IF NOT EXISTS orderer_phone VARCHAR(50);
        ALTER TABLE ride_requests ADD COLUMN IF NOT EXISTS passenger_name VARCHAR(255);
        ALTER TABLE ride_requests ADD COLUMN IF NOT EXISTS passenger_phone VARCHAR(50);
      `);
      // Money split, payout & cancellation tracking (confirmed 2026-07-18)
      await client.query(`
        ALTER TABLE ride_requests ADD COLUMN IF NOT EXISTS driver_dash_share NUMERIC(10,2) NOT NULL DEFAULT 0;
        ALTER TABLE ride_requests ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMP WITH TIME ZONE;
        ALTER TABLE ride_requests ADD COLUMN IF NOT EXISTS cancelled_by VARCHAR(20);
        ALTER TABLE ride_requests ADD COLUMN IF NOT EXISTS cancel_fee INTEGER NOT NULL DEFAULT 0;
      `);
      await client.query(`
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
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS dash_settlements (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          period_start TIMESTAMP WITH TIME ZONE NOT NULL,
          period_end TIMESTAMP WITH TIME ZONE NOT NULL,
          total_rides INTEGER NOT NULL DEFAULT 0,
          total_protection_fees INTEGER NOT NULL DEFAULT 0,
          dash_amount INTEGER NOT NULL DEFAULT 0,
          msouwout_amount INTEGER NOT NULL DEFAULT 0,
          status VARCHAR(50) NOT NULL DEFAULT 'pending',
          dash_bank_ref VARCHAR(255),
          transferred_at TIMESTAMP WITH TIME ZONE,
          notes TEXT,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_dash_settlements_status ON dash_settlements (status);
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS accident_reports (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          ride_id UUID REFERENCES ride_requests(id),
          reporter_type VARCHAR(20) NOT NULL DEFAULT 'passenger',
          reporter_name VARCHAR(255),
          reporter_phone VARCHAR(50),
          driver_name VARCHAR(255),
          driver_phone VARCHAR(50),
          vehicle_info TEXT,
          gps_lat DOUBLE PRECISION,
          gps_lng DOUBLE PRECISION,
          description TEXT,
          severity VARCHAR(20) DEFAULT 'moderate',
          dash_notified BOOLEAN NOT NULL DEFAULT false,
          dash_notified_at TIMESTAMP WITH TIME ZONE,
          sms_sent BOOLEAN NOT NULL DEFAULT false,
          whatsapp_sent BOOLEAN NOT NULL DEFAULT false,
          nearest_facility TEXT,
          status VARCHAR(50) NOT NULL DEFAULT 'reported',
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_accident_reports_ride ON accident_reports (ride_id);
        CREATE INDEX IF NOT EXISTS idx_accident_reports_status ON accident_reports (status);
      `);
      // Referral partner tracking
      await client.query(`
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
        ALTER TABLE drivers ADD COLUMN IF NOT EXISTS syndicate VARCHAR(50);
        ALTER TABLE drivers ADD COLUMN IF NOT EXISTS preferred_zones TEXT;
        ALTER TABLE drivers ADD COLUMN IF NOT EXISTS vehicle_year INTEGER;
        CREATE INDEX IF NOT EXISTS idx_drivers_referral_partner ON drivers (referral_partner);
        CREATE INDEX IF NOT EXISTS idx_drivers_syndicate ON drivers (syndicate);
      `);
      // Driver onboarding v2: full application fields + in-database document storage
      // + an admin password so the review dashboard works WITHOUT the Render-generated
      // ADMIN_SECRET (which is unreadable from outside the Render dashboard).
      await client.query(`
        ALTER TABLE drivers ADD COLUMN IF NOT EXISTS whatsapp VARCHAR(50);
        ALTER TABLE drivers ADD COLUMN IF NOT EXISTS city VARCHAR(120);
        ALTER TABLE drivers ADD COLUMN IF NOT EXISTS vehicle_make VARCHAR(100);
        ALTER TABLE drivers ADD COLUMN IF NOT EXISTS vehicle_model VARCHAR(100);
        ALTER TABLE drivers ADD COLUMN IF NOT EXISTS vehicle_color VARCHAR(50);
        ALTER TABLE drivers ADD COLUMN IF NOT EXISTS oavct_number VARCHAR(100);
        ALTER TABLE drivers ADD COLUMN IF NOT EXISTS oavct_expiry DATE;
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS driver_documents (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          driver_id UUID NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
          doc_type VARCHAR(40) NOT NULL,
          mime VARCHAR(60) NOT NULL DEFAULT 'image/jpeg',
          image_data TEXT NOT NULL,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
          UNIQUE(driver_id, doc_type)
        );
        CREATE INDEX IF NOT EXISTS idx_driver_documents_driver ON driver_documents (driver_id);
      `);
      // Default admin password for the driver-review dashboard. Jeffery can change it
      // later; seeded once and never overwritten.
      await client.query(`
        INSERT INTO service_config (key, value)
        VALUES ('admin_auth', '{"password":"MsouWout2026"}'::jsonb)
        ON CONFLICT (key) DO NOTHING;
      `);
      console.log('Migrations applied (incl. logistics, DASH settlements, referral partners, driver onboarding v2).');
}

module.exports = { initDatabase };
