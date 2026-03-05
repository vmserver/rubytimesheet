require('dotenv').config();
const { Client } = require('pg');

/**
 * DB Testing Script: test-db.js
 * Purpose: Tests database connection and basic query capability.
 * 
 * Usage:
 * node scripts/test-db.js [db_url]
 * 
 * If URL is not provided as an argument, it will use the DATABASE_URL from .env.
 */

async function test(url, label) {
    console.log(`Testing ${label}...`);
    const client = new Client({
        connectionString: url,
        ssl: { rejectUnauthorized: false }
    });
    try {
        await client.connect();
        const res = await client.query('SELECT now()');
        console.log(`✅ Success for ${label}:`, res.rows[0]);
        return true;
    } catch (err) {
        console.error(`❌ Failure for ${label}:`, err.message);
        return false;
    } finally {
        await client.end();
    }
}

async function run() {
    const dbUrl = process.argv[2] || process.env.DATABASE_URL;
    if (!dbUrl) {
        console.error('Error: DATABASE_URL not found in .env and no URL provided as an argument.');
        process.exit(1);
    }
    await test(dbUrl, "Database Connection Test");
}

run();
