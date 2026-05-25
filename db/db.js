const { Pool } = require('pg');

// Railway PostgreSQL always needs SSL; detect by presence of DATABASE_URL with sslmode
// or fall back to checking NODE_ENV. Using rejectUnauthorized:false is safe for managed DBs.
const useSSL = process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: (process.env.NODE_ENV === 'production' || useSSL) ? { rejectUnauthorized: false } : false,
});

pool.on('error', (err) => {
  console.error('Unexpected database error:', err);
});

module.exports = {
  query: (text, params) => pool.query(text, params),
  getClient: () => pool.connect(),
  pool,
};
