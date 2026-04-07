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
