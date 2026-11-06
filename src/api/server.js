const express = require('express');
const dotenv = require('dotenv');
const { pool } = require('../db/pool');
const { createRedisConnection, closeQueues } = require('../queue/queues');
const { runMigrations } = require('../db/migrate');
const jobsRouter = require('./routes/jobs');

dotenv.config();

const app = express();
const port = parseInt(process.env.API_PORT || process.env.PORT || '3000', 10);

// Parse JSON bodies
app.use(express.json());

// Handle JSON parsing errors (malformed JSON -> HTTP 400)
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({
      error: 'Malformed JSON payload. Please provide valid JSON.',
    });
  }
  next(err);
});

// Redis client for health checks
const healthRedisClient = createRedisConnection();

/**
 * GET /health
 * Performs database and Redis readiness checks.
 */
app.get('/health', async (req, res) => {
  let dbStatus = 'disconnected';
  let redisStatus = 'disconnected';
  let isHealthy = true;

  // Check Database readiness
  try {
    await pool.query('SELECT 1');
    dbStatus = 'connected';
  } catch (err) {
    console.error('[Healthcheck] Database check failed:', err.message);
    dbStatus = 'error';
    isHealthy = false;
  }

  // Check Redis readiness
  try {
    const pong = await healthRedisClient.ping();
    if (pong === 'PONG') {
      redisStatus = 'connected';
    } else {
      redisStatus = 'unexpected_response';
      isHealthy = false;
    }
  } catch (err) {
    console.error('[Healthcheck] Redis check failed:', err.message);
    redisStatus = 'error';
    isHealthy = false;
  }

  const statusCode = isHealthy ? 200 : 503;
  return res.status(statusCode).json({
    status: isHealthy ? 'healthy' : 'unhealthy',
    timestamp: new Date().toISOString(),
    services: {
      database: dbStatus,
      redis: redisStatus,
    },
  });
});

// Mount jobs router
app.use('/api/jobs', jobsRouter);

// Catch-all 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: 'Endpoint not found',
  });
});

let server = null;

async function startServer() {
  console.log('[API Service] Starting API service...');

  // Run DB migrations before accepting requests
  try {
    await runMigrations();
  } catch (err) {
    console.error('[API Service] Database migration failed during startup:', err.message);
    process.exit(1);
  }

  return new Promise((resolve) => {
    server = app.listen(port, '0.0.0.0', () => {
      console.log(`[API Service] API Server listening on port ${port}`);
      resolve(server);
    });
  });
}

async function shutdown(signal) {
  console.log(`[API Service] Received ${signal}, shutting down gracefully...`);
  if (server) {
    server.close();
  }
  try {
    await healthRedisClient.quit();
    await closeQueues();
    await pool.end();
    console.log('[API Service] Shutdown completed cleanly.');
    process.exit(0);
  } catch (err) {
    console.error('[API Service] Error during shutdown:', err);
    process.exit(1);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

if (require.main === module) {
  startServer().catch((err) => {
    console.error('[API Service Startup Error]:', err);
    process.exit(1);
  });
}

module.exports = {
  app,
  startServer,
};
