require('dotenv').config();
const express = require('express');
const path = require('path');
const { getDb } = require('./config/database');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// Routes
app.use('/api/posts', require('./routes/posts.routes'));

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
