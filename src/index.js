const express = require('express');
const { pool, runMigrations } = require('./db');
const logger = require('./logger');
const authMiddleware = require('./middleware/auth');
const correlationMiddleware = require('./middleware/correlation');
const { metricsMiddleware, register } = require('./middleware/metrics');
const walletRoutes = require('./routes/wallets');
const transferRoutes = require('./routes/transfers');

const app = express();
const PORT = process.env.PORT || 8080;

// Global middleware
app.use(express.json());
app.use(correlationMiddleware);
app.use(metricsMiddleware);

// Health check (no auth)
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'healthy' });
  } catch (err) {
    res.status(503).json({ status: 'unhealthy', error: err.message });
  }
});

// Metrics endpoint (no auth)
app.get('/metrics', async (req, res) => {
  try {
    res.set('Content-Type', register.contentType);
    res.end(await register.metrics());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API routes (with auth)
app.use('/wallets', authMiddleware, walletRoutes);
app.use('/transfers', authMiddleware, transferRoutes);

// Start server
async function start() {
  try {
    await runMigrations();
    app.listen(PORT, '0.0.0.0', () => {
      logger.info({ port: PORT }, 'wallet service started');
    });
  } catch (err) {
    logger.fatal({ error: err.message }, 'failed to start');
    process.exit(1);
  }
}

start();
