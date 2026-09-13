const express = require('express');
const { pool } = require('../db');
const logger = require('../logger');
const { walletCreatesTotal } = require('../middleware/metrics');

const router = express.Router();

// POST /wallets — get-or-create wallet
router.post('/', async (req, res) => {
  try {
    const { user_id } = req.body;
    if (!user_id) {
      return res.status(400).json({ error: 'user_id is required' });
    }

    // Gate 1: Race-free get-or-create using INSERT ON CONFLICT
    await pool.query(
      'INSERT INTO wallets (user_id, balance) VALUES ($1, 0) ON CONFLICT (user_id) DO NOTHING',
      [user_id]
    );

    const result = await pool.query(
      'SELECT id, user_id, balance, created_at FROM wallets WHERE user_id = $1',
      [user_id]
    );

    const wallet = result.rows[0];

    logger.info({
      event: 'wallet.created',
      correlation_id: req.correlationId,
      wallet_id: wallet.id,
      user_id: wallet.user_id,
    }, 'wallet get-or-created');

    walletCreatesTotal.inc();

    res.status(200).json(wallet);
  } catch (err) {
    logger.error({ error: err.message, correlation_id: req.correlationId }, 'wallet creation failed');
    res.status(500).json({ error: 'internal server error' });
  }
});

// GET /wallets/:id — get wallet balance
router.get('/:id', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, user_id, balance, created_at FROM wallets WHERE id = $1',
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'wallet not found' });
    }

    res.status(200).json(result.rows[0]);
  } catch (err) {
    logger.error({ error: err.message, correlation_id: req.correlationId }, 'get wallet failed');
    res.status(500).json({ error: 'internal server error' });
  }
});

// POST /wallets/:id/deposit — add funds to a wallet (for seeding/testing)
router.post('/:id/deposit', async (req, res) => {
  try {
    const { amount_paise } = req.body;
    if (!amount_paise || typeof amount_paise !== 'number' || amount_paise <= 0 || !Number.isInteger(amount_paise)) {
      return res.status(400).json({ error: 'amount_paise must be a positive integer' });
    }

    const result = await pool.query(
      'UPDATE wallets SET balance = balance + $1 WHERE id = $2 RETURNING id, user_id, balance, created_at',
      [amount_paise, req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'wallet not found' });
    }

    logger.info({
      event: 'wallet.deposited',
      correlation_id: req.correlationId,
      wallet_id: req.params.id,
      amount_paise,
    }, 'funds deposited');

    res.status(200).json(result.rows[0]);
  } catch (err) {
    logger.error({ error: err.message, correlation_id: req.correlationId }, 'deposit failed');
    res.status(500).json({ error: 'internal server error' });
  }
});

module.exports = router;
