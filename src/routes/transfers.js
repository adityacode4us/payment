const express = require('express');
const crypto = require('crypto');
const { pool } = require('../db');
const logger = require('../logger');
const {
  transfersTotal,
  idempotentReplaysTotal,
  declinedInsufficientFunds,
} = require('../middleware/metrics');

const router = express.Router();

// Hash the request body for idempotency conflict detection
function hashRequestBody(from, to, amountPaise) {
  const canonical = JSON.stringify({ amount_paise: amountPaise, from, to });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

// POST /transfers — create a transfer
router.post('/', async (req, res) => {
  const { from, to, amount_paise, idempotency_key } = req.body;
  const corrId = req.correlationId;
  const log = logger.child({ correlation_id: corrId });

  // Validation
  if (!from || !to || !amount_paise || !idempotency_key) {
    return res.status(400).json({ error: 'from, to, amount_paise, and idempotency_key are required' });
  }
  if (typeof amount_paise !== 'number' || amount_paise <= 0 || !Number.isInteger(amount_paise)) {
    return res.status(400).json({ error: 'amount_paise must be a positive integer' });
  }
  if (from === to) {
    return res.status(400).json({ error: 'cannot transfer to same wallet' });
  }

  const bodyHash = hashRequestBody(from, to, amount_paise);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Gate 2: Try to insert the transfer — idempotency_key UNIQUE constraint
    // in the SAME transaction as the debit/credit
    let transferRow;
    try {
      const insertResult = await client.query(
        `INSERT INTO transfers (idempotency_key, from_wallet_id, to_wallet_id, amount_paise, status, request_body_hash)
         VALUES ($1, $2, $3, $4, 'pending', $5)
         RETURNING id, idempotency_key, from_wallet_id, to_wallet_id, amount_paise, status, created_at`,
        [idempotency_key, from, to, amount_paise, bodyHash]
      );
      transferRow = insertResult.rows[0];
    } catch (err) {
      await client.query('ROLLBACK');

      // Unique violation on idempotency_key (code 23505)
      if (err.code === '23505' && err.constraint && err.constraint.includes('idempotency_key')) {
        // Check if it's a replay (same body) or conflict (different body)
        const existing = await pool.query(
          `SELECT id, idempotency_key, from_wallet_id, to_wallet_id, amount_paise, status, request_body_hash, created_at
           FROM transfers WHERE idempotency_key = $1`,
          [idempotency_key]
        );

        if (existing.rows.length === 0) {
          return res.status(500).json({ error: 'internal server error' });
        }

        const existingTransfer = existing.rows[0];
        if (existingTransfer.request_body_hash === bodyHash) {
          // Idempotent replay — same key, same body
          log.info({ event: 'transfer.idempotent_replay', transfer_id: existingTransfer.id }, 'idempotent replay detected');
          idempotentReplaysTotal.inc();
          const { request_body_hash, ...safeTransfer } = existingTransfer;
          return res.status(200).json(safeTransfer);
        } else {
          // Same key, different body — 409 Conflict
          return res.status(409).json({ error: 'idempotency key conflict: different request body' });
        }
      }

      // Foreign key violation — wallet not found
      if (err.code === '23503') {
        return res.status(404).json({ error: 'wallet not found' });
      }

      throw err;
    }

    // Gate 3: Deterministic lock ordering to prevent deadlock on concurrent cross-transfers (A->B and B->A)
    // Always lock both rows in ascending order of UUID.
    const lockQuery = `
      SELECT id, balance 
      FROM wallets 
      WHERE id IN ($1, $2) 
      ORDER BY id ASC 
      FOR UPDATE
    `;
    const lockResult = await client.query(lockQuery, [from, to]);

    if (lockResult.rows.length < 2) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'one or both wallets not found' });
    }

    const senderWallet = lockResult.rows.find((w) => w.id === from);
    const senderBalance = Number(senderWallet.balance);

    if (senderBalance < amount_paise) {
      // Insufficient funds — mark as declined and commit
      await client.query(
        "UPDATE transfers SET status = 'declined' WHERE id = $1",
        [transferRow.id]
      );
      await client.query('COMMIT');

      log.info({ event: 'transfer.declined.insufficient_funds', transfer_id: transferRow.id }, 'transfer declined: insufficient funds');
      declinedInsufficientFunds.inc();
      transfersTotal.inc({ status: 'declined' });

      transferRow.status = 'declined';
      return res.status(200).json(transferRow);
    }

    // Both rows locked in deterministic order: execute debit & credit safely
    await client.query(
      'UPDATE wallets SET balance = balance - $1 WHERE id = $2',
      [amount_paise, from]
    );

    await client.query(
      'UPDATE wallets SET balance = balance + $1 WHERE id = $2',
      [amount_paise, to]
    );

    // Mark as completed
    await client.query(
      "UPDATE transfers SET status = 'completed' WHERE id = $1",
      [transferRow.id]
    );

    await client.query('COMMIT');

    log.info({ event: 'transfer.created', transfer_id: transferRow.id, amount_paise }, 'transfer created');
    log.info({ event: 'transfer.debited', wallet_id: from, amount_paise }, 'source wallet debited');
    log.info({ event: 'transfer.credited', wallet_id: to, amount_paise }, 'destination wallet credited');
    transfersTotal.inc({ status: 'completed' });

    transferRow.status = 'completed';
    res.status(201).json(transferRow);
  } catch (err) {
    await client.query('ROLLBACK');
    log.error({ error: err.message }, 'transfer failed');
    res.status(500).json({ error: 'internal server error' });
  } finally {
    client.release();
  }
});

// GET /transfers/:id — get transfer status
router.get('/:id', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, idempotency_key, from_wallet_id, to_wallet_id, amount_paise, status, created_at FROM transfers WHERE id = $1',
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'transfer not found' });
    }

    res.status(200).json(result.rows[0]);
  } catch (err) {
    logger.error({ error: err.message, correlation_id: req.correlationId }, 'get transfer failed');
    res.status(500).json({ error: 'internal server error' });
  }
});

module.exports = router;
