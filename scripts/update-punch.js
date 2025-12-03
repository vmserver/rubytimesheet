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

// Let PostgreSQL handle timezone conversion precisely
function nyLocalString(dateStr, timeStr) {
  return `${dateStr} ${timeStr}`
}

async function main() {
  const { username, date, newTime } = parseArgs()
  if (!username || !date || !newTime) {
    console.error('Usage: node scripts/update-punch.js --username <user> --date YYYY-MM-DD --newTime HH:MM:SS')
    process.exit(1)
  }

  const { rows: users } = await pool.query('SELECT id FROM employees WHERE username = $1', [username])
  if (users.length === 0) {
    console.error('User not found:', username)
    process.exit(1)
  }
  const userId = users[0].id

  const { rows: punches } = await pool.query(
    'SELECT id, punch_type, punched_at FROM punches WHERE employee_id = $1 ORDER BY punched_at ASC',
    [userId]
  )

  const nyDateKey = new Date(date).toLocaleDateString('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' })

  const inPunchesForDay = punches.filter((p) => {
    if (p.punch_type !== 'in') return false
    const key = new Date(p.punched_at).toLocaleDateString('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' })
    return key === nyDateKey
  })

  if (inPunchesForDay.length === 0) {
    console.error('No punch-in records found for', username, 'on', date)
    process.exit(1)
  }

  const targetPunch = inPunchesForDay[0]
  const nyLocal = nyLocalString(date, newTime)
  await pool.query("UPDATE punches SET punched_at = ($1::timestamp AT TIME ZONE 'America/New_York') WHERE id = $2", [nyLocal, targetPunch.id])
  console.log('Updated punch id', targetPunch.id, 'to NY local', nyLocal)
  await pool.end()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
