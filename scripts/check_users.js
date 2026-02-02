require('dotenv').config();
const { Pool } = require('pg');

const sslRequired = process.env.DATABASE_URL && (process.env.DATABASE_URL.includes('neon.tech') || process.env.DATABASE_URL.includes('supabase') || process.env.NODE_ENV === 'production');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: sslRequired ? { rejectUnauthorized: false } : false
});

async function main() {
  try {
    const { rows } = await pool.query('SELECT id, username, is_admin, super_admin FROM employees ORDER BY id');
    console.table(rows);
  } catch (err) {
    console.error(err);
  } finally {
    await pool.end();
  }
}

main();
