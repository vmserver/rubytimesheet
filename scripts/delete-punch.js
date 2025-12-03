require('dotenv').config()
const { Pool } = require('pg')

const sslRequired = process.env.DATABASE_URL && (process.env.DATABASE_URL.includes('neon.tech') || process.env.DATABASE_URL.includes('supabase') || process.env.NODE_ENV === 'production')
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: sslRequired ? { rejectUnauthorized: false } : false
})

function parseArgs() {
  const args = process.argv.slice(2)
  const out = {}
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a.startsWith('--')) {
      const key = a.replace(/^--/, '')
      const val = args[i + 1]
      out[key] = val
      i++
    }
  }
  return out
}

async function main() {
  const { username, date, time, type } = parseArgs()
  if (!username || !date || !time || !type) {
    console.error('Usage: node scripts/delete-punch.js --username <user> --date YYYY-MM-DD --time HH:MM:SS --type in|out|break_start|break_end')
    process.exit(1)
  }

  const { rows: users } = await pool.query('SELECT id FROM employees WHERE username = $1', [username])
  if (users.length === 0) {
    console.error('User not found:', username)
    process.exit(1)
  }
  const userId = users[0].id

  const nyLocal = `${date} ${time}`
  const { rowCount } = await pool.query(
    "DELETE FROM punches WHERE employee_id = $1 AND punch_type = $2 AND date_trunc('second', (punched_at AT TIME ZONE 'America/New_York')) = $3::timestamp",
    [userId, type, nyLocal]
  )
  console.log('Deleted rows:', rowCount, 'for', username, nyLocal, type)
  await pool.end()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

