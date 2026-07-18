require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');

const { initDatabase } = require('./db/init');
const zonesRouter = require('./routes/zones');
const tripsRouter = require('./routes/trips');
const driversRouter = require('./routes/drivers');
const businessesRouter = require('./routes/businesses');
const paymentsRouter = require('./routes/payments');
const ridesRouter = require('./routes/rides');
const pricingRouter = require('./routes/pricing');
const messagesRouter = require('./routes/messages');
const safetyRouter = require('./routes/safety');
const logisticsRouter = require('./routes/logistics');
const medicalRouter = require('./routes/medical');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(morgan('combined'));
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));

// Static files for admin dashboard
app.use(express.static(path.join(__dirname, '..', 'public')));

// Simple auth middleware for admin routes
function adminAuth(req, res, next) {
  const secret = req.headers['x-admin-secret'] || req.query.secret;
  if (process.env.ADMIN_SECRET && secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// API Routes
app.use('/api/zones', adminAuth, zonesRouter);
app.use('/api/trips', tripsRouter);
app.use('/api/drivers', driversRouter);
app.use('/api/businesses', businessesRouter);
app.use('/api/payments', paymentsRouter);
app.use('/api/rides', ridesRouter);
app.use('/api/pricing', pricingRouter);
app.use('/api/messages', messagesRouter);
app.use('/api/safety', safetyRouter);
app.use('/api/logistics', logisticsRouter);
app.use('/api/medical', medicalRouter);

// Admin dashboard route
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'admin.html'));
});

// Money & payouts dashboard (gated client-side by the admin code)
app.get('/money', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'money.html'));
});

let dbReady = false;
let dbError = null;

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: dbReady ? 'ok' : 'degraded', db: dbReady, dbError: dbError ? dbError.message : null, service: 'msouwout-geofence', timestamp: new Date().toISOString() });
});

// Start server immediately, init DB in background
app.listen(PORT, () => {
  console.log(`MsouWout Geofencing API running on port ${PORT}`);
  initDatabase()
    .then(() => { dbReady = true; console.log('Database initialized successfully.'); })
    .catch(err => { dbError = err; console.error('Database init failed:', err.message); });
});

module.exports = app;
// deploy Wed Jun 25 2026 - added DB retry logic
