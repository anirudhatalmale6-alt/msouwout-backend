const fs = require('fs');
const path = require('path');
const pool = require('./pool');

async function initDatabase() {
  const client = await pool.connect();
  try {
    // Check if zones table exists
    const tableCheck = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables WHERE table_name = 'zones'
      )
    `);

    if (tableCheck.rows[0].exists) {
      console.log('Database already initialized.');
      // Run migrations for new tables
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
      const seed = fs.readFileSync(path.join(__dirname, 'seed-zones.sql'), 'utf8');
      await client.query(seed);
      console.log('Migrations applied, zones synced.')
      return;
    }

    console.log('Initializing database schema...');
    const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    await client.query(schema);
    console.log('Schema created.');

    console.log('Seeding initial zones...');
    const seed = fs.readFileSync(path.join(__dirname, 'seed-zones.sql'), 'utf8');
    await client.query(seed);
    console.log('Zones seeded. Database ready!');
  } catch (err) {
    console.error('Database init error:', err.message);
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { initDatabase };
