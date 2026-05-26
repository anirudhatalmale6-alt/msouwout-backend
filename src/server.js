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

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'msouwout-geofence', timestamp: new Date().toISOString() });
});

// Initialize database then start server
initDatabase()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`MsouWout Geofencing API running on port ${PORT}`);
      console.log(`Admin dashboard: http://localhost:${PORT}/admin`);
    });
  })
  .catch(err => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });

module.exports = app;
// deploy Tue May 06 07:20:00 AM UTC 2026
