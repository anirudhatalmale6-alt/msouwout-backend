const express = require('express');
const router = express.Router();
const { getPricingConfig, savePricingConfig, getDynamicSurge, DEFAULT_CONFIG } = require('../services/pricing');

// GET /api/pricing — Get current pricing config
router.get('/', async (req, res) => {
  try {
    const config = await getPricingConfig();
    res.json({ config, editable_fields: Object.keys(DEFAULT_CONFIG) });
  } catch (err) {
    console.error('Get pricing error:', err);
    res.status(500).json({ error: 'Erè sèvè' });
  }
});

// GET /api/pricing/surge — Get current dynamic surge info (public)
router.get('/surge', async (req, res) => {
  try {
    const config = await getPricingConfig();
    const rideType = (req.query.ride_type || 'moto').toLowerCase();
    const surge = await getDynamicSurge(config, rideType);
    res.json({
      dynamic_pricing: config.dynamic_pricing,
      ride_type: rideType === 'car' ? 'car' : 'moto',
      multiplier: surge.multiplier,
      surge_pct: surge.pct,
      surge_type: surge.type,
      factors: surge.factors,
      hour: surge.hour,
      active_rides: surge.active_rides,
      raining: surge.raining,
      max_surge_pct: config.max_surge_pct
    });
  } catch (err) {
    console.error('Surge check error:', err);
    res.status(500).json({ error: 'Erè sèvè' });
  }
});

// PUT /api/pricing — Update pricing config (admin)
router.put('/', async (req, res) => {
  try {
    const updates = req.body;
    const allowed = Object.keys(DEFAULT_CONFIG);
    const filtered = {};
    for (const key of allowed) {
      if (updates[key] !== undefined) {
        filtered[key] = Number(updates[key]);
        if (isNaN(filtered[key])) {
          return res.status(400).json({ error: `${key} dwe yon nimewo` });
        }
      }
    }

    if (Object.keys(filtered).length === 0) {
      return res.status(400).json({ error: 'Pa gen chanjman', editable_fields: allowed });
    }

    const current = await getPricingConfig();
    const merged = { ...current, ...filtered };
    const saved = await savePricingConfig(merged);

    res.json({ message: 'Konfigurasyon pri aktyalize', config: saved });
  } catch (err) {
    console.error('Update pricing error:', err);
    res.status(500).json({ error: 'Erè sèvè' });
  }
});

// POST /api/pricing/reset — Reset to defaults (admin)
router.post('/reset', async (req, res) => {
  try {
    const saved = await savePricingConfig(DEFAULT_CONFIG);
    res.json({ message: 'Konfigurasyon retounen pa defo', config: saved });
  } catch (err) {
    console.error('Reset pricing error:', err);
    res.status(500).json({ error: 'Erè sèvè' });
  }
});

module.exports = router;
