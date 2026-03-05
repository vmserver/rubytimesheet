require('dotenv').config();
const { Client } = require('pg');

/**
 * Migration Script: migrate-db.js
 * Purpose: Migrates data from one PostgreSQL database to another.
 * 
 * Usage:
 * node scripts/migrate-db.js <source_db_url> <target_db_url>
 * 
 * If URLs are not provided as arguments, it will prompt for them or use .env (not recommended for both).
 */

async function migrate() {
    const sourceUrl = process.argv[2];
    const targetUrl = process.argv[3];

    if (!sourceUrl || !targetUrl) {
        console.error('Usage: node scripts/migrate-db.js <source_db_url> <target_db_url>');
        process.exit(1);
    }

    const sourceClient = new Client({ 
        connectionString: sourceUrl, 
        ssl: { rejectUnauthorized: false } 
    });
    const targetClient = new Client({ 
        connectionString: targetUrl, 
        ssl: { rejectUnauthorized: false } 
    });

    try {
        console.log("Connecting to source and target databases...");
        await sourceClient.connect();
        await targetClient.connect();

        console.log("Ensuring target schema is initialized...");
        await targetClient.query(`
            CREATE TABLE IF NOT EXISTS employees (
                id SERIAL PRIMARY KEY,
                name VARCHAR(100) NOT NULL,
                email VARCHAR(150) UNIQUE NOT NULL,
                username VARCHAR(50) UNIQUE NOT NULL,
                password_hash VARCHAR(200) NOT NULL,
                is_admin BOOLEAN NOT NULL DEFAULT FALSE,
                super_admin BOOLEAN NOT NULL DEFAULT FALSE,
                active BOOLEAN NOT NULL DEFAULT TRUE,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
            
            CREATE TABLE IF NOT EXISTS punches (
                id SERIAL PRIMARY KEY,
                employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
                punch_type VARCHAR(20) NOT NULL,
                punched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
            
            CREATE TABLE IF NOT EXISTS session (
                sid VARCHAR NOT NULL COLLATE "default",
                sess JSON NOT NULL,
                expire TIMESTAMP(6) NOT NULL,
                CONSTRAINT session_pkey PRIMARY KEY (sid) NOT DEFERRABLE INITIALLY IMMEDIATE
            );
            CREATE INDEX IF NOT EXISTS IDX_session_expire ON session (expire);
        `);

        // Migrate Employees
        console.log("Migrating employees...");
        const { rows: employees } = await sourceClient.query('SELECT * FROM employees');
        for (const emp of employees) {
            await targetClient.query(
                `INSERT INTO employees (id, name, email, username, password_hash, is_admin, super_admin, active, created_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                 ON CONFLICT (id) DO UPDATE SET
                    name = EXCLUDED.name, email = EXCLUDED.email, username = EXCLUDED.username, 
                    password_hash = EXCLUDED.password_hash, is_admin = EXCLUDED.is_admin, 
                    super_admin = EXCLUDED.super_admin, active = EXCLUDED.active, created_at = EXCLUDED.created_at`,
                [emp.id, emp.name, emp.email, emp.username, emp.password_hash, emp.is_admin, emp.super_admin, emp.active, emp.created_at]
            );
        }
        await targetClient.query("SELECT setval('employees_id_seq', COALESCE((SELECT MAX(id) FROM employees), 1))");

        // Migrate Punches
        console.log("Migrating punches...");
        const { rows: punches } = await sourceClient.query('SELECT * FROM punches');
        for (const punch of punches) {
            await targetClient.query(
                `INSERT INTO punches (id, employee_id, punch_type, punched_at)
                 VALUES ($1, $2, $3, $4)
                 ON CONFLICT (id) DO UPDATE SET
                    employee_id = EXCLUDED.employee_id, punch_type = EXCLUDED.punch_type, punched_at = EXCLUDED.punched_at`,
                [punch.id, punch.employee_id, punch.punch_type, punch.punched_at]
            );
        }
        await targetClient.query("SELECT setval('punches_id_seq', COALESCE((SELECT MAX(id) FROM punches), 1))");

        console.log("Migration completed successfully!");

    } catch (err) {
        console.error("Migration failed:", err);
        process.exit(1);
    } finally {
        await sourceClient.end();
        await targetClient.end();
    }
}

migrate();
