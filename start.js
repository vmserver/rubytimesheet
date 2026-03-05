
require('dotenv').config();

const { app, initDb, scheduleMidnightRollover } = require('./server');

// Global error handlers to prevent silent crashes
process.on('uncaughtException', (err) => {
  console.error('FATAL ERROR: Uncaught Exception', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('FATAL ERROR: Unhandled Rejection at:', promise, 'reason:', reason);
});

const PORT = process.env.PORT || 3000;
const MAX_RETRIES = 3; // Standard retry count
const RETRY_DELAY = 5000; // 5 seconds

// Health check endpoint (satisfies Render health checks even if DB is initializing)
app.get('/healthz', (req, res) => res.status(200).send('OK'));

async function connectWithRetry(retries = MAX_RETRIES) {
  try {
    console.log(`Connecting to database... attempt ${MAX_RETRIES - retries + 1}/${MAX_RETRIES + 1}`);
    await initDb();
    console.log('Database initialized successfully.');
    // Start background tasks that depend on the database
    scheduleMidnightRollover();
  } catch (err) {
    console.error('Database connection failed:', err.message);
    
    if (retries > 0) {
      console.log(`Retrying in ${RETRY_DELAY / 1000} seconds...`);
      return new Promise((resolve) => {
        setTimeout(() => resolve(connectWithRetry(retries - 1)), RETRY_DELAY);
      });
    } else {
      console.error('\n=== DATABASE CONNECTION FAILED PERMANENTLY ===');
      console.error('CRITICAL: Check your DATABASE_URL and network configuration.');
      process.exit(1); // Fail fast so Render knows the service is broken
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
