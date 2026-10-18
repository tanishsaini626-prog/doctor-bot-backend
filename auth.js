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

  // ---- login rate limiting (simple in-memory leaky-bucket) -----------------
  // Protects /api/auth/login and /api/auth/register from brute-force guessing.
  // 15 attempts per rolling 60 seconds per IP; hard fail after that.
  const LOGIN_RATE_LIMIT = { max: 15, windowMs: 60_000, ipStore: new Map() };

  function checkRateLimit(ip) {
    const now = Date.now();
    const entry = LOGIN_RATE_LIMIT.ipStore.get(ip);
    if (!entry) {
      LOGIN_RATE_LIMIT.ipStore.set(ip, { count: 1, reset: now + LOGIN_RATE_LIMIT.windowMs });
      return true;
    }
    if (entry.count >= LOGIN_RATE_LIMIT.max) {
      // window already expired?
      if (now >= entry.reset) {
        entry.count = 1;
        entry.reset = now + LOGIN_RATE_LIMIT.windowMs;
        return true;
      }
      return false;
    }
    entry.count += 1;
    return true;
  }

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

  // ---- first-run hint -----------------------------------------------------
  // Public, read-only. Tells the login page which account exists and whether
  // an admin password has been configured. Once you set your own
  // ADMIN_PASSWORD this reports first_run:false.
  router.get('/auth/bootstrap', async (req, res) => {
    const fallback = { first_run: false, admin_email: null };
    try {
      const email = (process.env.ADMIN_EMAIL || 'admin@medibot.local').toLowerCase();
      const admin = await store.findUserByEmail(email);
      const firstRun = !!(admin && admin.role === 'admin');
      res.json({
        first_run: firstRun,
        admin_email: firstRun ? admin.email : null,
      });
    } catch (err) {
      res.json(fallback);
    }
  });

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
      if (!checkRateLimit(req.ip)) {
        return res.status(429).json({ error: 'Too many requests. Please wait a minute before trying again.' });
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
    const ip = req.ip;
    if (!checkRateLimit(ip)) {
      return res.status(429).json({ error: 'Too many requests. Please wait a minute before trying again.' });
    }
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

/**
 * Creates the first admin automatically on boot (idempotent).
 * - If this is the very first user, they are promoted to admin with the
 *   password from ADMIN_PASSWORD (or a throw-away guest token if unset).
 * - If a previous admin already exists and ADMIN_PASSWORD was set, the stored
 *   password is rotated to the new ADMIN_PASSWORD on restart.
 */
async function ensureSeedAdmin(store) {
  if (!process.env.JWT_SECRET) {
    throw new Error('JWT_SECRET is not set - add it to .env before starting the server.');
  }
  const email = (process.env.ADMIN_EMAIL || 'admin@medibot.local').toLowerCase();
  const password = process.env.ADMIN_PASSWORD || null;

  const existing = await store.findUserByEmail(email);
  if (!existing) {
    // never hijack an install that already has users
    if ((await store.countUsers()) > 0) return null;
    const password_hash = password
      ? await bcrypt.hash(password, 10)
      : null; // no password configured; admin depends on external auth later
    return store.createUser({ email, password_hash, name: 'Clinic Admin', role: 'admin' });
  }

  // The account exists. If a new ADMIN_PASSWORD was configured, rotate the stored
  // hash on restart (so the README promise "change ADMIN_PASSWORD and restart"
  // really works). If ADMIN_PASSWORD is unset, leave the existing password alone.
  if (password !== null && existing.password_hash !== null) {
    await store.updateUserPassword(existing._id, await bcrypt.hash(password, 10));
    return Object.assign({}, existing, { password_updated: true });
  }
  return null;
}
// ---- requireAuth ----------------------------------------------------------
// Middleware: extracts Bearer JWT from Authorization header, verifies it,
// and attaches { sub, email, role, clinic } to req.user. Fails closed (401).
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const m = header.match(/^Bearer\s+(\S+)$/i);
  if (!m) return res.status(401).json({ error: 'Authentication required' });
  try {
    const payload = jwt.verify(m[1], process.env.JWT_SECRET);
    req.user = {
      sub: payload.sub,
      email: payload.email,
      role: payload.role,
      clinic: payload.clinic || null,
    };
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ---- optionalAuth ---------------------------------------------------------
// Same as requireAuth but does not fail if no token is present. Sets req.user
// when a valid token is provided; otherwise req.user stays undefined.
function optionalAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const m = header.match(/^Bearer\s+(\S+)$/i);
  if (!m) return next();
  try {
    const payload = jwt.verify(m[1], process.env.JWT_SECRET);
    req.user = {
      sub: payload.sub,
      email: payload.email,
      role: payload.role,
      clinic: payload.clinic || null,
    };
  } catch {
    // ignore invalid tokens in optional mode
  }
  next();
}

module.exports = { createAuth, requireAuth, optionalAuth, ensureSeedAdmin };



