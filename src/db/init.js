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
