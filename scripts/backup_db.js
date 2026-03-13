require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const targetDbUrl = process.argv[2] || process.env.DATABASE_URL;

if (!targetDbUrl) {
  console.error('❌ No database URL provided. Use command line or .env DATABASE_URL');
  process.exit(1);
}

const sslRequired = targetDbUrl.includes('neon.tech') || targetDbUrl.includes('supabase') || targetDbUrl.includes('aivencloud') || process.env.NODE_ENV === 'production';
const pool = new Pool({
  connectionString: targetDbUrl,
  ssl: sslRequired ? { rejectUnauthorized: false } : false,
  connectionTimeoutMillis: 15000, 
  max: 10 
});

async function backup() {
  if (process.argv[2]) {
    const maskedUrl = targetDbUrl.includes('@') ? `...${targetDbUrl.split('@')[1]}` : 'Command-line URL';
    console.log(`- Using command-line provided DB URL: ${maskedUrl}`);
  } else {
    const maskedUrl = targetDbUrl.includes('@') ? `...${targetDbUrl.split('@')[1]}` : 'Environment URL';
    console.log(`- Using DATABASE_URL from environment: ${maskedUrl}`);
  }

  console.log('Starting full database backup...');
  const client = await pool.connect();
  try {
    const backupData = {
      timestamp: new Date().toISOString(),
      employees: [],
      punches: [],
      sessions: []
    };

    // 1. Fetch Employees
    console.log('- Fetching employees...');
    const { rows: employees } = await client.query('SELECT * FROM employees');
    backupData.employees = employees;

    // 2. Fetch Punches
    console.log('- Fetching punches...');
    const { rows: punches } = await client.query('SELECT * FROM punches');
    backupData.punches = punches;

    // 3. Fetch Sessions
    console.log('- Fetching sessions...');
    const { rows: sessions } = await client.query('SELECT * FROM session');
    backupData.sessions = sessions;

    // Save to JSON
    const outputPath = path.join(__dirname, '../backup_full.json');
    fs.writeFileSync(outputPath, JSON.stringify(backupData, null, 2));
    
    console.log(`✅ Backup saved to ${outputPath}`);
    console.log(`Summary: ${employees.length} employees, ${punches.length} punches, ${sessions.length} sessions.`);
  } catch (err) {
    console.error('❌ Backup failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

backup();
