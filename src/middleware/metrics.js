const client = require('prom-client');

// Collect default metrics
client.collectDefaultMetrics();

const httpRequestsTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'path', 'status'],
});

const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'path'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
});

const transfersTotal = new client.Counter({
  name: 'transfers_total',
  help: 'Total transfers by status',
  labelNames: ['status'],
});

const idempotentReplaysTotal = new client.Counter({
  name: 'idempotent_replays_total',
  help: 'Total idempotent transfer replays',
});

const walletCreatesTotal = new client.Counter({
  name: 'wallet_creates_total',
  help: 'Total wallets created',
});

const declinedInsufficientFunds = new client.Counter({
  name: 'declined_insufficient_funds_total',
  help: 'Transfers declined due to insufficient funds',
});

function metricsMiddleware(req, res, next) {
  const start = process.hrtime.bigint();
  
  res.on('finish', () => {
    const duration = Number(process.hrtime.bigint() - start) / 1e9;
    const path = req.route ? req.route.path : req.path;
    httpRequestsTotal.inc({ method: req.method, path, status: res.statusCode });
    httpRequestDuration.observe({ method: req.method, path }, duration);
  });
  
  next();
}

module.exports = {
  metricsMiddleware,
  httpRequestsTotal,
  httpRequestDuration,
  transfersTotal,
  idempotentReplaysTotal,
  walletCreatesTotal,
  declinedInsufficientFunds,
  register: client.register,
};
