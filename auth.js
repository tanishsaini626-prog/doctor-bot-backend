'use strict';
/* ==========================================================================
 * auth.js - JWT login for the dashboard
 * --------------------------------------------------------------------------
 * POST /api/auth/register   first user ever -> becomes admin (no token needed)
 *                           later users    -> needs an admin token
 * POST /api/auth/login      { email, password } -> { token, user }
 * GET  /api/me              (Bearer token) -> current user
 *
 * The dashboard APIs use requireAuth(); the Twilio webhooks do NOT (they are
 * machines, not users - they use Twilio signature validation instead).
 * ========================================================================== */

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const TOKEN_HOURS = 12;

function createAuth(store) {
  const router = express.Router();

  function signToken(user) {
    return jwt.sign(
      { sub: String(user._id), email: user.email, role: user.role, clinic: user.clinic || null },
      process.env.JWT_SECRET,
      { expiresIn: `${TOKEN_HOURS}h` }
    );
  }

  function publicUser(user) {
    return {
      _id: user._id, name: user.name, email: user.email,
      role: user.role, clinic: user.clinic || null,
    };
  }

  // ---- register ----------------------------------------------------------
  router.post('/auth/register', optionalAuth, async (req, res) => {
    try {
      const { email, password, name, role } = req.body || {};
      if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
        return res.status(400).json({ error: 'A valid email is required' });
      }
      if (!password || String(password).length < 8) {
        return res.status(400).json({ error: 'Password must be at least 8 characters' });
      }
      const allowedRoles = ['clinic_owner', 'receptionist'];

      const userCount = await store.countUsers();

      // The very first user becomes the admin - after that you need the admin token.
      if (userCount > 0) {
        const enforcer = req.user;
        if (!enforcer || enforcer.role !== 'admin') {
          return res.status(403).json({ error: 'Only an admin can create new users. Please log in as admin first.' });
        }
      }
      if (await store.findUserByEmail(email)) {
        return res.status(409).json({ error: 'This email is already registered' });
      }

      const firstRole = userCount === 0 ? 'admin' : (allowedRoles.includes(role) ? role : 'receptionist');
      const password_hash = await bcrypt.hash(String(password), 10);
      const user = await store.createUser({
        email: String(email).toLowerCase().trim(),
        password_hash,
        name: name || '',
        role: firstRole,
      });

      res.status(201).json({ token: signToken(user), user: publicUser(user) });
    } catch (err) {
      console.error('register failed:', err.message);
      res.status(500).json({ error: 'Registration failed' });
    }
  });

  // ---- login ---------------------------------------------------------------
  router.post('/auth/login', async (req, res) => {
    try {
      const { email, password } = req.body || {};
      if (!email || !password) {
        return res.status(400).json({ error: 'Email and password are required' });
      }
      const user = await store.findUserByEmail(String(email).toLowerCase().trim());
      // same error for unknown email and wrong password (no account guessing)
      if (!user || !user.active || !(await bcrypt.compare(String(password), user.password_hash))) {
        return res.status(401).json({ error: 'Invalid email or password' });
      }
      res.json({ token: signToken(user), user: publicUser(user) });
    } catch (err) {
      console.error('login failed:', err.message);
      res.status(500).json({ error: 'Login failed' });
    }
  });

  // ---- who am I ------------------------------------------------------------
  router.get('/me', requireAuth, async (req, res) => {
    try {
      const user = await store.findUserByEmail(req.user.email);
      if (!user) return res.status(404).json({ error: 'User not found' });
      res.json(publicUser(user));
    } catch (err) {
      res.status(500).json({ error: 'Could not load the profile' });
    }
  });

  return { router, signToken, publicUser, TOKEN_HOURS };
}

/** Express middleware: fills req.user when a valid token is present, but never blocks. */
function optionalAuth(req, res, next) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (token) {
    try { req.user = jwt.verify(token, process.env.JWT_SECRET); } catch { /* anonymous */ }
  }
  next();
}

/** Express middleware: requires "Authorization: Bearer <token>". */
function requireAuth(req, res, next) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Login required' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Session expired, please log in again' });
  }
}

/** Creates the first admin automatically on boot (idempotent). */
async function ensureSeedAdmin(store) {
  if (!process.env.JWT_SECRET) {
    throw new Error('JWT_SECRET is not set - add it to .env before starting the server.');
  }
  if ((await store.countUsers()) > 0) return null;
  const email = (process.env.ADMIN_EMAIL || 'admin@medibot.local').toLowerCase();
  const password = process.env.ADMIN_PASSWORD || 'medibot-admin';
  const password_hash = await bcrypt.hash(password, 10);
  const user = await store.createUser({ email, password_hash, name: 'Clinic Admin', role: 'admin' });
  return user;
}

module.exports = { createAuth, requireAuth, optionalAuth, ensureSeedAdmin };
