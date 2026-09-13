# Wallet & P2P Transfer Service

A wallet service with peer-to-peer transfers built with **Node.js (Express) + PostgreSQL**. Designed for correctness under concurrency.

## Quick Start

### Prerequisites
- Docker & Docker Compose

### Run Locally (one command)
```bash
docker compose up --build
```

The service will be available at `http://localhost:8080`.

### API Endpoints

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| POST | `/wallets` | Get-or-create wallet | Bearer token |
| GET | `/wallets/:id` | Get wallet balance | Bearer token |
| POST | `/wallets/:id/deposit` | Deposit funds (seed) | Bearer token |
| POST | `/transfers` | Create transfer | Bearer token |
| GET | `/transfers/:id` | Get transfer status | Bearer token |
| GET | `/health` | Health check | None |
| GET | `/metrics` | Prometheus metrics | None |

### Authentication

Simple bearer token — the token value IS the user ID.

```bash
curl -H "Authorization: Bearer alice" http://localhost:8080/wallets \
  -H "Content-Type: application/json" \
  -d '{"user_id": "alice"}'
```

### Example: Create Wallet
```bash
curl -X POST http://localhost:8080/wallets \
  -H "Authorization: Bearer alice" \
  -H "Content-Type: application/json" \
  -d '{"user_id": "alice"}'
```

Response:
```json
{
  "id": "a1b2c3d4-...",
  "user_id": "alice",
  "balance": 0,
  "created_at": "2026-09-09T..."
}
```

### Example: Transfer Money
```bash
curl -X POST http://localhost:8080/transfers \
  -H "Authorization: Bearer alice" \
  -H "Content-Type: application/json" \
  -d '{
    "from": "<sender-wallet-id>",
    "to": "<receiver-wallet-id>",
    "amount_paise": 5000,
    "idempotency_key": "txn-001"
  }'
```

### Run Burst Tests
```bash
bash scripts/burst_test.sh http://localhost:8080
```

## Deployment

Deployed on Render.com free tier with managed PostgreSQL.

**Live URL:** _(to be added after deployment)_

## Architecture

```
Node.js (Express)
  ├── POST /wallets      → INSERT ON CONFLICT (race-free)
  ├── POST /transfers     → Single TX: INSERT transfer + conditional UPDATE (exactly-once + conservation)
  ├── /health             → DB ping
  └── /metrics            → Prometheus counters + histograms
         ↓
    PostgreSQL 16
      ├── wallets (UNIQUE user_id, CHECK balance >= 0)
      └── transfers (UNIQUE idempotency_key, body hash for 409)
```

See [WRITEUP.md](./WRITEUP.md) for the full design write-up.

## Observability

- **Structured JSON logs** (pino) with correlation IDs per request
- **Prometheus metrics** at `/metrics`
- Domain events: `wallet.created`, `transfer.created`, `transfer.debited`, `transfer.credited`, `transfer.declined.insufficient_funds`, `transfer.idempotent_replay`
