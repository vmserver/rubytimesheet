require('dotenv').config();

const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const path = require('path');
const bcrypt = require('bcrypt');
const { Pool } = require('pg');
const ExcelJS = require('exceljs');
const EXCELJS_VERSION = require('exceljs/package.json').version;

const app = express();
const PORT = process.env.PORT || 3000;

// Configure timezone for display (server should run in UTC; we'll format as New York time in views)
const TIMEZONE = 'America/New_York';

// Database pool (use Render PostgreSQL DATABASE_URL)
// Neon and most cloud databases require SSL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('neon.tech') || process.env.DATABASE_URL?.includes('supabase') || process.env.NODE_ENV === 'production' 
    ? { rejectUnauthorized: false } 
    : false
});

// Initialize tables
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS employees (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      email VARCHAR(150) UNIQUE NOT NULL,
      username VARCHAR(50) UNIQUE NOT NULL,
      password_hash VARCHAR(200) NOT NULL,
      is_admin BOOLEAN NOT NULL DEFAULT FALSE,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS punches (
      id SERIAL PRIMARY KEY,
      employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      punch_type VARCHAR(20) NOT NULL, -- in, out, break_start, break_end
      punched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Create session table for connect-pg-simple
  await pool.query(`
    CREATE TABLE IF NOT EXISTS session (
      sid VARCHAR NOT NULL COLLATE "default",
      sess JSON NOT NULL,
      expire TIMESTAMP(6) NOT NULL,
      CONSTRAINT session_pkey PRIMARY KEY (sid) NOT DEFERRABLE INITIALLY IMMEDIATE
    );
  `);
  
  // Create index on expire for session cleanup
  await pool.query(`
    CREATE INDEX IF NOT EXISTS IDX_session_expire ON session (expire);
  `);

  // Create initial admin if none exists
  const adminEmail = process.env.ADMIN_EMAIL || 'admin@example.com';
  const adminUser = process.env.ADMIN_USERNAME || 'admin';
  const adminPass = process.env.ADMIN_PASSWORD || 'changeme123';

  const { rows } = await pool.query('SELECT id FROM employees WHERE is_admin = TRUE LIMIT 1');
  if (rows.length === 0) {
    const passwordHash = await bcrypt.hash(adminPass, 10);
    await pool.query(
      `INSERT INTO employees (name, email, username, password_hash, is_admin, active)
       VALUES ($1, $2, $3, $4, TRUE, TRUE)`,
      ['Admin', adminEmail, adminUser, passwordHash]
    );
    console.log('Initial admin created:');
    console.log(`  Username: ${adminUser}`);
    console.log(`  Email:    ${adminEmail}`);
    console.log(`  Password: ${adminPass}`);
  }
}

// Session setup
app.set('trust proxy', 1);
app.use(
  session({
    store: new PgSession({
      pool,
      tableName: 'session'
    }),
    secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 1000 * 60 * 60 * 8, // 8 hours
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production'
    }
  })
);

app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Brand name for header (avoid hardcoding in views)
const BRAND_NAME = process.env.BRAND_NAME || 'Ruby Group Inc. Employee Timesheet';
app.use((req, res, next) => {
  res.locals.brand = BRAND_NAME;
  next();
});

app.use(async (req, res, next) => {
  try {
    if (req.session && req.session.user && !req.session.rollover_checked) {
      await ensureBackfillForUser(req.session.user.id, 7);
      req.session.rollover_checked = true;
    }
  } catch (e) {
  } finally {
    next();
  }
});

// Helper to get current user
function requireAuth(req, res, next) {
  if (!req.session.user) {
    return res.redirect('/login');
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.user || !req.session.user.is_admin) {
    return res.status(403).send('Forbidden');
  }
  next();
}

// Date formatting helper for views
function toLocalString(date) {
  return new Date(date).toLocaleString('en-US', { timeZone: TIMEZONE });
}

app.locals.toLocalString = toLocalString;

// Calculate hours worked from punches
// Simple logic: Sum all time between punch in and punch out, excluding breaks
// Handles multiple in/out cycles and breaks in a single day
function calculateHours(punches, currentTime = null) {
  if (!punches || punches.length === 0) {
    console.log('calculateHours: No punches provided');
    return 0;
  }
  
  let totalMinutes = 0;
  let inTime = null; // When the current work session started
  let breakStart = null; // When the current break started (if any)
  
  // Process punches in chronological order
  const sortedPunches = [...punches].sort((a, b) => 
    new Date(a.punched_at) - new Date(b.punched_at)
  );
  
  console.log('calculateHours: Processing', sortedPunches.length, 'punches');
  console.log('calculateHours: Punch sequence:', sortedPunches.map(p => `${p.punch_type}@${new Date(p.punched_at).toISOString()}`).join(', '));
  
  for (const punch of sortedPunches) {
    const punchTime = new Date(punch.punched_at);
    
    switch (punch.punch_type) {
      case 'in':
        // Starting a new work session
        // If there was a previous incomplete session, it's already counted (or will be counted at out)
        inTime = punchTime;
        breakStart = null; // Clear any break state
        console.log('calculateHours: Punch IN at', punchTime.toISOString());
        break;
        
      case 'break_start':
        // Starting a break - add work time from inTime (or last break_end) to break start
        if (inTime && !breakStart) {
          const workMinutes = (punchTime - inTime) / (1000 * 60);
          totalMinutes += workMinutes;
          console.log('calculateHours: Break START - added', workMinutes.toFixed(2), 'minutes of work, total:', totalMinutes.toFixed(2));
        } else if (!inTime) {
          console.log('calculateHours: WARNING - break_start without punch in, ignoring');
        }
        breakStart = punchTime; // Mark that we're on break
        break;
        
      case 'break_end':
        // Ending a break - resume counting from break end
        if (breakStart) {
          // Break time is excluded, just resume counting from break end
          inTime = punchTime; // Resume work from break end
          breakStart = null;
          console.log('calculateHours: Break END - resuming work from', punchTime.toISOString());
        } else {
          console.log('calculateHours: WARNING - break_end without break_start, treating as punch in');
          inTime = punchTime;
        }
        break;
        
      case 'out':
        // Ending work session - add time from inTime (or last break_end) to out
        if (inTime && !breakStart) {
          const workMinutes = (punchTime - inTime) / (1000 * 60);
          totalMinutes += workMinutes;
          console.log('calculateHours: Punch OUT - added', workMinutes.toFixed(2), 'minutes of work, total:', totalMinutes.toFixed(2));
        } else if (inTime && breakStart) {
          // Out while on break - add work time up to break start only
          const workMinutes = (breakStart - inTime) / (1000 * 60);
          totalMinutes += workMinutes;
          console.log('calculateHours: Punch OUT during break - added', workMinutes.toFixed(2), 'minutes (up to break start), total:', totalMinutes.toFixed(2));
        } else {
          console.log('calculateHours: WARNING - punch out without punch in, ignoring');
        }
        // Reset for next session
        inTime = null;
        breakStart = null;
        break;
    }
  }
  
  // If still punched in at the end (no out), add remaining time up to now
  if (inTime && !breakStart) {
    const endTime = currentTime || new Date();
    const remainingMinutes = (endTime - inTime) / (1000 * 60);
    totalMinutes += remainingMinutes;
    console.log('calculateHours: Still punched in - added', remainingMinutes.toFixed(2), 'minutes, total:', totalMinutes.toFixed(2));
  } else if (inTime && breakStart) {
    // Still on break - only count work time up to break start
    const workMinutes = (breakStart - inTime) / (1000 * 60);
    totalMinutes += workMinutes;
    console.log('calculateHours: Still on break - added', workMinutes.toFixed(2), 'minutes (up to break start), total:', totalMinutes.toFixed(2));
  }
  
  const hours = totalMinutes / 60;
  console.log('calculateHours: Final result', hours.toFixed(2), 'hours (', totalMinutes.toFixed(2), 'minutes)');
  return hours;
}

