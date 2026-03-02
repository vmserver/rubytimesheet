
require('dotenv').config();

const { app, initDb, pool, scheduleMidnightRollover } = require('./server');

const PORT = process.env.PORT || 3000;
const MAX_RETRIES = 5;
const RETRY_DELAY = 5000; // 5 seconds

async function connectWithRetry(retries = MAX_RETRIES) {
  try {
    await initDb();
    console.log('Database initialized successfully.');
    
    app.listen(PORT, () => {
      console.log(`Attempting to listen on port ${PORT}`);
      console.log(`Timesheet app listening on port ${PORT}`);
      scheduleMidnightRollover();
    });
  } catch (err) {
    console.error('Failed to initialize database', err);
    
    if (retries > 0) {
      console.log(`Retrying database connection in ${RETRY_DELAY / 1000} seconds... (${retries} retries left)`);
      setTimeout(() => connectWithRetry(retries - 1), RETRY_DELAY);
    } else {
      console.error('\n=== DATABASE CONNECTION FAILED AFTER MULTIPLE RETRIES ===');
      console.error('Could not connect to the database. Please check your connection settings and database status.');
      process.exit(1);
    }
  }
}

connectWithRetry();
