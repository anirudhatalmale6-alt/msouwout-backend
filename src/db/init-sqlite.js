const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const uuidv4 = () => crypto.randomUUID();

const DB_PATH = process.env.SQLITE_PATH || path.join(__dirname, '..', '..', 'data', 'msouwout.db');

async function initSqliteDatabase() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS zones (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      zone_type TEXT NOT NULL DEFAULT 'green',
      geometry TEXT NOT NULL,
      service_rule TEXT NOT NULL DEFAULT 'both',
      is_active INTEGER NOT NULL DEFAULT 1,
      active_from TEXT,
      active_until TEXT,
      active_days TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      created_by TEXT
    );

    CREATE TABLE IF NOT EXISTS drivers (
      id TEXT PRIMARY KEY,
      full_name TEXT NOT NULL,
      phone TEXT NOT NULL UNIQUE,
      email TEXT,
      vehicle_type TEXT NOT NULL,
      license_plate TEXT,
      license_number TEXT,
      id_document_url TEXT,
      license_document_url TEXT,
      vehicle_document_url TEXT,
      photo_url TEXT,
      preferred_zones TEXT,
      preferred_service TEXT DEFAULT 'both',
      status TEXT NOT NULL DEFAULT 'pending',
      is_verified INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      rejection_reason TEXT,
      reviewed_at TEXT,
      reviewed_by TEXT,
      current_lat REAL,
      current_lng REAL,
      last_location_update TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      referral_partner TEXT,
      referral_code TEXT,
      syndicate TEXT
    );

    CREATE TABLE IF NOT EXISTS businesses (
      id TEXT PRIMARY KEY,
      business_name TEXT NOT NULL,
      contact_name TEXT NOT NULL,
      phone TEXT NOT NULL,
      email TEXT,
      business_type TEXT,
      address TEXT,
      lat REAL,
      lng REAL,
      preferred_zone_id TEXT,
      service_needed TEXT DEFAULT 'delivery',
      estimated_daily_orders INTEGER,
      business_license_url TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      is_active INTEGER NOT NULL DEFAULT 1,
      rejection_reason TEXT,
      reviewed_at TEXT,
      reviewed_by TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS trip_requests (
      id TEXT PRIMARY KEY,
      service_type TEXT NOT NULL,
      pickup_lat REAL NOT NULL,
      pickup_lng REAL NOT NULL,
      destination_lat REAL NOT NULL,
      destination_lng REAL NOT NULL,
      pickup_zone_id TEXT,
      destination_zone_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      rejection_reason TEXT,
      customer_name TEXT,
      customer_phone TEXT,
      driver_id TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS active_trips (
      id TEXT PRIMARY KEY,
      trip_request_id TEXT NOT NULL,
      driver_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'assigned',
      driver_lat REAL,
      driver_lng REAL,
      emergency_triggered INTEGER DEFAULT 0,
      emergency_at TEXT,
      started_at TEXT DEFAULT (datetime('now')),
      completed_at TEXT,
      tracking_code TEXT NOT NULL UNIQUE
    );

    CREATE TABLE IF NOT EXISTS admins (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'operator',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS zone_audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      zone_id TEXT,
      action TEXT NOT NULL,
      changed_by TEXT,
      details TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS service_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS ride_requests (
      id TEXT PRIMARY KEY,
      customer_name TEXT,
      customer_phone TEXT NOT NULL,
      user_id TEXT,
      pickup_lat REAL NOT NULL,
      pickup_lng REAL NOT NULL,
      dropoff_lat REAL NOT NULL,
      dropoff_lng REAL NOT NULL,
      ride_type TEXT NOT NULL DEFAULT 'moto',
      distance_km REAL,
      duration_min INTEGER,
      price INTEGER NOT NULL,
      platform_fee INTEGER NOT NULL DEFAULT 0,
      driver_earning INTEGER NOT NULL DEFAULT 0,
      payment_method TEXT NOT NULL DEFAULT 'cash',
      tracking_code TEXT UNIQUE,
      ride_pin TEXT,
      driver_id TEXT,
      status TEXT NOT NULL DEFAULT 'searching',
      cancel_reason TEXT,
      medical_protection INTEGER NOT NULL DEFAULT 0,
      medical_fee INTEGER NOT NULL DEFAULT 0,
      dash_fee INTEGER NOT NULL DEFAULT 0,
      msouwout_medical_fee INTEGER NOT NULL DEFAULT 0,
      driver_dash_share REAL NOT NULL DEFAULT 0,
      total_with_protection INTEGER NOT NULL DEFAULT 0,
      is_delegated INTEGER NOT NULL DEFAULT 0,
      orderer_name TEXT,
      orderer_phone TEXT,
      passenger_name TEXT,
      passenger_phone TEXT,
      accepted_at TEXT,
      cancelled_by TEXT,
      cancel_fee INTEGER NOT NULL DEFAULT 0,
      started_at TEXT,
      completed_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      ride_id TEXT,
      driver_id TEXT,
      rider_phone TEXT NOT NULL,
      rider_name TEXT,
      last_message TEXT,
      last_message_at TEXT,
      is_archived INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      sender_type TEXT NOT NULL DEFAULT 'rider',
      sender_id TEXT,
      content TEXT,
      type TEXT NOT NULL DEFAULT 'text',
      file_url TEXT,
      read_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sos_alerts (
      id TEXT PRIMARY KEY,
      phone TEXT NOT NULL,
      name TEXT,
      lat REAL,
      lng REAL,
      ride_id TEXT,
      platform TEXT DEFAULT 'msouwout',
      status TEXT DEFAULT 'active',
      admin_note TEXT,
      responded_at TEXT,
      resolved_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      alert_level TEXT DEFAULT 'warning',
      is_silent INTEGER DEFAULT 0,
      trigger_reason TEXT DEFAULT 'manual'
    );

    CREATE TABLE IF NOT EXISTS ride_shares (
      id TEXT PRIMARY KEY,
      ride_id TEXT NOT NULL,
      share_code TEXT NOT NULL UNIQUE,
      shared_with_name TEXT,
      shared_with_phone TEXT,
      expires_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS trusted_contacts (
      id TEXT PRIMARY KEY,
      owner_phone TEXT NOT NULL,
      contact_name TEXT,
      contact_phone TEXT NOT NULL,
      relationship TEXT DEFAULT 'family',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS route_checkpoints (
      id TEXT PRIMARY KEY,
      ride_id TEXT NOT NULL,
      lat REAL NOT NULL,
      lng REAL NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS safety_events (
      id TEXT PRIMARY KEY,
      sos_id TEXT,
      ride_id TEXT,
      event_type TEXT NOT NULL,
      data TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS fleets (
      id TEXT PRIMARY KEY,
      owner_name TEXT NOT NULL,
      company_name TEXT,
      phone TEXT NOT NULL,
      email TEXT,
      address TEXT,
      lat REAL,
      lng REAL,
      status TEXT NOT NULL DEFAULT 'pending',
      is_verified INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS trucks (
      id TEXT PRIMARY KEY,
      fleet_id TEXT,
      driver_id TEXT,
      truck_type TEXT NOT NULL,
      make TEXT,
      model TEXT,
      year INTEGER,
      license_plate TEXT,
      registration_url TEXT,
      insurance_url TEXT,
      photo_url TEXT,
      payload_capacity_kg INTEGER,
      payload_capacity_desc TEXT,
      is_available INTEGER DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'pending',
      is_verified INTEGER DEFAULT 0,
      current_lat REAL,
      current_lng REAL,
      last_location_update TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS freight_loads (
      id TEXT PRIMARY KEY,
      tracking_code TEXT UNIQUE,
      posted_by_phone TEXT NOT NULL,
      posted_by_name TEXT,
      business_id TEXT,
      cargo_type TEXT NOT NULL,
      cargo_description TEXT,
      weight_kg INTEGER,
      quantity TEXT,
      truck_type_needed TEXT,
      pickup_address TEXT,
      pickup_lat REAL NOT NULL,
      pickup_lng REAL NOT NULL,
      pickup_contact TEXT,
      pickup_phone TEXT,
      dropoff_address TEXT,
      dropoff_lat REAL NOT NULL,
      dropoff_lng REAL NOT NULL,
      dropoff_contact TEXT,
      dropoff_phone TEXT,
      distance_km REAL,
      price INTEGER,
      currency TEXT DEFAULT 'HTG',
      urgency TEXT DEFAULT 'normal',
      pickup_date TEXT,
      notes TEXT,
      pickup_pin TEXT,
      delivery_pin TEXT,
      status TEXT NOT NULL DEFAULT 'posted',
      assigned_truck_id TEXT,
      assigned_driver_id TEXT,
      assigned_at TEXT,
      picked_up_at TEXT,
      in_transit_at TEXT,
      delivered_at TEXT,
      cancelled_at TEXT,
      cancel_reason TEXT,
      platform_fee INTEGER DEFAULT 0,
      driver_earning INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS delivery_receipts (
      id TEXT PRIMARY KEY,
      load_id TEXT NOT NULL,
      receipt_type TEXT NOT NULL DEFAULT 'delivery',
      photo_url TEXT,
      signature_url TEXT,
      confirmed_by_name TEXT,
      confirmed_by_phone TEXT,
      lat REAL,
      lng REAL,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS medical_claims (
      id TEXT PRIMARY KEY,
      ride_id TEXT NOT NULL,
      claimant_name TEXT,
      claimant_phone TEXT,
      description TEXT NOT NULL,
      photos TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      admin_note TEXT,
      reviewed_by TEXT,
      reviewed_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS dash_settlements (
      id TEXT PRIMARY KEY,
      period_start TEXT NOT NULL,
      period_end TEXT NOT NULL,
      total_rides INTEGER NOT NULL DEFAULT 0,
      total_protection_fees INTEGER NOT NULL DEFAULT 0,
      dash_amount INTEGER NOT NULL DEFAULT 0,
      msouwout_amount INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      dash_bank_ref TEXT,
      transferred_at TEXT,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS accident_reports (
      id TEXT PRIMARY KEY,
      ride_id TEXT,
      reporter_type TEXT NOT NULL DEFAULT 'passenger',
      reporter_name TEXT,
      reporter_phone TEXT,
      driver_name TEXT,
      driver_phone TEXT,
      vehicle_info TEXT,
      gps_lat REAL,
      gps_lng REAL,
      description TEXT,
      severity TEXT DEFAULT 'moderate',
      dash_notified INTEGER NOT NULL DEFAULT 0,
      dash_notified_at TEXT,
      sms_sent INTEGER NOT NULL DEFAULT 0,
      whatsapp_sent INTEGER NOT NULL DEFAULT 0,
      nearest_facility TEXT,
      status TEXT NOT NULL DEFAULT 'reported',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS referral_partners (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      contact_name TEXT,
      contact_phone TEXT,
      contact_email TEXT,
      commission_pct REAL NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // Seed zones
  const seedSql = fs.readFileSync(path.join(__dirname, 'seed-zones.sql'), 'utf8');
  const inserts = seedSql.match(/INSERT INTO zones[^;]+;/gs) || [];
  for (const insert of inserts) {
    try {
      let sqliteInsert = insert
        .replace(/UUID\s+PRIMARY KEY DEFAULT uuid_generate_v4\(\)/gi, 'TEXT PRIMARY KEY')
        .replace(/ON CONFLICT DO NOTHING/gi, 'ON CONFLICT DO NOTHING');
      if (!sqliteInsert.includes("VALUES")) continue;
      const valuesMatch = sqliteInsert.match(/VALUES\s*\(([\s\S]+)\)/);
      if (!valuesMatch) continue;
      const hasId = sqliteInsert.includes('(id,') || sqliteInsert.includes('( id,');
      if (!hasId) {
        sqliteInsert = sqliteInsert.replace(
          /INSERT INTO zones \(/,
          `INSERT INTO zones (id, `
        );
        sqliteInsert = sqliteInsert.replace(
          /VALUES\s*\(/,
          `VALUES ('${uuidv4()}', `
        );
      }
      sqliteInsert = sqliteInsert.replace(/NULL(?=\s*,\s*'?\{)/g, "NULL");
      db.exec(sqliteInsert);
    } catch (e) {
      if (!e.message.includes('UNIQUE constraint')) {
        console.error('Zone seed error:', e.message);
      }
    }
  }

  // Seed referral partner
  try {
    db.exec(`INSERT INTO referral_partners (id, code, name, commission_pct) VALUES ('${uuidv4()}', 'FTPH/COTRASMOTHA', 'FTPH/COTRASMOTHA', 0) ON CONFLICT (code) DO NOTHING;`);
  } catch (e) {}

  console.log('SQLite database initialized with all tables and seed data.');
  db.close();
}

module.exports = { initSqliteDatabase };
