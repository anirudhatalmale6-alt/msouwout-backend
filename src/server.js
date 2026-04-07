require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');

const zonesRouter = require('./routes/zones');
const tripsRouter = require('./routes/trips');

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

// Admin dashboard route
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'admin.html'));
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'msouwout-geofence', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`MsouWout Geofencing API running on port ${PORT}`);
  console.log(`Admin dashboard: http://localhost:${PORT}/admin`);
});

module.exports = app;
