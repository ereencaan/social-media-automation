const bcrypt = require('bcryptjs');
const { prepare } = require('../config/database');
const { generateId } = require('../utils/helpers');

const SALT_ROUNDS = 10;

async function register({ email, password, name, orgName }) {
  if (!email || !password) throw new Error('Email and password are required');
  if (password.length < 8) throw new Error('Password must be at least 8 characters');

  const existing = prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());
  if (existing) throw new Error('Email already registered');

  const orgId = generateId();
  const userId = generateId();
  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

  prepare('INSERT INTO orgs (id, name) VALUES (?, ?)').run(orgId, orgName || `${email}'s workspace`);
  prepare('INSERT INTO users (id, org_id, email, password_hash, name, role) VALUES (?, ?, ?, ?, ?, ?)')
    .run(userId, orgId, email.toLowerCase(), passwordHash, name || null, 'owner');
  prepare('INSERT INTO brand_settings (org_id) VALUES (?)').run(orgId);

  return { id: userId, orgId, email: email.toLowerCase(), name, role: 'owner' };
}

async function login({ email, password }) {
  if (!email || !password) throw new Error('Email and password are required');
  const user = prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase());
  if (!user) throw new Error('Invalid credentials');

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) throw new Error('Invalid credentials');

  return { id: user.id, orgId: user.org_id, email: user.email, name: user.name, role: user.role };
}

function getUser(userId) {
  const user = prepare('SELECT id, org_id, email, name, role, created_at FROM users WHERE id = ?').get(userId);
  if (!user) return null;
  return { id: user.id, orgId: user.org_id, email: user.email, name: user.name, role: user.role, createdAt: user.created_at };
}

module.exports = { register, login, getUser };
