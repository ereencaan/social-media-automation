const express = require('express');
const router = express.Router();
const { register, login } = require('../services/auth.service');
const { requireAuth } = require('../middleware/auth');

// Regenerate session to prevent fixation, then set userId
function startSession(req, res, user, status) {
  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: 'Session error' });
    req.session.userId = user.id;
    req.session.save((saveErr) => {
      if (saveErr) return res.status(500).json({ error: 'Session error' });
      res.status(status).json(user);
    });
  });
}

router.post('/register', async (req, res) => {
  try {
    const user = await register(req.body);
    startSession(req, res, user, 200);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/login', async (req, res) => {
  try {
    const user = await login(req.body);
    startSession(req, res, user, 200);
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) return res.status(500).json({ error: 'Logout failed' });
    res.clearCookie('connect.sid');
    res.json({ ok: true });
  });
});

router.get('/me', requireAuth, (req, res) => {
  res.json(req.user);
});

module.exports = router;
