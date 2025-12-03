require('dotenv').config()
const { Pool } = require('pg')

const sslRequired = process.env.DATABASE_URL && (process.env.DATABASE_URL.includes('neon.tech') || process.env.DATABASE_URL.includes('supabase') || process.env.NODE_ENV === 'production')
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: sslRequired ? { rejectUnauthorized: false } : false
})

async function main() {
  await pool.query('DELETE FROM punches')
  console.log('All punch activity deleted')
  await pool.end()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

