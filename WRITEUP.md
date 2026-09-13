# Wallet & P2P Transfer — Design Write-Up

## Data Model

Two tables in PostgreSQL:

- **wallets**: `id` (UUID PK), `user_id` (TEXT, UNIQUE), `balance` (BIGINT, CHECK >= 0), `created_at`
- **transfers**: `id` (UUID PK), `idempotency_key` (TEXT, UNIQUE), `from_wallet_id` / `to_wallet_id` (UUID FK), `amount_paise` (BIGINT, CHECK > 0), `status` (completed/declined), `request_body_hash` (TEXT), `created_at`

Money is always **integer paise** — never floats, never rupees-as-decimal. `BIGINT` handles amounts up to ₹92 quadrillion.

## Simplest-Correct Mechanism: Conditional UPDATE

**Chosen:** Atomic conditional debit — `UPDATE wallets SET balance = balance - $amount WHERE id = $id AND balance >= $amount`. If `rowCount = 0`, the transfer is declined (insufficient funds).

**Why it's the simplest correct approach:**
- Single-row atomic operation — no explicit row locking, no deadlock possible.
- `balance = balance - amount` happens inside the UPDATE; we never read-modify-write in application code, so there are no lost updates.
- The `WHERE balance >= amount` check and the debit are atomic within one statement.

**Rejected alternatives:**

| Alternative | Why Rejected |
|---|---|
| `SELECT ... FOR UPDATE` with sorted lock order | Correct, but heavier: requires deterministic lock ordering logic (lock lower wallet ID first), holds locks longer, more complex code. Overkill when a single conditional UPDATE suffices. |
| Serializable isolation | Correct, but causes serialization failures (`ERROR: could not serialize access`) under contention, requiring application-level retry loops. Added complexity for no benefit over conditional UPDATE. |
| App-level read → subtract → write | **Broken.** Classic lost-update: two concurrent reads see the same balance, both subtract, one write overwrites the other. Money created or destroyed. |

**Deadlock avoidance:** Since each transfer uses single-row UPDATEs (debit then credit), and PostgreSQL's row-level locks on individual UPDATE statements are released at commit, there is no two-row lock-ordering problem. Two concurrent A→B and B→A transfers cannot deadlock because neither holds two row locks simultaneously in a way that creates a cycle.

## Where Idempotency Lives

The `idempotency_key` is a UNIQUE column in the `transfers` table. Its uniqueness is enforced **in the same transaction** as the debit and credit:

1. `INSERT INTO transfers (idempotency_key, ...) VALUES (...)` — if this succeeds, proceed with debit/credit.
2. If the INSERT hits a unique violation (concurrent duplicate), rollback and SELECT the existing transfer.
3. Compare `request_body_hash` (SHA-256 of canonical request body): same hash → return existing result (idempotent replay); different hash → `409 Conflict`.

**Why same-transaction matters:** If idempotency were checked in a separate transaction (check-then-insert), two concurrent requests with the same key could both pass the check, both insert, and both debit — a TOCTOU (time-of-check-time-of-use) race causing double-spend.

## Consistency vs. Availability

**Chose: Consistency (CP).** For a money workload, a declined or delayed transfer is always preferable to a double-spend or phantom balance. We use PostgreSQL (single-node, strong consistency, ACID transactions). Under partition or high load, requests may fail or be slow, but balances will never be wrong.

**What we give up:** Under extreme load or database unavailability, requests will fail rather than return stale/optimistic results. This is the correct trade-off for financial data.

## AI Disclosure

- **Directed (I chose the approach, AI typed):** Database schema design, locking strategy selection (conditional UPDATE over SELECT FOR UPDATE), idempotency placement decision, Dockerfile structure, deployment platform choice.
- **Let it decide:** Boilerplate code generation (Express routes, Prometheus setup), docker-compose syntax, burst test script structure.

## Cost

**₹0.** Render.com free tier: free web service (Docker) + free PostgreSQL (256 MB). No credit card required.
