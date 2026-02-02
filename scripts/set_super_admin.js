require('dotenv').config();
const { Pool } = require('pg');

const sslRequired = process.env.DATABASE_URL && (process.env.DATABASE_URL.includes('neon.tech') || process.env.DATABASE_URL.includes('supabase') || process.env.NODE_ENV === 'production');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: sslRequired ? { rejectUnauthorized: false } : false
});

async function main() {
  const username = process.argv[2];
  const isSuper = process.argv[3] !== 'false'; // Default to true, pass 'false' to revoke

  if (!username) {
    console.error('Usage: node scripts/set_super_admin.js <username> [true|false]');
    process.exit(1);
  }

  try {
    const res = await pool.query(
      `UPDATE employees SET super_admin = $1 WHERE username = $2 RETURNING id, name, username, super_admin`,
      [isSuper, username]
    );

    if (res.rows.length === 0) {
      console.error(`User '${username}' not found.`);
      process.exit(1);
    }

    const user = res.rows[0];
    console.log(`User updated: ${user.username} (ID: ${user.id}) - Super Admin: ${user.super_admin}`);
  } catch (err) {
    console.error('Error updating user:', err);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
