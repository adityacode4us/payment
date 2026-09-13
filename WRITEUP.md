# Wallet & P2P Transfer — Design Write-Up

## Data Model

Two tables in PostgreSQL:

- **wallets**: `id` (UUID PK), `user_id` (TEXT, UNIQUE), `balance` (BIGINT, CHECK >= 0), `created_at`
- **transfers**: `id` (UUID PK), `idempotency_key` (TEXT, UNIQUE), `from_wallet_id` / `to_wallet_id` (UUID FK), `amount_paise` (BIGINT, CHECK > 0), `status` (completed/declined), `request_body_hash` (TEXT), `created_at`

Money is always **integer paise** — never floats, never rupees-as-decimal. `BIGINT` handles amounts up to ₹92 quadrillion.

## The Mechanism for Conservation & Deadlock-Free No-Overdraft

**Chosen: Deterministic Sorted Row Locking (`SELECT ... FOR UPDATE ORDER BY id ASC`)**

To guarantee consistency and avoid deadlocks across concurrent transfers (including simultaneous $A \rightarrow B$ and $B \rightarrow A$ transfers), both wallet rows are locked in a strict, globally sorted order before any debit or credit:

```sql
SELECT id, balance 
FROM wallets 
WHERE id IN ($from, $to) 
ORDER BY id ASC 
FOR UPDATE;
```

**Why this is the robust, deadlock-free solution:**
1. **Mathematical Deadlock Immunity:** Any two transactions that touch wallets $A$ and $B$ (whether $A \rightarrow B$ or $B \rightarrow A$) will query and acquire row-level exclusive locks in the exact same sequence (`min(A, B)` then `max(A, B)`). Because lock acquisition direction is globally invariant, circular waits are impossible.
2. **Atomicity & No Lost Updates:** While the locks are held, the sender balance is verified. If sufficient, sender is debited and receiver is credited, and the transaction commits. No concurrent transaction can alter or read intermediate balances.
3. **Clean Declines:** If sender balance is insufficient, the transfer row is marked `declined` and committed cleanly. No money is moved.

**Rejected alternatives:**

| Alternative | Why Rejected |
|---|---|
| Naive Unsorted `UPDATE` / `SELECT ... FOR UPDATE` | **Deadlock hazard.** If $A \rightarrow B$ debits $A$ first then credits $B$, and concurrent $B \rightarrow A$ debits $B$ first then credits $A$, transactions cyclicly wait on each other, triggering PostgreSQL `40P01` deadlock aborts under contention storms. |
| Serializable Isolation (`ISOLATION LEVEL SERIALIZABLE`) | Correct, but causes frequent serialization failures (`ERROR: could not serialize access`) under contention, requiring complex application retry loops and high overhead compared to deterministic locking. |
| App-level Read-Modify-Write | **Broken.** Classic lost-update: two concurrent threads read balance, subtract locally, and overwrite each other, creating or destroying money. |

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