// Format date as YYYY-MM-DD in NY timezone (for database queries)
function formatDateNY(date) {
  if (!date) {
    const now = new Date();
    const nyStr = now.toLocaleDateString('en-US', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
    const [month, day, year] = nyStr.split('/');
    return `${year}-${month}-${day}`;
  }
  const d = new Date(date);
  if (isNaN(d.getTime())) {
    const now = new Date();
    const nyStr = now.toLocaleDateString('en-US', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
    const [month, day, year] = nyStr.split('/');
    return `${year}-${month}-${day}`;
  }
  
  // Convert to NY timezone date string
  const nyStr = d.toLocaleDateString('en-US', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
  const [month, day, year] = nyStr.split('/');
  return `${year}-${month}-${day}`;
}

// Format date as MM/DD/YYYY in NY timezone (for display)
function formatDateNYDisplay(date) {
  if (!date) {
    const now = new Date();
    return now.toLocaleDateString('en-US', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
  }
  const d = new Date(date);
  if (isNaN(d.getTime())) {
    const now = new Date();
    return now.toLocaleDateString('en-US', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
  }
  
  return d.toLocaleDateString('en-US', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
}

// Convert YYYY-MM-DD (NY timezone) to UTC Date for database query
function parseNYDateToUTC(dateString) {
  if (!dateString) return null;
  // Create a date string that represents midnight in NY
  // We'll use Intl.DateTimeFormat to get the proper conversion
  const [year, month, day] = dateString.split('-').map(Number);
  
  // Create a date object assuming it's in NY timezone
  // Format: YYYY-MM-DD as if it's in NY timezone
  const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T00:00:00`;
  
  // Use a trick: create date in local, then adjust for NY timezone
  const localDate = new Date(dateStr);
  const nyDateStr = localDate.toLocaleString('en-US', { timeZone: TIMEZONE });
  const nyDate = new Date(nyDateStr);
  const offset = localDate.getTime() - nyDate.getTime();
  
  // Create the actual NY midnight date
  const targetNY = new Date(year, month - 1, day);
  const targetNYStr = targetNY.toLocaleString('en-US', { timeZone: TIMEZONE });
  const targetNYDate = new Date(targetNYStr);
  const targetLocal = new Date(targetNYDate.getTime() + offset);
  
  return targetLocal;
}

function getNYEndOfDayUTCFromMMDDYYYY(mmddyyyy) {
  const [month, day, year] = mmddyyyy.split('/').map(Number);
  const offsetMin = (() => {
    const probe = new Date(Date.UTC(year, month - 1, day, 12));
    const s = new Intl.DateTimeFormat('en-US', { timeZone: TIMEZONE, timeZoneName: 'shortOffset', hour: '2-digit', minute: '2-digit' }).format(probe);
    const m = s.match(/GMT([+-]\d+)/);
    const hours = m ? parseInt(m[1], 10) : -5;
    return hours * 60;
  })();
  const utcMillis = Date.UTC(year, month - 1, day, 23, 59, 59) + (-offsetMin) * 60 * 1000;
  return new Date(utcMillis);
}

function nyLocalToUTC(y, m, d, h = 0, mi = 0, s = 0) {
  const probe = new Date(Date.UTC(y, m - 1, d, 12));
  const str = new Intl.DateTimeFormat('en-US', { timeZone: TIMEZONE, timeZoneName: 'shortOffset', hour: '2-digit', minute: '2-digit' }).format(probe);
  const mm = str.match(/GMT([+-]\d+)/);
  const hours = mm ? parseInt(mm[1], 10) : -5;
  const offsetMin = hours * 60;
  const utcMillis = Date.UTC(y, m - 1, d, h, mi, s) + (-offsetMin) * 60 * 1000;
  return new Date(utcMillis);
}

function getStateAt(punches, boundaryUTC) {
  const arr = punches.filter((p) => new Date(p.punched_at) <= boundaryUTC).sort((a, b) => new Date(a.punched_at) - new Date(b.punched_at));
  let state = 'out';
  let onBreak = false;
  for (const p of arr) {
    const t = p.punch_type;
    if (t === 'in') {
      state = 'in';
      onBreak = false;
    } else if (t === 'break_start') {
      if (state === 'in') {
        onBreak = true;
        state = 'break';
      }
    } else if (t === 'break_end') {
      state = 'in';
      onBreak = false;
    } else if (t === 'out') {
      state = 'out';
      onBreak = false;
    }
  }
  return state;
}

async function ensureBackfillForUser(userId, days = 7) {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const y = parseInt(parts.find((p) => p.type === 'year').value);
  const m = parseInt(parts.find((p) => p.type === 'month').value);
  const d = parseInt(parts.find((p) => p.type === 'day').value);
  const startUTC = nyLocalToUTC(y, m, d - days, 0, 0, 0);
  const endUTC = nyLocalToUTC(y, m, d, 0, 0, 0);
  const { rows: punches } = await pool.query(
    `SELECT punch_type, punched_at FROM punches WHERE employee_id = $1 AND punched_at BETWEEN $2 AND $3 ORDER BY punched_at ASC`,
    [userId, startUTC, now]
  );
  let inserted = 0;
  for (let i = days; i >= 1; i--) {
    const boundary = nyLocalToUTC(y, m, d - (i - 1), 0, 0, 0);
    const state = getStateAt(punches, boundary);
    if (state === 'in' || state === 'break') {
      const outTime = new Date(boundary.getTime() - 1000);
      const inTime = boundary;
      const windowStart = new Date(outTime.getTime() - 2000);
      const windowEnd = new Date(inTime.getTime() + 2000);
      const { rows: exists } = await pool.query(
        `SELECT 1 FROM punches WHERE employee_id = $1 AND punched_at BETWEEN $2 AND $3 LIMIT 1`,
        [userId, windowStart, windowEnd]
      );
      if (exists.length === 0) {
        await pool.query(`INSERT INTO punches (employee_id, punch_type, punched_at) VALUES ($1, $2, $3)`, [userId, 'out', outTime]);
        await pool.query(`INSERT INTO punches (employee_id, punch_type, punched_at) VALUES ($1, $2, $3)`, [userId, 'in', inTime]);
        if (state === 'break') {
          const bs = new Date(inTime.getTime() + 1000);
          await pool.query(`INSERT INTO punches (employee_id, punch_type, punched_at) VALUES ($1, $2, $3)`, [userId, 'break_start', bs]);
        }
        inserted++;
      }
    }
  }
  return inserted;
}

// Routes
app.get('/', (req, res) => {
  if (!req.session.user) {
    return res.redirect('/login');
  }
  res.redirect('/dashboard');
});

app.get('/login', (req, res) => {
  if (req.session.user) {
    return res.redirect('/dashboard');
  }
  res.render('login', { error: null });
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const { rows } = await pool.query(
      'SELECT id, name, username, password_hash, is_admin FROM employees WHERE username = $1 AND active = TRUE',
      [username]
    );
    if (rows.length === 0) {
      return res.render('login', { error: 'Invalid username or password' });
    }
    const user = rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.render('login', { error: 'Invalid username or password' });
    }
    req.session.user = {
      id: user.id,
      name: user.name,
      username: user.username,
      is_admin: user.is_admin
    };
    res.redirect('/dashboard');
  } catch (err) {
    console.error(err);
    res.status(500).send('Server error');
  }
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login');
  });
});

// Employee dashboard with punch buttons
app.get('/dashboard', requireAuth, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const { rows: punches } = await pool.query(
      `SELECT id, punch_type, punched_at
       FROM punches
       WHERE employee_id = $1
       ORDER BY punched_at DESC
       LIMIT 20`,
      [userId]
    );
    
    // Determine current state: are they punched in?
    // Check the most recent punch to see if they're currently "in"
    let isPunchedIn = false;
    let isOnBreak = false;
    
    if (punches.length > 0) {
      const lastPunch = punches[0];
      // If last punch was "in" or "break_end", they're punched in
      // If last punch was "out", they're not punched in
      // If last punch was "break_start", they're on break (but still punched in)
      if (lastPunch.punch_type === 'in' || lastPunch.punch_type === 'break_end') {
        isPunchedIn = true;
      } else if (lastPunch.punch_type === 'break_start') {
        isPunchedIn = true;
        isOnBreak = true;
      }
    }
    
    // Calculate today's hours - use EXACT same logic as hours history page
    const now = new Date();
    
    // Get today's date in NY timezone - use Intl.DateTimeFormat for accurate conversion
    const nyFormatter = new Intl.DateTimeFormat('en-US', {
      timeZone: TIMEZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    });
    const parts = nyFormatter.formatToParts(now);
    const todayYear = parseInt(parts.find(p => p.type === 'year').value);
    const todayMonth = parseInt(parts.find(p => p.type === 'month').value);
    const todayDay = parseInt(parts.find(p => p.type === 'day').value);
    
    // Format today as YYYY-MM-DD for database query (same as hours history)
    const todayFormatted = `${todayYear}-${String(todayMonth).padStart(2, '0')}-${String(todayDay).padStart(2, '0')}`;
    
    console.log('Dashboard today calculation:', {
      nowUTC: now.toISOString(),
      todayFormatted,
      todayYear,
      todayMonth,
      todayDay
    });
    
    // Fetch all punches for this user (we'll filter by NY date in JS to avoid timezone edge cases)
    const { rows: allUserPunches } = await pool.query(
      `SELECT punch_type, punched_at
       FROM punches
       WHERE employee_id = $1
       ORDER BY punched_at ASC`,
      [userId]
    );

    // Filter punches that belong to "today" in New York timezone
    const todayPunches = allUserPunches.filter(punch => {
      const punchDateNY = new Date(punch.punched_at).toLocaleDateString('en-US', {
        timeZone: TIMEZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      });
      // Convert MM/DD/YYYY -> YYYY-MM-DD for comparison with todayFormatted
      const [pm, pd, py] = punchDateNY.split('/').map(Number);
      const punchDateFormatted = `${py}-${String(pm).padStart(2, '0')}-${String(pd).padStart(2, '0')}`;
      return punchDateFormatted === todayFormatted;
    });
    
    // Check if still punched in for today (same logic as hours history)
    let stillPunchedInToday = false;
    if (todayPunches.length > 0) {
      const lastPunchToday = todayPunches[todayPunches.length - 1];
      stillPunchedInToday = 
        (lastPunchToday.punch_type === 'in' || lastPunchToday.punch_type === 'break_end' || lastPunchToday.punch_type === 'break_start');
    }
    
    console.log('Today hours calculation - Debug:', { 
      todayFormatted,
      todayYear,
      todayMonth,
      todayDay,
      todayPunchesCount: todayPunches.length,
      todayPunches: todayPunches.map(p => ({ type: p.punch_type, time: p.punched_at })),
      stillPunchedInToday,
      isPunchedIn
    });
    
    const todayHours = calculateHours(todayPunches, stillPunchedInToday ? now : null);
    
    console.log('Today hours result:', todayHours);
    
    console.log('Dashboard state:', { isPunchedIn, isOnBreak, lastPunch: punches[0]?.punch_type, todayHours });

    // Ensure todayHours is a valid number
    const todayHoursDisplay = (todayHours && typeof todayHours === 'number' && !isNaN(todayHours)) ? todayHours.toFixed(2) : '0.00';
    const todayMinutesDisplay = (todayHours && typeof todayHours === 'number' && !isNaN(todayHours)) ? (todayHours * 60).toFixed(2) : '0.00';
    console.log('Today hours to display:', todayHoursDisplay);

    res.render('dashboard', {
      user: req.session.user,
      punches: punches || [],
      isPunchedIn: !!isPunchedIn,
      isOnBreak: !!isOnBreak,
      todayHours: todayHoursDisplay,
      todayMinutes: todayMinutesDisplay,
      errorMessage: req.query.error || null,
      toLocalString: app.locals.toLocalString
    });
  } catch (err) {
    console.error('❌ Dashboard error:', err);
    console.error('Error stack:', err.stack);
    // Send detailed error for debugging
    res.status(500).send(`Server error: ${err.message}\n\nStack: ${err.stack}`);
  }
});

// Punch endpoints
app.post('/punch/:type', requireAuth, async (req, res) => {
  const { type } = req.params;
  const allowed = ['in', 'out', 'break_start', 'break_end'];
  if (!allowed.includes(type)) {
    return res.status(400).send('Invalid punch type');
  }
  
  try {
    const userId = req.session.user.id;
    
    // Get the most recent punch to check current state
    const { rows: recentPunches } = await pool.query(
      `SELECT punch_type FROM punches 
       WHERE employee_id = $1 
       ORDER BY punched_at DESC 
       LIMIT 1`,
      [userId]
    );
    
    // Validation for break actions
    if (type === 'break_start') {
      if (recentPunches.length === 0) {
        return res.redirect('/dashboard?error=Please punch in first before taking a break');
      }
      
      const lastPunchType = recentPunches[0].punch_type;
      // Can only start break if last action was "in" or "break_end" (punched in, not on break)
      if (lastPunchType !== 'in' && lastPunchType !== 'break_end') {
        return res.redirect('/dashboard?error=Please punch in first before taking a break');
      }
      
      // Can't start break if already on break
      if (lastPunchType === 'break_start') {
        return res.redirect('/dashboard?error=You are already on a break. End your break first.');
      }
    }
    
    if (type === 'break_end') {
      if (recentPunches.length === 0) {
        return res.redirect('/dashboard?error=You are not currently on a break.');
      }
      
      const lastPunchType = recentPunches[0].punch_type;
      // Can only end break if currently on break
      if (lastPunchType !== 'break_start') {
        return res.redirect('/dashboard?error=You are not currently on a break.');
      }
    }
    
    // Can't punch in if already punched in (unless they punched out)
    if (type === 'in' && recentPunches.length > 0) {
      const lastPunchType = recentPunches[0].punch_type;
      if (lastPunchType === 'in' || lastPunchType === 'break_start' || lastPunchType === 'break_end') {
        return res.redirect('/dashboard?error=You are already punched in. Please punch out first.');
      }
    }
    
    // Can't punch out if not punched in
    if (type === 'out') {
      if (recentPunches.length === 0) {
        return res.redirect('/dashboard?error=Please punch in first.');
      }
      const lastPunchType = recentPunches[0].punch_type;
      if (lastPunchType === 'out') {
        return res.redirect('/dashboard?error=You are already punched out. Please punch in first.');
      }
      // Can't punch out while on break - must end break first
      if (lastPunchType === 'break_start') {
        return res.redirect('/dashboard?error=Please end your break before punching out.');
      }
    }
    
    await pool.query(
      'INSERT INTO punches (employee_id, punch_type) VALUES ($1, $2)',
      [userId, type]
    );
    res.redirect('/dashboard');
  } catch (err) {
    console.error(err);
    res.status(500).send('Server error');
  }
});

// Admin: list employees
app.get('/admin/employees', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { rows: employees } = await pool.query(
      'SELECT id, name, email, username, is_admin, active, created_at FROM employees WHERE active = TRUE ORDER BY id'
    );
    res.render('admin_employees', { user: req.session.user, employees });
  } catch (err) {
    console.error(err);
    res.status(500).send('Server error');
  }
});

app.get('/admin/export', requireAuth, requireAdmin, (req, res) => {
  try {
    res.render('admin_export', { user: req.session.user });
  } catch (err) {
    console.error(err);
    res.status(500).send('Server error');
  }
});


app.get('/admin/export.xlsx', requireAuth, requireAdmin, async (req, res) => {
  try {
    const REGULAR_HOURS_PER_DAY = parseFloat(process.env.REGULAR_HOURS_PER_DAY || '8');
    const MAX_EXPORT_DAYS = parseInt(process.env.MAX_EXPORT_DAYS || '730', 10);

    let startDateFormatted = req.query.startDate;
    let endDateFormatted = req.query.endDate;
    if (!startDateFormatted || !endDateFormatted) {
      const now = new Date();
      const nyFormatter = new Intl.DateTimeFormat('en-US', {
        timeZone: TIMEZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      });
      const parts = nyFormatter.formatToParts(now);
      const todayYear = parseInt(parts.find(p => p.type === 'year').value);
      const todayMonth = parseInt(parts.find(p => p.type === 'month').value);
      const todayDay = parseInt(parts.find(p => p.type === 'day').value);
      endDateFormatted = `${todayYear}-${String(todayMonth).padStart(2, '0')}-${String(todayDay).padStart(2, '0')}`;
      const todayNY = new Date(todayYear, todayMonth - 1, todayDay);
      const startNY = new Date(todayNY);
      startNY.setDate(startNY.getDate() - 89);
      const startYear = startNY.getFullYear();
      const startMonth = startNY.getMonth() + 1;
      const startDay = startNY.getDate();
      startDateFormatted = `${startYear}-${String(startMonth).padStart(2, '0')}-${String(startDay).padStart(2, '0')}`;
    }

    const { rows: employees } = await pool.query(
      `SELECT id, name FROM employees ORDER BY name`
    );

    const { rows: punches } = await pool.query(
      `SELECT e.id AS employee_id, e.name, p.punch_type, p.punched_at
       FROM punches p
       JOIN employees e ON e.id = p.employee_id
       WHERE ((p.punched_at AT TIME ZONE 'America/New_York')::date BETWEEN $1::date AND $2::date)
       ORDER BY p.punched_at ASC`,
      [startDateFormatted, endDateFormatted]
    );

    function formatNYDateMMDDYYYY(d) {
      return new Date(d).toLocaleDateString('en-US', {
        timeZone: TIMEZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      });
    }

    function formatNYTime12h(d) {
      return new Date(d).toLocaleString('en-US', {
        timeZone: TIMEZONE,
        hour: '2-digit',
        minute: '2-digit',
        hour12: true
      }).split(', ')[1] || new Date(d).toLocaleTimeString('en-US', { timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit', hour12: true });
    }

    const now = new Date();
    const punchesByEmpByDate = new Map();
    for (const p of punches) {
      const dateKey = new Date(p.punched_at).toLocaleDateString('en-US', {
        timeZone: TIMEZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      });
      if (!punchesByEmpByDate.has(dateKey)) punchesByEmpByDate.set(dateKey, new Map());
      const empMap = punchesByEmpByDate.get(dateKey);
      if (!empMap.has(p.employee_id)) empMap.set(p.employee_id, []);
      empMap.get(p.employee_id).push(p);
    }

    const [startY, startM, startD] = startDateFormatted.split('-').map(Number);
    const [endY, endM, endD] = endDateFormatted.split('-').map(Number);
    const startNoonUTC = Date.UTC(startY, startM - 1, startD, 12);
    const endNoonUTC = Date.UTC(endY, endM - 1, endD, 12);
    const daysDiff = Math.floor((endNoonUTC - startNoonUTC) / (1000 * 60 * 60 * 24)) + 1;
    if (daysDiff > MAX_EXPORT_DAYS) {
      return res.status(400).send(`Date range too large. Limit is ${MAX_EXPORT_DAYS} days.`);
    }
    const dateKeys = [];
    for (let t = startNoonUTC; t <= endNoonUTC; t += 24 * 60 * 60 * 1000) {
      const d = new Date(t);
      const dateKey = d.toLocaleDateString('en-US', {
        timeZone: TIMEZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      });
      dateKeys.push(dateKey);
    }

    function computeDayStats(dayPunches, isToday) {
      const sorted = [...dayPunches].sort((a, b) => new Date(a.punched_at) - new Date(b.punched_at));
      const inTimes = [];
      const outTimes = [];
      let breakStart = null;
      let breakMinutes = 0;
      for (const p of sorted) {
        const t = new Date(p.punched_at);
        if (p.punch_type === 'in') {
          inTimes.push(formatNYTime12h(t));
        } else if (p.punch_type === 'out') {
          outTimes.push(formatNYTime12h(t));
        } else if (p.punch_type === 'break_start') {
          breakStart = t;
        } else if (p.punch_type === 'break_end') {
          if (breakStart) {
            breakMinutes += (t - breakStart) / (1000 * 60);
            breakStart = null;
          }
        }
      }
      const stillPunchedIn = isToday && sorted.length > 0 && (
        sorted[sorted.length - 1].punch_type === 'in' ||
        sorted[sorted.length - 1].punch_type === 'break_end' ||
        sorted[sorted.length - 1].punch_type === 'break_start'
      );
      const totalHours = calculateHours(sorted, stillPunchedIn ? now : null);
      const breakHours = breakMinutes / 60;
      const overtimeHours = Math.max(totalHours - REGULAR_HOURS_PER_DAY, 0);
      return { inTimes, outTimes, breakHours, totalHours, overtimeHours };
    }

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Timesheet');

    const header1 = ['DATES'];
    for (const emp of employees) header1.push(emp.name, '', '', '', '');
    const header2 = ['DATE'];
    for (const _ of employees) header2.push('Punch In', 'Total Break', 'Punch Out', 'Total Hours Worked', 'Overtime Hours');

    sheet.addRow(header1);
    sheet.addRow(header2);

    sheet.getRow(1).font = { bold: true };
    sheet.getRow(2).font = { bold: true };

    // Wrap text for punch in/out columns
    let col = 2;
    for (let i = 0; i < employees.length; i++) {
      sheet.getColumn(col).width = 12; // Punch In
      sheet.getColumn(col).alignment = { wrapText: true };
      sheet.getColumn(col + 2).width = 12; // Punch Out
      sheet.getColumn(col + 2).alignment = { wrapText: true };
      sheet.getColumn(col + 1).width = 12; // Break
      sheet.getColumn(col + 3).width = 16; // Total Hours
      sheet.getColumn(col + 4).width = 16; // Overtime
      col += 5;
    }

    for (const dateKey of dateKeys) {
      const [mm, dd, yyyy] = dateKey.split('/');
      const isWeekend = (() => { const d = new Date(yyyy, mm - 1, dd); const w = d.getDay(); return w === 0 || w === 6; })();
      const rowValues = [`${mm}/${dd}/${yyyy}`];
      const empMap = punchesByEmpByDate.get(dateKey) || new Map();
      const todayNYStr = new Date(now).toLocaleDateString('en-US', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
      const isToday = dateKey === todayNYStr;

      for (const emp of employees) {
        const dayPunches = empMap.get(emp.id) || [];
        const stats = dayPunches.length ? computeDayStats(dayPunches, isToday) : null;
        const punchInCell = stats && stats.inTimes.length ? stats.inTimes.join('\n') : '';
        const punchOutCell = stats && stats.outTimes.length ? stats.outTimes.join('\n') : '';
        const breakCell = stats ? (stats.breakHours || 0).toFixed(2) : '';
        const totalCell = stats ? (stats.totalHours || 0).toFixed(2) : '';
        const overtimeCell = stats ? (stats.overtimeHours || 0).toFixed(2) : '';
        rowValues.push(punchInCell, breakCell, punchOutCell, totalCell, overtimeCell);
      }

      const row = sheet.addRow(rowValues);
      if (isWeekend) {
        row.eachCell((cell) => {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2CC' } };
        });
      }
    }

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="timesheet_${startDateFormatted}_${endDateFormatted}.xlsx"`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error(err);
    res.status(500).send('Server error');
  }
});

app.get('/health', async (req, res) => {
  let dbConnected = false;
  try {
    const { rows } = await pool.query('SELECT 1');
    dbConnected = rows && rows.length > 0;
  } catch (e) {
    dbConnected = false;
  }
  res.json({
    status: 'ok',
    dbConnected,
    exceljsVersion: EXCELJS_VERSION,
    serverTimeUTC: new Date().toISOString(),
    timezone: TIMEZONE,
    port: PORT
  });
});

app.get('/dev/login-with-token', async (req, res) => {
  const token = req.query.token;
  if (!token || token !== (process.env.DEV_TEST_TOKEN || '')) return res.status(403).send('Forbidden');
  const { rows } = await pool.query('SELECT id, name, username, is_admin FROM employees WHERE is_admin = TRUE LIMIT 1');
  if (rows.length === 0) return res.status(500).send('No admin available');
  req.session.user = { id: rows[0].id, name: rows[0].name, username: rows[0].username, is_admin: rows[0].is_admin };
  res.redirect('/dashboard');
});

app.get('/dev/simulate-cross-midnight', async (req, res) => {
  const token = req.query.token;
  let user = req.session.user;
  if (!user && token && token === (process.env.DEV_TEST_TOKEN || '')) {
    const { rows } = await pool.query('SELECT id, name, username, is_admin FROM employees WHERE is_admin = TRUE LIMIT 1');
    if (rows.length === 0) return res.status(500).send('No admin available');
    req.session.user = { id: rows[0].id, name: rows[0].name, username: rows[0].username, is_admin: rows[0].is_admin };
    user = req.session.user;
  }
  if (!user) return res.status(403).send('Forbidden');
  const state = req.query.state === 'break' ? 'break' : 'in';
  const userId = user.id;
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const y = parseInt(parts.find(p => p.type === 'year').value);
  const m = parseInt(parts.find(p => p.type === 'month').value);
  const d = parseInt(parts.find(p => p.type === 'day').value);
  const inTime = nyLocalToUTC(y, m, d - 1, 23, 0, 0);
  const dupWindowStart = new Date(inTime.getTime() - 1000);
  const dupWindowEnd = new Date(inTime.getTime() + 1000);
  const { rows: exists } = await pool.query(
    `SELECT 1 FROM punches WHERE employee_id = $1 AND punch_type = 'in' AND punched_at BETWEEN $2 AND $3 LIMIT 1`,
    [userId, dupWindowStart, dupWindowEnd]
  );
  if (exists.length === 0) {
    await pool.query('INSERT INTO punches (employee_id, punch_type, punched_at) VALUES ($1, $2, $3)', [userId, 'in', inTime]);
  }
  let breakStart = null;
  if (state === 'break') {
    breakStart = new Date(inTime.getTime() + 30 * 60 * 1000);
    const { rows: brExists } = await pool.query(
      `SELECT 1 FROM punches WHERE employee_id = $1 AND punch_type = 'break_start' AND punched_at BETWEEN $2 AND $3 LIMIT 1`,
      [userId, new Date(breakStart.getTime() - 1000), new Date(breakStart.getTime() + 1000)]
    );
    if (brExists.length === 0) {
      await pool.query('INSERT INTO punches (employee_id, punch_type, punched_at) VALUES ($1, $2, $3)', [userId, 'break_start', breakStart]);
    }
  }
  if (req.query.json === '1') {
    return res.json({ inserted: { in: inTime.toISOString(), break_start: breakStart ? breakStart.toISOString() : null } });
  }
  res.redirect('/hours');
});

app.get('/dev/recent', async (req, res) => {
  const token = req.query.token;
  let user = req.session.user;
  if (!user && token && token === (process.env.DEV_TEST_TOKEN || '')) {
    const { rows } = await pool.query('SELECT id, name, username, is_admin FROM employees WHERE is_admin = TRUE LIMIT 1');
    if (rows.length === 0) return res.status(500).send('No admin available');
    req.session.user = { id: rows[0].id, name: rows[0].name, username: rows[0].username, is_admin: rows[0].is_admin };
    user = req.session.user;
  }
  if (!user) return res.status(403).send('Forbidden');
  const count = Math.max(1, Math.min(parseInt(req.query.count || '10', 10), 50));
  const { rows } = await pool.query(
    `SELECT punch_type, punched_at FROM punches WHERE employee_id = $1 ORDER BY punched_at DESC LIMIT ${count}`,
    [user.id]
  );
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const recent = rows.map(r => ({ punch_type: r.punch_type, punched_at: r.punched_at, ny: fmt.format(new Date(r.punched_at)) }));
  res.json({ recent });
});

app.get('/dev/seed-midnight', async (req, res) => {
  const token = req.query.token;
  let user = req.session.user;
  if (!user && token && token === (process.env.DEV_TEST_TOKEN || '')) {
    const { rows } = await pool.query('SELECT id, name, username, is_admin FROM employees WHERE is_admin = TRUE LIMIT 1');
    if (rows.length === 0) return res.status(500).send('No admin available');
    req.session.user = { id: rows[0].id, name: rows[0].name, username: rows[0].username, is_admin: rows[0].is_admin };
    user = req.session.user;
  }
  if (!user) return res.status(403).send('Forbidden');
  const state = req.query.state === 'break' ? 'break' : 'in';
  const countOnly = req.query.dry === '1';
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const y = parseInt(parts.find(p => p.type === 'year').value);
  const m = parseInt(parts.find(p => p.type === 'month').value);
  const d = parseInt(parts.find(p => p.type === 'day').value);
  const userId = user.id;
  const inYesterday = nyLocalToUTC(y, m, d - 1, 23, 0, 0);
  const outYesterday = nyLocalToUTC(y, m, d - 1, 23, 59, 59);
  const inToday = nyLocalToUTC(y, m, d, 0, 0, 0);
  const breakStartToday = nyLocalToUTC(y, m, d, 0, 0, 1);
  const windowStart = new Date(outYesterday.getTime() - 2000);
  const windowEnd = new Date(inToday.getTime() + 2000);
  const { rows: existing } = await pool.query(
    `SELECT 1 FROM punches WHERE employee_id=$1 AND punched_at BETWEEN $2 AND $3 LIMIT 1`,
    [userId, windowStart, windowEnd]
  );
  let inserted = 0;
  if (!countOnly && existing.length === 0) {
    await pool.query('INSERT INTO punches (employee_id, punch_type, punched_at) VALUES ($1, $2, $3)', [userId, 'in', inYesterday]);
    await pool.query('INSERT INTO punches (employee_id, punch_type, punched_at) VALUES ($1, $2, $3)', [userId, 'out', outYesterday]);
    await pool.query('INSERT INTO punches (employee_id, punch_type, punched_at) VALUES ($1, $2, $3)', [userId, 'in', inToday]);
    if (state === 'break') {
      await pool.query('INSERT INTO punches (employee_id, punch_type, punched_at) VALUES ($1, $2, $3)', [userId, 'break_start', breakStartToday]);
    }
    inserted = state === 'break' ? 4 : 3;
  }
  res.json({
    ok: true,
    dedupSkipped: existing.length > 0,
    insertedCount: inserted,
    timestampsUTC: {
      inYesterday: inYesterday.toISOString(),
      outYesterday: outYesterday.toISOString(),
      inToday: inToday.toISOString(),
      breakStartToday: state === 'break' ? breakStartToday.toISOString() : null
    }
  });
});

app.get('/dev/clear-punches', async (req, res) => {
  const token = req.query.token;
  let user = req.session.user;
  if (!user && token && token === (process.env.DEV_TEST_TOKEN || '')) {
    const { rows } = await pool.query('SELECT id, name, username, is_admin FROM employees WHERE is_admin = TRUE LIMIT 1');
    if (rows.length === 0) return res.status(500).send('No admin available');
    req.session.user = { id: rows[0].id, name: rows[0].name, username: rows[0].username, is_admin: rows[0].is_admin };
    user = req.session.user;
  }
  if (!user) return res.status(403).send('Forbidden');
  const userId = user.id;
  const { rowCount } = await pool.query('DELETE FROM punches WHERE employee_id = $1', [userId]);
  res.json({ ok: true, cleared: rowCount });
});

app.get('/dev/purge-midnight-window', async (req, res) => {
  const token = req.query.token;
  let user = req.session.user;
  if (!user && token && token === (process.env.DEV_TEST_TOKEN || '')) {
    const { rows } = await pool.query('SELECT id, name, username, is_admin FROM employees WHERE is_admin = TRUE LIMIT 1');
    if (rows.length === 0) return res.status(500).send('No admin available');
    req.session.user = { id: rows[0].id, name: rows[0].name, username: rows[0].username, is_admin: rows[0].is_admin };
    user = req.session.user;
  }
  if (!user) return res.status(403).send('Forbidden');
  const minutes = Math.max(1, Math.min(parseInt(req.query.minutes || '2', 10), 60));
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const y = parseInt(parts.find(p => p.type === 'year').value);
  const m = parseInt(parts.find(p => p.type === 'month').value);
  const d = parseInt(parts.find(p => p.type === 'day').value);
  const todayStartUTC = nyLocalToUTC(y, m, d, 0, 0, 0);
  const endYesterdayUTC = nyLocalToUTC(y, m, d - 1, 23, 59, 59);
  const windowStart = new Date(endYesterdayUTC.getTime() - minutes * 60 * 1000);
  const windowEnd = new Date(todayStartUTC.getTime() + minutes * 60 * 1000);
  const { rowCount } = await pool.query('DELETE FROM punches WHERE employee_id = $1 AND punched_at BETWEEN $2 AND $3', [user.id, windowStart, windowEnd]);
  res.json({
    ok: true,
    minutes,
    window: { start: windowStart.toISOString(), end: windowEnd.toISOString() },
    deleted: rowCount
  });
});
app.get('/dev/rollover-dry-run', async (req, res) => {
  const token = req.query.token;
  if (!token || token !== (process.env.DEV_TEST_TOKEN || '')) return res.status(403).send('Forbidden');
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const y = parseInt(parts.find(p => p.type === 'year').value);
  const m = parseInt(parts.find(p => p.type === 'month').value);
  const d = parseInt(parts.find(p => p.type === 'day').value);
  const todayStartUTC = nyLocalToUTC(y, m, d, 0, 0, 0);
  const endYesterdayUTC = nyLocalToUTC(y, m, d - 1, 23, 59, 59);
  const { rows: employees } = await pool.query('SELECT id FROM employees WHERE active = TRUE');
  const results = [];
  for (const emp of employees) {
    const { rows: recent } = await pool.query(
      `SELECT punch_type FROM punches WHERE employee_id = $1 ORDER BY punched_at DESC LIMIT 1`,
      [emp.id]
    );
    if (recent.length === 0) continue;
    const lastType = recent[0].punch_type;
    let wouldInsert = [];
    if (lastType === 'in') {
      wouldInsert = ['out', 'in'];
    } else if (lastType === 'break_start') {
      wouldInsert = ['out', 'in', 'break_start'];
    }
    results.push({ employee_id: emp.id, lastType, actions: wouldInsert, window: { start: endYesterdayUTC.toISOString(), end: todayStartUTC.toISOString() } });
  }
  res.json({ ok: true, results });
});

app.get('/dev/seed-on-break-before-midnight', async (req, res) => {
  const token = req.query.token;
  let user = req.session.user;
  if (!user && token && token === (process.env.DEV_TEST_TOKEN || '')) {
    const { rows } = await pool.query('SELECT id, name, username, is_admin FROM employees WHERE is_admin = TRUE LIMIT 1');
    if (rows.length === 0) return res.status(500).send('No admin available');
    req.session.user = { id: rows[0].id, name: rows[0].name, username: rows[0].username, is_admin: rows[0].is_admin };
    user = req.session.user;
  }
  if (!user) return res.status(403).send('Forbidden');

  try {
    const now = new Date();
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
    const y = parseInt(parts.find(p => p.type === 'year').value);
    const m = parseInt(parts.find(p => p.type === 'month').value);
    const d = parseInt(parts.find(p => p.type === 'day').value);

    const userId = user.id;
    const inEarlier = nyLocalToUTC(y, m, d - 1, 20, 0, 0);
    const breakStartBeforeMidnight = nyLocalToUTC(y, m, d - 1, 22, 0, 0);
    const endYesterdayUTC = nyLocalToUTC(y, m, d - 1, 23, 59, 59);
    const todayStartUTC = nyLocalToUTC(y, m, d, 0, 0, 0);

    const windowStart = new Date(endYesterdayUTC.getTime() - 60 * 60 * 1000);
    const windowEnd = new Date(todayStartUTC.getTime() + 60 * 60 * 1000);

    const { rows: existing } = await pool.query(
      `SELECT 1 FROM punches WHERE employee_id=$1 AND punched_at BETWEEN $2 AND $3 LIMIT 1`,
      [userId, windowStart, windowEnd]
    );

    let inserted = 0;
    if (existing.length === 0) {
      await pool.query('INSERT INTO punches (employee_id, punch_type, punched_at) VALUES ($1, $2, $3)', [userId, 'in', inEarlier]);
      await pool.query('INSERT INTO punches (employee_id, punch_type, punched_at) VALUES ($1, $2, $3)', [userId, 'break_start', breakStartBeforeMidnight]);
      inserted = 2;
    }

    res.json({
      ok: true,
      userId,
      dedupSkipped: existing.length > 0,
      insertedCount: inserted,
      timestampsUTC: {
        inEarlier: inEarlier.toISOString(),
        breakStartBeforeMidnight: breakStartBeforeMidnight.toISOString(),
        endYesterdayUTC: endYesterdayUTC.toISOString(),
        todayStartUTC: todayStartUTC.toISOString()
      }
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/dev/backfill-now', async (req, res) => {
  const token = req.query.token;
  let user = req.session.user;
  if (!user && token && token === (process.env.DEV_TEST_TOKEN || '')) {
    const { rows } = await pool.query('SELECT id, name, username, is_admin FROM employees WHERE is_admin = TRUE LIMIT 1');
    if (rows.length === 0) return res.status(500).send('No admin available');
    req.session.user = { id: rows[0].id, name: rows[0].name, username: rows[0].username, is_admin: rows[0].is_admin };
    user = req.session.user;
  }
  if (!user) return res.status(403).send('Forbidden');
  const days = Math.max(1, Math.min(parseInt(req.query.days || '7', 10), 30));
  const count = await ensureBackfillForUser(user.id, days);
  res.json({ ok: true, backfilledDays: count });
});
// Admin: new employee form
app.get('/admin/employees/new', requireAuth, requireAdmin, (req, res) => {
  res.render('admin_employee_form', {
    user: req.session.user,
    employee: null,
    error: null
  });
});

// Admin: create employee
app.post('/admin/employees/new', requireAuth, requireAdmin, async (req, res) => {
  const { name, email, username, password, is_admin, active } = req.body;
  try {
    const passwordHash = await bcrypt.hash(password || 'changeme123', 10);
    await pool.query(
      `INSERT INTO employees (name, email, username, password_hash, is_admin, active)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        name,
        email,
        username,
        passwordHash,
        is_admin === 'on',
        active === 'on'
      ]
    );
    res.redirect('/admin/employees');
  } catch (err) {
    console.error(err);
    res.status(500).send('Server error');
  }
});

// Admin: edit employee form
app.get('/admin/employees/:id(\\d+)', requireAuth, requireAdmin, async (req, res) => {
  try {
    const employeeId = parseInt(req.params.id, 10);
    if (isNaN(employeeId)) return res.status(404).send('Employee not found');
    const { rows } = await pool.query(
      'SELECT id, name, email, username, is_admin, active FROM employees WHERE id = $1',
      [employeeId]
    );
    if (rows.length === 0) return res.status(404).send('Employee not found');
    res.render('admin_employee_form', {
      user: req.session.user,
      employee: rows[0],
      error: null
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Server error');
  }
});

// Admin: update employee
app.post('/admin/employees/:id(\\d+)', requireAuth, requireAdmin, async (req, res) => {
  const { name, email, username, password, is_admin, active } = req.body;
  try {
    const employeeId = parseInt(req.params.id, 10);
    if (isNaN(employeeId)) return res.status(404).send('Employee not found');
    if (password) {
      const passwordHash = await bcrypt.hash(password, 10);
      await pool.query(
        `UPDATE employees
         SET name=$1, email=$2, username=$3, password_hash=$4, is_admin=$5, active=$6
         WHERE id=$7`,
        [
          name,
          email,
          username,
          passwordHash,
          is_admin === 'on',
          active === 'on',
          employeeId
        ]
      );
    } else {
      await pool.query(
        `UPDATE employees
         SET name=$1, email=$2, username=$3, is_admin=$4, active=$5
         WHERE id=$6`,
        [
          name,
          email,
          username,
          is_admin === 'on',
          active === 'on',
          employeeId
        ]
      );
    }
    res.redirect('/admin/employees');
  } catch (err) {
    console.error(err);
    res.status(500).send('Server error');
  }
});

// Admin: delete employee (soft delete or hard delete)
app.post('/admin/employees/:id/delete', requireAuth, requireAdmin, async (req, res) => {
  try {
    const employeeId = parseInt(req.params.id, 10);
    if (isNaN(employeeId)) return res.status(404).send('Employee not found');
    const removeFromList = req.body.remove_from_list === 'on';
    const eraseData = req.body.erase_data === 'on';

    if (!removeFromList && !eraseData) {
      const { rows } = await pool.query(
        'SELECT id, name, email, username, is_admin, active FROM employees WHERE id = $1',
        [employeeId]
      );
      if (rows.length === 0) return res.status(404).send('Employee not found');
      return res.render('admin_employee_form', {
        user: req.session.user,
        employee: rows[0],
        error: 'Select a delete option to proceed'
      });
    }

    if (eraseData) {
      await pool.query('DELETE FROM employees WHERE id = $1', [employeeId]);
    } else if (removeFromList) {
      await pool.query('UPDATE employees SET active = FALSE WHERE id = $1', [employeeId]);
    }

    res.redirect('/admin/employees');
  } catch (err) {
    console.error(err);
    res.status(500).send('Server error');
  }
});

// Store last request debug info for debugging
let lastRequestDebug = null;

// Employee: view previous days' hours
app.get('/hours', requireAuth, async (req, res) => {
  let debugInfo = {
    error: 'Initializing...',
    userId: null,
    isAdmin: false
  };
  
  try {
    const userId = req.session.user.id;
    debugInfo.userId = userId;
    debugInfo.isAdmin = req.session.user.is_admin || false;
    
    // Get date range from query params, or default to last 90 days
    let startDateFormatted, endDateFormatted;
    let errorMessage = null;
    
    console.log('Date range check - query params:', {
      hasStartDate: !!req.query.startDate,
      hasEndDate: !!req.query.endDate,
      startDate: req.query.startDate,
      endDate: req.query.endDate,
      allQueryParams: Object.keys(req.query)
    });
    
    if (req.query.startDate && req.query.endDate) {
      // User selected dates - treat them as NY timezone dates
      console.log('Using query parameters for date range');
      startDateFormatted = req.query.startDate;
      endDateFormatted = req.query.endDate;
      
      // Validate dates - compare as date strings (YYYY-MM-DD) to avoid timezone issues
      const now = new Date();
      const nyFormatter = new Intl.DateTimeFormat('en-US', {
        timeZone: TIMEZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      });
      const parts = nyFormatter.formatToParts(now);
      const todayYear = parseInt(parts.find(p => p.type === 'year').value);
      const todayMonth = parseInt(parts.find(p => p.type === 'month').value);
      const todayDay = parseInt(parts.find(p => p.type === 'day').value);
      const todayFormatted = `${todayYear}-${String(todayMonth).padStart(2, '0')}-${String(todayDay).padStart(2, '0')}`;
      
      console.log('Date validation:', {
        startDateFormatted,
        endDateFormatted,
        todayFormatted,
        startVsToday: startDateFormatted > todayFormatted,
        endVsToday: endDateFormatted > todayFormatted,
        startVsEnd: startDateFormatted > endDateFormatted
      });
      
      // Check if end date is in the future (compare as strings)
      if (endDateFormatted > todayFormatted) {
        errorMessage = 'Please select a valid date range. End date cannot be in the future.';
        // Reset to default - use same logic as default calculation
        const now = new Date();
        const nyFormatter = new Intl.DateTimeFormat('en-US', {
          timeZone: TIMEZONE,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit'
        });
        const parts = nyFormatter.formatToParts(now);
        const todayYear = parseInt(parts.find(p => p.type === 'year').value);
        const todayMonth = parseInt(parts.find(p => p.type === 'month').value);
        const todayDay = parseInt(parts.find(p => p.type === 'day').value);
        endDateFormatted = `${todayYear}-${String(todayMonth).padStart(2, '0')}-${String(todayDay).padStart(2, '0')}`;
        const todayNY = new Date(todayYear, todayMonth - 1, todayDay);
        const startNY = new Date(todayNY);
        startNY.setDate(startNY.getDate() - 89);
        const startYear = startNY.getFullYear();
        const startMonth = startNY.getMonth() + 1;
        const startDay = startNY.getDate();
        startDateFormatted = `${startYear}-${String(startMonth).padStart(2, '0')}-${String(startDay).padStart(2, '0')}`;
      } else if (startDateFormatted > endDateFormatted) {
        errorMessage = 'Please select a valid date range. Start date must be before end date.';
        // Reset to default - use same logic as default calculation
        const now = new Date();
        const nyFormatter = new Intl.DateTimeFormat('en-US', {
          timeZone: TIMEZONE,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit'
        });
        const parts = nyFormatter.formatToParts(now);
        const todayYear = parseInt(parts.find(p => p.type === 'year').value);
        const todayMonth = parseInt(parts.find(p => p.type === 'month').value);
        const todayDay = parseInt(parts.find(p => p.type === 'day').value);
        endDateFormatted = `${todayYear}-${String(todayMonth).padStart(2, '0')}-${String(todayDay).padStart(2, '0')}`;
        const todayNY = new Date(todayYear, todayMonth - 1, todayDay);
        const startNY = new Date(todayNY);
        startNY.setDate(startNY.getDate() - 89);
        const startYear = startNY.getFullYear();
        const startMonth = startNY.getMonth() + 1;
        const startDay = startNY.getDate();
        startDateFormatted = `${startYear}-${String(startMonth).padStart(2, '0')}-${String(startDay).padStart(2, '0')}`;
      }
    } else {
      // Default to last 90 days INCLUDING today - get today in NY timezone
      console.log('========================================');
      console.log('🔵 NEW CODE VERSION 2.0 - Using DEFAULT date range (no query parameters)');
      console.log('Current UTC time:', new Date().toISOString());
      console.log('TIMEZONE:', TIMEZONE);
      const now = new Date();
      
      // Get today's date in NY timezone - use Intl.DateTimeFormat for accurate conversion
      const nyFormatter = new Intl.DateTimeFormat('en-US', {
        timeZone: TIMEZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      });
      const parts = nyFormatter.formatToParts(now);
      const todayYear = parseInt(parts.find(p => p.type === 'year').value);
      const todayMonth = parseInt(parts.find(p => p.type === 'month').value);
      const todayDay = parseInt(parts.find(p => p.type === 'day').value);
      
      console.log('Intl.DateTimeFormat parts:', parts);
      console.log('Parsed values:', { todayYear, todayMonth, todayDay });
      
      // End date should be TODAY (inclusive) - format as YYYY-MM-DD
      endDateFormatted = `${todayYear}-${String(todayMonth).padStart(2, '0')}-${String(todayDay).padStart(2, '0')}`;
      
      console.log('🔍 DEBUG: Intl.DateTimeFormat result:', {
        nowUTC: now.toISOString(),
        parts: parts.map(p => `${p.type}:${p.value}`),
        todayYear,
        todayMonth,
        todayDay,
        endDateFormatted
      });
      
      // Calculate 90 days ago in NY timezone (including today, so go back 89 days)
      // Create date objects in local time (they represent NY dates)
      const todayNY = new Date(todayYear, todayMonth - 1, todayDay);
      const startNY = new Date(todayNY);
      startNY.setDate(startNY.getDate() - 89); // 89 days ago + today = 90 days total
      
      // Format directly to avoid any timezone conversion issues
      const startYear = startNY.getFullYear();
      const startMonth = startNY.getMonth() + 1;
      const startDay = startNY.getDate();
      startDateFormatted = `${startYear}-${String(startMonth).padStart(2, '0')}-${String(startDay).padStart(2, '0')}`;
      
      // Verify the calculation
      const daysDiff = Math.round((todayNY - startNY) / (1000 * 60 * 60 * 24));
      
      console.log('✅ Default date range calculated:', {
        nowUTC: now.toISOString(),
        todayInNY: `${todayYear}-${String(todayMonth).padStart(2, '0')}-${String(todayDay).padStart(2, '0')}`,
        startDateFormatted,
        endDateFormatted,
        daysDifference: daysDiff,
        expectedDays: 89,
        startNYDate: `${startYear}-${String(startMonth).padStart(2, '0')}-${String(startDay).padStart(2, '0')}`,
        endNYDate: `${todayYear}-${String(todayMonth).padStart(2, '0')}-${String(todayDay).padStart(2, '0')}`,
        todayNYObject: todayNY.toISOString(),
        startNYObject: startNY.toISOString()
      });
      
      // Double-check: if daysDiff is not 89, something is wrong
      if (daysDiff !== 89) {
        console.error('⚠️ WARNING: Date range calculation is wrong! Expected 89 days, got', daysDiff);
      }
    }
    
    // Debug: log the date range being used
    console.log('Hours history query:', { 
      startDateFormatted, 
      endDateFormatted, 
      hasQueryParams: !!(req.query.startDate && req.query.endDate) 
    });
    
    // First, check ALL punches for this employee to see what we have
    let allPunches = [];
    let punches = [];
    
    try {
      const allPunchesResult = await pool.query(
        `SELECT punch_type, punched_at
         FROM punches
         WHERE employee_id = $1
         ORDER BY punched_at ASC`,
        [userId]
      );
      allPunches = allPunchesResult.rows || [];
      
      console.log('=== HOURS HISTORY DEBUG ===');
      console.log('User:', userId, 'Is Admin:', req.session.user.is_admin);
      console.log('Total punches for user (first 10):', allPunches.length);
      if (allPunches.length > 0) {
        allPunches.forEach((p, i) => {
          const punchDate = new Date(p.punched_at);
          const dateInNY = punchDate.toLocaleDateString('en-US', { 
            timeZone: TIMEZONE,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit'
          });
          console.log(`  Punch ${i + 1}: ${p.punch_type} at ${p.punched_at} (NY date: ${dateInNY})`);
        });
      }
      
      // Update debugInfo immediately after fetching
      debugInfo.totalPunchesFound = allPunches.length;
      console.log('Set debugInfo.totalPunchesFound to:', debugInfo.totalPunchesFound);
    } catch (err) {
      console.error('Error fetching all punches:', err);
      debugInfo.allPunchesError = err.message;
      debugInfo.totalPunchesFound = 0;
      console.log('Set debugInfo.totalPunchesFound to 0 due to error');
    }
    
    // Instead of relying on PostgreSQL date casting (which can be tricky around midnight and timezones),
    // filter the already-fetched allPunches in JavaScript using New York dates.
    console.log('Filtering punches in JS using NY dates. Date range:', {
      startDateFormatted,
      endDateFormatted,
      TIMEZONE
    });

    punches = allPunches.filter(punch => {
      const punchDateNYStr = new Date(punch.punched_at).toLocaleDateString('en-US', { 
        timeZone: TIMEZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      });
      const [pm, pd, py] = punchDateNYStr.split('/').map(Number);
      const punchDateKey = `${py}-${String(pm).padStart(2, '0')}-${String(pd).padStart(2, '0')}`;
      return punchDateKey >= startDateFormatted && punchDateKey <= endDateFormatted;
    });

    console.log('After JS filtering, punches in range:', punches.length);
    if (punches.length > 0) {
      console.log('Sample punches in range:', punches.slice(0, 3).map(p => ({ type: p.punch_type, time: p.punched_at })));
    } else if (allPunches.length > 0) {
      console.log('⚠️ WARNING: User has punches but NONE are in the JS-filtered date range!');
      console.log('This suggests a date range or timezone issue.');
    }

    // Update debugInfo immediately after filtering
    debugInfo.punchesInRange = punches.length;
    debugInfo.dateRange = {
      start: startDateFormatted || 'N/A',
      end: endDateFormatted || 'N/A'
    };
    console.log('Set debugInfo.punchesInRange to:', debugInfo.punchesInRange);
    console.log('Set debugInfo.dateRange to:', debugInfo.dateRange);
    console.log('=== END DEBUG ===');
    
    // Group punches by date and calculate hours per day
    const dailyHours = {};
    const now = new Date();
    
    console.log('Grouping punches by date...');
    punches.forEach(punch => {
      const punchDate = new Date(punch.punched_at);
      const dateKey = punchDate.toLocaleDateString('en-US', { 
        timeZone: TIMEZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      });
      
      if (!dailyHours[dateKey]) {
        dailyHours[dateKey] = [];
      }
      dailyHours[dateKey].push(punch);
    });
    
    console.log('Daily hours grouped:', Object.keys(dailyHours).length, 'days');
    console.log('Date keys:', Object.keys(dailyHours));
    
    // Calculate hours for each day
    const hoursByDate = Object.entries(dailyHours).map(([date, dayPunches]) => {
      // Check if this is today and user is still punched in
      const today = now.toLocaleDateString('en-US', { 
        timeZone: TIMEZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      });
      const isToday = date === today;
      
      // Check if still punched in today
      const lastPunch = dayPunches[dayPunches.length - 1];
      const stillPunchedIn = isToday && 
        (lastPunch.punch_type === 'in' || lastPunch.punch_type === 'break_end' || lastPunch.punch_type === 'break_start');
      
      const effectiveEnd = stillPunchedIn ? now : (!isToday ? getNYEndOfDayUTCFromMMDDYYYY(date) : null);
      const hours = calculateHours(dayPunches, effectiveEnd);
      const minutes = hours * 60;
      console.log(`✅ Calculated hours for ${date}: ${hours.toFixed(4)} hours (${dayPunches.length} punches)`);
      console.log(`   Punch types: ${dayPunches.map(p => p.punch_type).join(', ')}`);
      console.log(`   Still punched in: ${stillPunchedIn}`);
      return { date, hours, minutes, hoursDisplay: hours.toFixed(2), minutesDisplay: minutes.toFixed(2), punches: dayPunches };
    }).sort((a, b) => {
      // Sort by date, most recent first - parse MM/DD/YYYY format
      const parseDate = (dateStr) => {
        const [month, day, year] = dateStr.split('/').map(Number);
        return new Date(year, month - 1, day);
      };
      const dateA = parseDate(a.date);
      const dateB = parseDate(b.date);
      return dateB - dateA;
    });
    
    console.log('Final hoursByDate:', hoursByDate.length, 'entries');
    if (hoursByDate.length > 0) {
      console.log('hoursByDate entries:', hoursByDate.map(d => ({ date: d.date, hours: d.hours, punchCount: d.punches ? d.punches.length : 0 })));
    } else {
      console.log('⚠️ WARNING: hoursByDate is empty but punches were found!');
      console.log('Punches found:', punches.length);
      console.log('Daily hours keys:', Object.keys(dailyHours));
    }
    
    // Overtime threshold: fixed variable (8 hours)
    const overtimeThreshold = 8;
    let weekdayOvertimeHours = 0;
    let weekendHours = 0;
    for (const d of hoursByDate) {
      const partsDate = d.date.split('/');
      const month = parseInt(partsDate[0], 10);
      const dayNum = parseInt(partsDate[1], 10);
      const year = parseInt(partsDate[2], 10);
      const dow = new Date(year, month - 1, dayNum).getDay();
      const h = typeof d.hours === 'number' ? d.hours : parseFloat(d.hours);
      if (dow >= 1 && dow <= 5) {
        weekdayOvertimeHours += Math.max(0, h - overtimeThreshold);
      } else if (dow === 0 || dow === 6) {
        weekendHours += h;
      }
    }
    const totalExtraHours = weekdayOvertimeHours + weekendHours;
    const weekdayOvertimeHoursDisplay = weekdayOvertimeHours.toFixed(2);
    const weekendHoursDisplay = weekendHours.toFixed(2);
    const totalExtraHoursDisplay = totalExtraHours.toFixed(2);
    
    // Update debug info with final results
    // Ensure userId and isAdmin are set (they should be set earlier, but double-check)
    if (!debugInfo.userId) {
      debugInfo.userId = userId;
    }
    if (debugInfo.isAdmin === false && req.session.user?.is_admin) {
      debugInfo.isAdmin = req.session.user.is_admin;
    }
    
    // Update debug info with final results
    debugInfo.totalPunchesFound = (allPunches && Array.isArray(allPunches) && allPunches.length) ? allPunches.length : 0;
    debugInfo.punchesInRange = (punches && Array.isArray(punches) && punches.length) ? punches.length : 0;
    debugInfo.dateRange = { 
      start: startDateFormatted || 'N/A', 
      end: endDateFormatted || 'N/A' 
    };
    debugInfo.daysWithHours = (hoursByDate && Array.isArray(hoursByDate) && hoursByDate.length) ? hoursByDate.length : 0;
    debugInfo.samplePunchDates = (allPunches && Array.isArray(allPunches) && allPunches.length > 0) ? allPunches.slice(0, 3).map(p => {
      const d = new Date(p.punched_at);
      return d.toLocaleDateString('en-US', { timeZone: TIMEZONE });
    }) : [];
    debugInfo.error = null; // Clear error if we got here
    
    // Debug: log what we're setting
    console.log('Setting debugInfo:', {
      userId: debugInfo.userId,
      totalPunchesFound: debugInfo.totalPunchesFound,
      punchesInRange: debugInfo.punchesInRange,
      allPunchesType: typeof allPunches,
      allPunchesIsArray: Array.isArray(allPunches),
      allPunchesLength: allPunches ? allPunches.length : 'N/A',
      punchesType: typeof punches,
      punchesIsArray: Array.isArray(punches),
      punchesLength: punches ? punches.length : 'N/A',
      dateRange: debugInfo.dateRange
    });
    
    console.log('Rendering hours_history with:', debugInfo);
    
    // Ensure debugInfo is always an object
    if (!debugInfo || typeof debugInfo !== 'object') {
      debugInfo = {
        error: 'debugInfo was not properly initialized',
        userId: userId || null,
        isAdmin: req.session.user?.is_admin || false
      };
    }
    
    console.log('About to render with debugInfo:', JSON.stringify(debugInfo, null, 2));
    console.log('debugInfo type:', typeof debugInfo);
    console.log('debugInfo value:', debugInfo);
    
    // Create render data object - try passing debugInfo with a different approach
    const renderData = {
      user: req.session.user,
      hoursByDate: hoursByDate || [],
      startDate: startDateFormatted,
      endDate: endDateFormatted,
      hasDateRange: !!req.query.startDate,
      errorMessage: errorMessage,
      weekdayOvertimeHoursDisplay,
      weekendHoursDisplay,
      totalExtraHoursDisplay,
      debugInfo: debugInfo  // Add it directly in the object
    };
    
    console.log('Render data keys:', Object.keys(renderData));
    console.log('hoursByDate length:', renderData.hoursByDate.length);
    console.log('hoursByDate entries:', renderData.hoursByDate.slice(0, 3).map(d => ({ date: d.date, hours: d.hours })));
    console.log('debugInfo in renderData:', renderData.debugInfo);
    console.log('renderData.debugInfo type:', typeof renderData.debugInfo);
    console.log('renderData.debugInfo keys:', renderData.debugInfo ? Object.keys(renderData.debugInfo) : 'N/A');
    
    // Set debugInfo on res.locals AFTER all updates are complete
    // Make a copy to ensure it's not modified after
    // Ensure it's always an object, never false/null
    if (!debugInfo || typeof debugInfo !== 'object' || Array.isArray(debugInfo)) {
      console.error('ERROR: debugInfo is not a valid object!', typeof debugInfo, debugInfo);
      debugInfo = {
        error: 'debugInfo was not properly initialized',
        userId: userId || null,
        isAdmin: req.session.user?.is_admin || false,
        totalPunchesFound: 0,
        punchesInRange: 0,
        dateRange: { start: 'N/A', end: 'N/A' },
        daysWithHours: 0
      };
    }
    
    // Ensure all required properties exist
    if (!debugInfo.hasOwnProperty('userId')) debugInfo.userId = userId || null;
    if (!debugInfo.hasOwnProperty('isAdmin')) debugInfo.isAdmin = req.session.user?.is_admin || false;
    if (!debugInfo.hasOwnProperty('totalPunchesFound')) debugInfo.totalPunchesFound = 0;
    if (!debugInfo.hasOwnProperty('punchesInRange')) debugInfo.punchesInRange = 0;
    if (!debugInfo.hasOwnProperty('dateRange')) debugInfo.dateRange = { start: 'N/A', end: 'N/A' };
    if (!debugInfo.hasOwnProperty('daysWithHours')) debugInfo.daysWithHours = 0;
    
    const finalDebugInfo = JSON.parse(JSON.stringify(debugInfo));
    
    // Set on both res.locals AND in renderData
    res.locals.debugInfo = finalDebugInfo;
    renderData.debugInfo = finalDebugInfo;  // Overwrite with final version
    
    console.log('Final debugInfo being set:', JSON.stringify(finalDebugInfo, null, 2));
    console.log('Type of finalDebugInfo:', typeof finalDebugInfo);
    console.log('Is object?', typeof finalDebugInfo === 'object');
    console.log('Keys in finalDebugInfo:', Object.keys(finalDebugInfo));
    console.log('renderData.debugInfo before render:', renderData.debugInfo);
    console.log('renderData keys before render:', Object.keys(renderData));
    
    // Store for debug endpoint
    lastRequestDebug = {
      timestamp: new Date().toISOString(),
      codeVersion: '2.0 - Intl.DateTimeFormat',
      userId: userId,
      debugInfo: finalDebugInfo,
      renderDataKeys: Object.keys(renderData),
      allPunchesCount: allPunches ? allPunches.length : 0,
      punchesInRangeCount: punches ? punches.length : 0,
      dateRange: { start: startDateFormatted, end: endDateFormatted },
      queryParams: req.query,
      hasQueryParams: !!(req.query.startDate && req.query.endDate),
      calculatedAsDefault: !req.query.startDate || !req.query.endDate
    };
    
    res.render('hours_history', renderData);
  } catch (err) {
    console.error('Error in /hours route:', err);
    console.error('Error stack:', err.stack);
    // Update debugInfo with error info
    if (!debugInfo) {
      debugInfo = {
        error: 'Error occurred before initialization',
        userId: null,
        isAdmin: false
      };
    }
    debugInfo.error = err.message;
    debugInfo.errorStack = err.stack;
    // Still render with error message and any debug info we have
    // Ensure debugInfo is an object
    if (!debugInfo || typeof debugInfo !== 'object') {
      debugInfo = {
        error: 'Error occurred before initialization',
        userId: null,
        isAdmin: false,
        totalPunchesFound: 0,
        punchesInRange: 0,
        dateRange: { start: 'N/A', end: 'N/A' },
        daysWithHours: 0
      };
    }
    debugInfo.error = err.message;
    debugInfo.errorStack = err.stack;
    
    res.locals.debugInfo = debugInfo; // Set on res.locals too
    res.render('hours_history', {
      user: req.session.user || {},
      hoursByDate: [],
      startDate: '',
      endDate: '',
      hasDateRange: false,
      errorMessage: 'An error occurred: ' + err.message,
      debugInfo: debugInfo
    });
  }
});

// Debug endpoint to view last request info
app.get('/debug/last-request', requireAuth, (req, res) => {
  res.json({
    message: 'Last /hours request debug info',
    data: lastRequestDebug || { error: 'No request data available yet. Visit /hours first.' },
    currentUser: {
      id: req.session.user.id,
      name: req.session.user.name,
      isAdmin: req.session.user.is_admin
    }
  });
});

// Admin: simple recent punches view (optional)
app.get('/admin/punches', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { rows: punches } = await pool.query(
      `SELECT p.id, e.name, e.username, p.punch_type, p.punched_at
       FROM punches p
       JOIN employees e ON e.id = p.employee_id
       ORDER BY p.punched_at DESC
       LIMIT 50`
    );
    res.render('admin_punches', { user: req.session.user, punches });
  } catch (err) {
    console.error(err);
    res.status(500).send('Server error');
  }
});

// Dev: JSON recent punches (token-gated)
app.get('/dev/recent-punches', async (req, res) => {
  const token = req.query.token;
  if (!token || token !== (process.env.DEV_TEST_TOKEN || '')) return res.status(403).json({ ok: false, error: 'Forbidden' });
  try {
    const { rows } = await pool.query(
      `SELECT p.id, p.employee_id, p.punch_type, p.punched_at
       FROM punches p
       ORDER BY p.punched_at DESC
       LIMIT 100`
    );
    res.json({ ok: true, punches: rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

async function performMidnightRollover(now = new Date()) {
  const nyFormatter = new Intl.DateTimeFormat('en-US', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
  const parts = nyFormatter.formatToParts(now);
  const y = parseInt(parts.find(p => p.type === 'year').value);
  const m = parseInt(parts.find(p => p.type === 'month').value);
  const d = parseInt(parts.find(p => p.type === 'day').value);
  const todayStr = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const offsetMin = (() => {
    const probe = new Date(Date.UTC(y, m - 1, d, 12));
    const s = new Intl.DateTimeFormat('en-US', { timeZone: TIMEZONE, timeZoneName: 'shortOffset', hour: '2-digit', minute: '2-digit' }).format(probe);
    const mm = s.match(/GMT([+-]\d+)/);
    const hours = mm ? parseInt(mm[1], 10) : -5;
    return hours * 60;
  })();
  const todayStartUTC = new Date(Date.UTC(y, m - 1, d, 0, 0, 0) + (-offsetMin) * 60 * 1000);
  const endYesterdayUTC = new Date(Date.UTC(y, m - 1, d - 1, 23, 59, 59) + (-offsetMin) * 60 * 1000);

  const { rows: employees } = await pool.query('SELECT id FROM employees WHERE active = TRUE');
  let affected = 0;
  for (const emp of employees) {
    const windowStart = new Date(endYesterdayUTC.getTime() - 2000);
    const windowEnd = new Date(todayStartUTC.getTime() + 2000);
    const { rows: windowPunches } = await pool.query(
      `SELECT punch_type, punched_at FROM punches WHERE employee_id = $1 AND punched_at BETWEEN $2 AND $3 ORDER BY punched_at ASC`,
      [emp.id, windowStart, windowEnd]
    );
    const typesInWindow = new Set(windowPunches.map(p => p.punch_type));
    const hasOut = typesInWindow.has('out');
    const hasInNext = typesInWindow.has('in');
    const hasBreakEnd = typesInWindow.has('break_end');
    const hasBreakStartNext = windowPunches.some(p => p.punch_type === 'break_start' && new Date(p.punched_at) >= todayStartUTC);

    const { rows: upToBoundary } = await pool.query(
      `SELECT punch_type, punched_at FROM punches WHERE employee_id = $1 AND punched_at <= $2 ORDER BY punched_at ASC`,
      [emp.id, endYesterdayUTC]
    );
    const stateAtBoundary = getStateAt(upToBoundary, endYesterdayUTC);

    if (stateAtBoundary === 'in' || stateAtBoundary === 'break') {
      if (stateAtBoundary === 'break' && !hasBreakEnd) {
        const be = new Date(endYesterdayUTC.getTime() - 1000);
        await pool.query('INSERT INTO punches (employee_id, punch_type, punched_at) VALUES ($1, $2, $3)', [emp.id, 'break_end', be]);
        affected++;
      }
      if (!hasOut) {
        await pool.query('INSERT INTO punches (employee_id, punch_type, punched_at) VALUES ($1, $2, $3)', [emp.id, 'out', endYesterdayUTC]);
        affected++;
      }
      if (!hasInNext) {
        await pool.query('INSERT INTO punches (employee_id, punch_type, punched_at) VALUES ($1, $2, $3)', [emp.id, 'in', todayStartUTC]);
        affected++;
      }
      if (stateAtBoundary === 'break' && !hasBreakStartNext) {
        const bs = new Date(todayStartUTC.getTime() + 1000);
        await pool.query('INSERT INTO punches (employee_id, punch_type, punched_at) VALUES ($1, $2, $3)', [emp.id, 'break_start', bs]);
        affected++;
      }
    }
  }
  return { affected };
}

function scheduleMidnightRollover() {
  const now = new Date();
  const nyParts = new Intl.DateTimeFormat('en-US', { timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit', second: '2-digit', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const y = parseInt(nyParts.find(p => p.type === 'year').value);
  const m = parseInt(nyParts.find(p => p.type === 'month').value);
  const d = parseInt(nyParts.find(p => p.type === 'day').value);
  const midnightNYUTC = parseNYDateToUTC(`${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
  const nextMidnightUTC = new Date(midnightNYUTC.getTime() + 24 * 60 * 60 * 1000);
  const delay = nextMidnightUTC.getTime() - now.getTime();
  setTimeout(async () => {
    try {
      await performMidnightRollover(new Date());
    } finally {
      scheduleMidnightRollover();
    }
  }, Math.max(1000, delay));
}

app.post('/admin/rollover-now', async (req, res) => {
  const token = req.query.token;
  if (!req.session.user) {
    if (!token || token !== (process.env.DEV_TEST_TOKEN || '')) return res.status(403).send('Forbidden');
  } else {
    if (!req.session.user.is_admin) return res.status(403).send('Forbidden');
  }
  try {
    const r = await performMidnightRollover(new Date());
    res.json({ ok: true, affected: r.affected });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/admin/rollover-now', async (req, res) => {
  const token = req.query.token;
  if (!req.session.user) {
    if (!token || token !== (process.env.DEV_TEST_TOKEN || '')) return res.status(403).send('Forbidden');
  } else {
    if (!req.session.user.is_admin) return res.status(403).send('Forbidden');
  }
  try {
    const r = await performMidnightRollover(new Date());
    res.json({ ok: true, affected: r.affected });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Start server
initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Timesheet app listening on port ${PORT}`);
      scheduleMidnightRollover();
    });
  })
  .catch((err) => {
    console.error('Failed to initialize database', err);
    console.error('\n=== DATABASE CONNECTION ERROR ===');
    console.error('You need to set up a PostgreSQL database.');
    console.error('\nOption 1: Use Render PostgreSQL (Recommended for deployment)');
    console.error('  1. Go to https://render.com and create a PostgreSQL database');
    console.error('  2. Copy the DATABASE_URL from Render');
    console.error('  3. Create a .env file with: DATABASE_URL=<your-render-url>');
    console.error('\nOption 2: Use a free cloud database for testing');
    console.error('  - Neon (neon.tech) - Free PostgreSQL');
    console.error('  - Supabase (supabase.com) - Free PostgreSQL');
    console.error('  - ElephantSQL (elephantsql.com) - Free PostgreSQL');
    console.error('\nThen create a .env file with your DATABASE_URL');
    process.exit(1);
  });


