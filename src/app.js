const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env'), override: true });
const express = require('express');
const session = require('express-session');
const { getDb } = require('./config/database');
const { requireAuth } = require('./middleware/auth');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
if (process.env.NODE_ENV === 'production' && !process.env.SESSION_SECRET) {
  throw new Error('SESSION_SECRET must be set in production');
}
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret-change-in-prod',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 * 24 * 7 // 7 days
  }
}));
app.use(express.static(path.join(__dirname, '../public')));

// Public routes
app.use('/api/auth', require('./routes/auth.routes'));

// Protected routes
// /storage contains user-uploaded media which may contain PII. Gate it on auth.
app.use('/storage', requireAuth, express.static(path.join(__dirname, '../storage')));
app.use('/api/posts', requireAuth, require('./routes/posts.routes'));
app.use('/api/brand', requireAuth, require('./routes/brand.routes'));
app.use('/api/leads', requireAuth, require('./routes/leads.routes'));
app.use('/api/plans', requireAuth, require('./routes/plans.routes'));
app.use('/api/connect', requireAuth, require('./routes/connect.routes'));

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// Start server after DB init
async function start() {
  await getDb();
  app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
    const { loadPendingSchedules } = require('./services/scheduler.service');
    loadPendingSchedules();
  });
}

start().catch(err => {
  console.error('Failed to start:', err);
  process.exit(1);
});
