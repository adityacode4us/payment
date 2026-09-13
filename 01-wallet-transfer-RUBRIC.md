# INTERNAL — Wallet & P2P Transfer (R2) grading rubric — do NOT forward to the candidate

## Hard gates (live-probed)

Each gate is reproduced against the candidate's deployed URL. For each: the reproduce recipe, the TELL (correct mechanism) vs the anti-pattern.

### Gate 1 — Race-free get-or-create
- **Reproduce:** fire 50 concurrent `POST /wallets` for a fresh user id (`xargs -P50` / `hey` / a goroutine burst). Then `GET` and count wallets for that user in the DB (or infer via distinct wallet ids returned).
- **TELL (correct):** exactly one wallet. Mechanism is `INSERT … ON CONFLICT (user_id) DO NOTHING` followed by a re-`SELECT`, or a unique constraint on `user_id` with the duplicate-insert caught and the existing row returned. Unique constraint present on `user_id`.
- **Anti-pattern:** check-then-insert (`SELECT`, if none `INSERT`) with no unique constraint → two wallets, or a 500 from a unique-violation the code doesn't handle. Either is a fail.

### Gate 2 — Idempotent exactly-once transfer
- **Reproduce:** same `idempotency_key`, same body, fired K=30 times concurrently. Then check balances and the transfer row count.
- **TELL (correct):** exactly one debit + one credit; all K responses identical (same transfer id/status). Uniqueness on `idempotency_key` is committed **in the same transaction** as the ledger movement, so a concurrent duplicate either waits and reads the committed result or loses the insert race and returns the existing transfer. Same key + **different** body → `409`.
- **Anti-pattern:** idempotency checked in a separate transaction / before the debit (TOCTOU) → double debit under the storm. Or key uniqueness only enforced in app memory (breaks across instances). Or same-key-different-body silently returns the first result (should be 409). Reproduced double-apply is a reject trigger.

### Gate 3 — Conservation + no-overdraft under contention
- **Reproduce:** seed a few wallets; fire hundreds of concurrent transfers among them, including A→B and B→A simultaneously and some that would overdraw. Sum balances before/after.
- **TELL (correct):** total unchanged; no negative balances; overdrawing transfers declined cleanly (no partial apply). Debit is an atomic conditional `UPDATE … WHERE balance >= amount` (rows affected = 0 → decline), or `SELECT … FOR UPDATE` with a **deterministic sorted lock order** (e.g. lock lower wallet id first) to avoid deadlock. No lost updates.
- **Anti-pattern:** read balance into app, subtract, write back (lost update → money created/destroyed); or unsorted `FOR UPDATE` → deadlock storm / 500s under the A→B + B→A cross; or a negative balance appearing. Money not conserved or a float representation = reject.

## Weighting

- **Correctness under load (Gates 1–3): ~50%.** This is the gate. Any reproduced failure caps the candidate.
- **Orchestration / solutioning innovation + deploy/observe: ~35%.** Simplest-correct mechanism chosen deliberately (not cargo-culted serializable-everything); clean sorted-lock or conditional-update; real container hygiene (multi-stage, non-root, healthcheck); image actually deployed and reachable; structured JSON logs with correlation id streaming the right domain events; useful metrics (p99 + domain counters), not just a default `/metrics` dump.
- **Docs / reasoning write-up: ~15%.** Data model clear; rejected alternatives named with reasons; idempotency placement explained; consistency/availability call made honestly; AI directed-vs-decided disclosed.

UI is **not** graded. Do not reward front-end effort.

## Reject triggers

- Reproduced race: two wallets from concurrent get-or-create, or double debit under the idempotency storm.
- Conservation broken (total changes) or a negative balance under contention.
- Money represented as float / rupees-decimal.
- Clean-checkout build fails, or `docker compose up` / CI build fails from a fresh clone.
- A write-up claim contradicted by the deployed behavior (e.g. "exactly-once" but we reproduce a double-apply) — **honesty gate**, reject.
- Commit provenance shows foreign/AI-bot authorship (e.g. commits authored by an agent account, or a single squashed "initial commit" with no human history) inconsistent with the candidate — investigate, likely reject.

## Debrief questions (with tells)

1. **"Walk me through what happens if two transfers, A→B and B→A, hit at the same instant."** Tell: strong candidate immediately talks deadlock and their deterministic lock ordering (or why conditional `UPDATE` sidesteps locking two rows). Weak: hasn't considered it, or hand-waves "the DB handles it."
2. **"Your idempotency key — what transaction is its uniqueness committed in, and why does that matter?"** Tell: strong says same tx as the ledger write, explains the TOCTOU otherwise. Weak: separate check, or "I check if it exists first."
3. **"Why conditional UPDATE vs SELECT FOR UPDATE vs SERIALIZABLE — what did you pick and reject?"** Tell: strong reasons about simplicity, contention, retry-on-serialization-failure cost. Weak: picked one with no awareness of the others.
4. **"Show me a log line for a declined-insufficient-funds transfer and trace its correlation id."** Tell: strong pulls it live with the id threading request→decision. Weak: no structured logs, or can't find it.

## R3 LIVE FOLLOW-UP — in-call feature addition (REQUIRED; this is the live-debug round for the R3 panel)

**(a) The exact extension to request:** "Add a **reversal / refund transfer**: `POST /transfers/{id}/reverse` with its own `idempotency_key` that moves the exact amount back from the original recipient to the original sender. Implement it live and redeploy."

**(b) Why it probes the core:** a reversal is a *second* money movement bound to a first — it stresses **conservation** (the reversal must not create or destroy money), **exactly-once** (reversing twice must not double-refund — its own idempotency), and **no-overdraft** (the recipient may have already spent the funds — the reversal must decline cleanly or the candidate must reason about holds). It forces them to reuse their ledger primitive rather than bolt on a special case.

**(c) The TELL:** *Strong* — reuses the same atomic conditional-debit primitive with roles swapped, puts the reversal's idempotency key in the same tx as its movement, guards against reversing an already-reversed or non-existent transfer, and reasons aloud about the recipient-has-insufficient-funds case (decline vs. allow-negative-as-policy). *Weak* — a naked `balance = balance + amount` credit with no debit (breaks conservation), no idempotency on the reverse (double-refund), or lets the recipient go negative silently.

**(d) How we verify live:** after redeploy, fire the reversal twice concurrently with the same key (expect one refund), confirm total balance returns to the pre-transfer sum, and try reversing an already-reversed transfer (expect a clean 409/declined, not a second refund). Optionally drain the recipient first, then reverse, and watch how their implementation handles it.
