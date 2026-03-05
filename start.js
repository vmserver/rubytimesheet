
require('dotenv').config();

const { app, initDb, scheduleMidnightRollover } = require('./server');

const PORT = process.env.PORT || 3000;
const MAX_RETRIES = 5;
const RETRY_DELAY = 5000; // 5 seconds

async function connectWithRetry(retries = MAX_RETRIES) {
  try {
    await initDb();
    console.log('Database initialized successfully.');
    // Start background tasks that depend on the database
    scheduleMidnightRollover();
  } catch (err) {
    console.error('Failed to initialize database', err);
    
    if (retries > 0) {
      console.log(`Retrying database connection in ${RETRY_DELAY / 1000} seconds... (${retries} retries left)`);
      return new Promise((resolve) => {
        setTimeout(() => resolve(connectWithRetry(retries - 1)), RETRY_DELAY);
      });
    } else {
      console.error('\n=== DATABASE CONNECTION FAILED AFTER MULTIPLE RETRIES ===');
      console.error('Could not connect to the database. Please check your connection settings and database status.');
      // Exit only if we absolutely cannot start up
      process.exit(1);
    }
  }
}

// Start listening immediately so health checks pass
app.listen(PORT, () => {
  console.log(`Attempting to listen on port ${PORT}`);
  console.log(`Timesheet app listening on port ${PORT}`);
  
  // Initialize database in the background
  console.log('Starting background database initialization...');
  connectWithRetry();
});
