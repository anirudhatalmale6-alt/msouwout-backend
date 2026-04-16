const { Router } = require('express');
const router = Router();

const SOLUTIONIP_URL = 'https://plopplop.solutionip.app';
const CLIENT_ID = process.env.SOLUTIONIP_CLIENT_ID || 'pp_1ohu5zz2tcx';

// POST /api/payments/create — Create a payment transaction
router.post('/create', async (req, res) => {
  try {
    const { reference_id, amount, payment_method, description } = req.body;

    if (!reference_id || !amount || !payment_method) {
      return res.status(400).json({ error: 'reference_id, amount, and payment_method are required' });
    }

    if (amount < 20) {
      return res.status(400).json({ error: 'Minimum amount is 20 HTG' });
    }

    const validMethods = ['moncash', 'natcash', 'kashpaw', 'all'];
    if (!validMethods.includes(payment_method)) {
      return res.status(400).json({ error: 'Invalid payment_method. Use: moncash, natcash, kashpaw, or all' });
    }

    const response = await fetch(`${SOLUTIONIP_URL}/api/paiement-marchand`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        refference_id: reference_id,
        montant: amount,
        payment_method: payment_method
      })
    });

    const data = await response.json();

    if (data.status === true) {
      res.json({
        success: true,
        payment_url: data.url,
        transaction_id: data.transaction_id,
        reference_id: reference_id,
        amount: amount,
        method: payment_method
      });
    } else {
      res.status(400).json({
        success: false,
        error: data.message || 'Payment creation failed'
      });
    }
  } catch (err) {
    console.error('Payment create error:', err);
    res.status(500).json({ error: 'Payment service unavailable' });
  }
});

// POST /api/payments/verify — Verify a payment status
router.post('/verify', async (req, res) => {
  try {
    const { reference_id } = req.body;

    if (!reference_id) {
      return res.status(400).json({ error: 'reference_id is required' });
    }

    const response = await fetch(`${SOLUTIONIP_URL}/api/paiement-verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        refference_id: reference_id
      })
    });

    const data = await response.json();

    if (data.status === true) {
      res.json({
        success: true,
        paid: data.trans_status === 'ok',
        transaction_status: data.trans_status,
        transaction_id: data.id_transaction,
        amount: data.montant,
        method: data.method,
        date: data.date,
        time: data.heure
      });
    } else {
      res.status(400).json({
        success: false,
        error: data.message || 'Verification failed'
      });
    }
  } catch (err) {
    console.error('Payment verify error:', err);
    res.status(500).json({ error: 'Payment service unavailable' });
  }
});

module.exports = router;
