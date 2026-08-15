let pool;

if (process.env.DATABASE_URL) {
  const { Pool } = require('pg');
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
    max: 20,
    idleTimeoutMillis: 30000,
  });
  pool.on('error', (err) => {
    console.error('Unexpected error on idle client', err);
  });
  console.log('Using PostgreSQL database');
} else {
  pool = require('./sqlite-pool');
  console.log('Using SQLite database (local mode)');
}

module.exports = pool;
