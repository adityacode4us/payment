const { Pool, types } = require('pg');
const fs = require('fs');
const path = require('path');
const logger = require('./logger');

// Parse BIGINT (int8, OID 20) as JavaScript number instead of string
// Safe for paise amounts (max safe integer is ~9 quadrillion paise = ~90 trillion rupees)
types.setTypeParser(20, (val) => parseInt(val, 10));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://wallet:wallet@localhost:5432/wallet',
  max: 20,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

async function runMigrations() {
  const migrationPath = path.join(__dirname, '..', 'migrations', '001_init.sql');
  const sql = fs.readFileSync(migrationPath, 'utf8');
  await pool.query(sql);
  logger.info('migrations completed');
}

module.exports = { pool, runMigrations };
