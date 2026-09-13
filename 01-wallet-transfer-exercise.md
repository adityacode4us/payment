# Paytm PML — R2 Agentic Exercise (Deploy & Reason): Wallet & P2P Transfer

Hi — welcome to Round 2. This is a build-it, **deploy-it, operate-it, and reason-about-it** round. Plan for roughly a day (1–1.5 days is fine). Everything can be done on free tiers for ₹0 — no card required. You may use AI tools; we just ask that you **disclose** where you *directed* the AI (you decided the approach, AI typed) versus where you *let it decide* (you accepted its design). This round is not about UI. It is about whether what you build stays correct under concurrency and failure, whether you can genuinely deploy and observe it, and the quality of your reasoning and orchestration.

## WHAT TO BUILD

A small wallet service with peer-to-peer transfers. Minimum API:

- `POST /wallets` — get-or-create a wallet for a user (returns wallet id + balance).
- `GET /wallets/{id}` — current balance.
- `POST /transfers` — move money from one wallet to another. Body carries `from`, `to`, `amount_paise`, and a client-supplied `idempotency_key`.
- `GET /transfers/{id}` — transfer status.

Auth: a simple bearer token per user identifies the caller. Money is always **integer paise** — never floats, never rupees-as-decimal.

## INVARIANTS (the real exercise)

These are the properties we grade. The API is just the surface.

1. **Conservation.** The sum of all wallet balances never changes across a transfer. No money is created or destroyed, even under concurrent transfers touching the same wallets.
2. **No overdraft.** A wallet balance never goes negative. A debit that would overdraw must fail cleanly (declined), not partially apply.
3. **Exactly-once transfer.** Re-sending the *same* `idempotency_key` applies the transfer **once**. A retry returns the original result. A reused key with a *different* body is a conflict (`409`), not a second debit.
4. **Race-free get-or-create.** Two concurrent `POST /wallets` for the same user yield **one** wallet, not two.

## THE THINGS WE WILL PROBE LIVE

We will run these against your deployed URL. Please include a **one-command burst script** (bash + curl, or a tiny Go/Node/Python file) that reproduces each:

- **Concurrent get-or-create:** fire N simultaneous `POST /wallets` for a brand-new user; expect exactly one wallet.
- **Idempotent retry storm:** fire the same transfer (same key) K times concurrently; expect exactly one debit/credit and identical responses.
- **Conservation under contention:** many concurrent transfers among a small set of wallets (including A→B and B→A at once); at the end, total balance is unchanged and no balance is negative.

## DESIGN CALLS TO REASON ABOUT (write-up)

- **The simplest-correct mechanism for conservation + no-overdraft.** What did you use — a row-locked conditional debit (`UPDATE … WHERE balance >= amount`), `SELECT … FOR UPDATE` in a sorted lock order, serializable isolation, something else? Why is it the *simplest* thing that is correct here, and what heavier alternatives did you reject (and why)? Call out how you avoid deadlock when two transfers lock the same two wallets in opposite orders.
- **Where idempotency lives.** Where is the `idempotency_key` uniqueness enforced, and is it committed in the *same transaction* as the debit/credit? What happens on a same-key/different-body replay?
- **Consistency vs availability for a money workload.** Given this is money, what did you choose and what did you consciously give up?

## THE REAL FOCUS — deploy, containerize, observe

This is where most of the weight is.

- **Dockerfile:** multi-stage, runs as a **non-root** user, has a `HEALTHCHECK`.
- **docker-compose:** app + Postgres, brought up with **one command**.
- **Deploy the image** to a free host (Render / Railway / Fly.io / Koyeb) backed by a **free managed Postgres**. Give us a public URL.
- **Logs:** structured JSON with a **correlation id** per request, logging the meaningful domain events (transfer created, debited, credited, declined, idempotent replay hit). Make them publicly viewable.
- **Metrics:** request rate, latency p99, error rate, plus **domain counters** (transfers created / declined-insufficient-funds / idempotent-replays). Expose `/metrics` or a small dashboard.

## WHAT TO SEND BACK

- Live URL (the deployed API).
- Public repo.
- Public logs link (or a screen recording of them streaming during a burst).
- The one-command burst script.
- A **one-page** write-up: data model; the simplest-correct mechanism + heavier alternatives you rejected; where idempotency lives; consistency-vs-availability; AI directed-vs-decided; free-tier cost note (should be ₹0).

## WHAT WE'RE EVALUATING (AND NOT)

We evaluate: **live correctness** (we reproduce the invariants against your URL), **genuine deploy / containerize / observe**, and **innovative orchestration and reasoning**. We do **not** grade UI polish, feature breadth, or auth sophistication. A correct, well-operated, well-reasoned wallet with no front-end beats a pretty one that double-spends under load.
