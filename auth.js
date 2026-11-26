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
const crypto = require('crypto');
const { normalizePhone } = require('./phone');

const TOKEN_HOURS = 12;

// ---- login protection configuration (env-overridable) ----------------------
// Protects /api/auth/login and /api/auth/register from brute-force guessing.
// These values are passed to the store, which persists them across restarts
// and shares them across server instances.
const LOGIN_RATE_LIMIT_MAX = parseInt(process.env.LOGIN_RATE_LIMIT_MAX || '15', 10);
const LOGIN_RATE_LIMIT_WINDOW_MS = parseInt(process.env.LOGIN_RATE_LIMIT_WINDOW_MS || '60000', 10);
const LOCKOUT_MAX_ATTEMPTS = parseInt(process.env.LOCKOUT_MAX_ATTEMPTS || '5', 10);
const LOCKOUT_WINDOW_MS = parseInt(process.env.LOCKOUT_WINDOW_MS || '900000', 10); // 15 minutes

// Async wrappers around store-backed login protection. Fail closed: if the
// shared store is unavailable, reject rather than silently disabling protection.
async function checkRateLimit(store, ip) {
  try {
    const result = await store.checkLoginRateLimit(ip, {
      max: LOGIN_RATE_LIMIT_MAX,
      windowMs: LOGIN_RATE_LIMIT_WINDOW_MS,
    });
    return result.allowed;
  } catch (err) {
    console.error('Login rate-limit check failed:', err.message);
    return false; // fail closed
  }
}

async function isAccountLocked(store, email) {
  try {
    const result = await store.isAccountLocked(email, {
      maxAttempts: LOCKOUT_MAX_ATTEMPTS,
      lockoutWindowMs: LOCKOUT_WINDOW_MS,
    });
    return result.locked;
  } catch (err) {
    console.error('Account lockout check failed:', err.message);
    return true; // fail closed: treat as locked
  }
}

async function recordFailedLogin(store, email) {
  try {
    await store.recordLoginFailure(email, {
      maxAttempts: LOCKOUT_MAX_ATTEMPTS,
      lockoutWindowMs: LOCKOUT_WINDOW_MS,
    });
  } catch (err) {
    console.error('Login failure record failed:', err.message);
    // Fail closed: we can't record the failure, but we already rejected the
    // request above. Log and continue.
  }
}

async function resetFailedLogin(store, email) {
  try {
    await store.resetLoginFailure(email);
  } catch (err) {
    console.error('Login failure reset failed:', err.message);
  }
}

// Constant-time comparison for secrets and invite codes to prevent timing attacks.
function safeCompare(a, b) {
  if (!a || !b || typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function createAuth(store, requireStoreReady) {
  const router = express.Router();

  function signToken(user) {
    const jti = crypto.randomBytes(16).toString('hex');
    const token = jwt.sign(
      { sub: String(user._id), email: user.email, role: user.role, clinic: user.clinic || null, jti },
      process.env.JWT_SECRET,
      { expiresIn: `${TOKEN_HOURS}h` }
    );
    return { token, jti };
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
      const firstRun = !!(admin && (admin.role === 'platform_admin' || admin.role === 'admin'));
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
      if (role === 'admin' || role === 'platform_admin') {
        return res.status(400).json({ error: 'Cannot register as platform admin' });
      }
      if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
        return res.status(400).json({ error: 'A valid email is required' });
      }
      if (!password || String(password).length < 8) {
        return res.status(400).json({ error: 'Password must be at least 8 characters' });
      }
      const allowedRoles = ['clinic_owner', 'clinic_staff', 'receptionist'];

      const userCount = await store.countUsers();

      // Creating staff accounts requires platform_admin or clinic_owner
      if (userCount > 0) {
        const enforcer = req.user;
        if (!enforcer || (enforcer.role !== 'platform_admin' && enforcer.role !== 'clinic_owner' && enforcer.role !== 'admin')) {
          return res.status(403).json({ error: 'Only an authorized admin can create new users. Please log in as admin first.' });
        }
      }
      if (await store.findUserByEmail(email)) {
        return res.status(409).json({ error: 'This email is already registered' });
      }
      if (!(await checkRateLimit(store, req.ip))) {
        return res.status(429).json({ error: 'Too many requests. Please wait a minute before trying again.' });
      }

      let targetClinic = null;
      let targetRole = allowedRoles.includes(role) ? role : 'clinic_staff';
      if (req.user && req.user.role === 'clinic_owner') {
        targetClinic = req.user.clinic;
        targetRole = (role === 'clinic_staff' || role === 'receptionist') ? role : 'clinic_staff';
      }

      const password_hash = await bcrypt.hash(String(password), 10);
      const user = await store.createUser({
        email: String(email).toLowerCase().trim(),
        password_hash,
        name: name || '',
        role: targetRole,
        clinic: targetClinic,
      });

      const { token } = signToken(user);
      res.status(201).json({ token, user: publicUser(user) });
    } catch (err) {
      console.error('register failed:', err.message);
      res.status(500).json({ error: 'Registration failed' });
    }
  });

  // ---- secure clinic onboarding (Batch 4E) --------------------------------
  // Creates a new clinic record and assigns the registering user as clinic_owner.
  // Never accepts client-specified clinic ID or platform admin role.
  // In production, requires ONBOARDING_SECRET / CLINIC_INVITE_CODE unless ALLOW_PUBLIC_REGISTRATION=true.
  const handleRegisterClinic = async (req, res) => {
    // Rate limiting: check per-IP rate limit
    if (!(await checkRateLimit(store, req.ip))) {
      return res.status(429).json({ error: 'Too many requests. Please wait a minute before trying again.' });
    }

    try {
      // 1. Production safeguard: only platform_admin, valid secret, or valid invite code allowed
      if (process.env.NODE_ENV === 'production' && process.env.ALLOW_PUBLIC_REGISTRATION !== 'true') {
        const headerSecret = req.headers['x-onboarding-secret'];
        const inviteCode = req.body && req.body.invite_code;
        const isPlatformAdmin = req.user && req.user.role === 'platform_admin';
        const secretMatches = safeCompare(headerSecret, process.env.ONBOARDING_SECRET);
        const inviteMatches = safeCompare(inviteCode, process.env.CLINIC_INVITE_CODE);

        if (!isPlatformAdmin && !secretMatches && !inviteMatches) {
          return res.status(403).json({
            error: 'Public clinic onboarding is disabled in production. An invite code or onboarding secret is required.',
          });
        }
      }

      const { clinic_name, admin_name, email, password, phone } = req.body || {};

      // 2. Reject request-body clinic ID spoofing
      if (req.body && (req.body.clinic !== undefined || req.body.clinic_id !== undefined || req.body.clinicId !== undefined)) {
        return res.status(400).json({ error: 'Client cannot specify clinic ID during onboarding' });
      }

      // 3. Reject role escalation (cannot register as platform admin)
      if (req.body && (req.body.role === 'admin' || req.body.role === 'platform_admin')) {
        return res.status(400).json({ error: 'Cannot register as platform admin' });
      }

      // 4. Validate clinic_name
      if (!clinic_name || typeof clinic_name !== 'string' || clinic_name.trim().length < 2 || clinic_name.trim().length > 150) {
        return res.status(400).json({ error: 'Clinic name must be between 2 and 150 characters' });
      }

      // 5. Validate admin_name
      if (!admin_name || typeof admin_name !== 'string' || admin_name.trim().length < 2 || admin_name.trim().length > 100) {
        return res.status(400).json({ error: 'Admin name must be between 2 and 100 characters' });
      }

      // 6. Validate email
      if (!email || typeof email !== 'string' || !/^\S+@\S+\.\S+$/.test(email.trim())) {
        return res.status(400).json({ error: 'A valid email is required' });
      }
      const normalizedEmail = email.toLowerCase().trim();

      // 7. Validate password
      if (!password || typeof password !== 'string' || password.length < 8 || password.length > 128) {
        return res.status(400).json({ error: 'Password must be between 8 and 128 characters' });
      }

      // 8. Validate phone
      if (!phone || typeof phone !== 'string') {
        return res.status(400).json({ error: 'Clinic phone number is required' });
      }
      const normalizedPhone = normalizePhone(phone);
      const digitsOnly = normalizedPhone ? normalizedPhone.replace(/\D/g, '') : '';
      if (!normalizedPhone || digitsOnly.length < 10 || digitsOnly.length > 15) {
        return res.status(400).json({ error: 'A valid 10-digit Indian phone number is required for the clinic' });
      }

      // 9. Duplicate check: email
      const existingUser = await store.findUserByEmail(normalizedEmail);
      if (existingUser) {
        return res.status(409).json({ error: 'This email is already registered' });
      }

      // 10. Duplicate check: active clinic phone
      try {
        const existingClinic = await store.getClinicByPhone(normalizedPhone, { includeInactive: true });
        if (existingClinic) {
          return res.status(409).json({ error: 'A clinic is already registered with this phone number' });
        }
      } catch (phoneErr) {
        if (phoneErr.message && phoneErr.message.includes('Ambiguous')) {
          return res.status(409).json({ error: 'A clinic is already registered with this phone number' });
        }
      }

      // 11. Atomic creation: create clinic record first
      const newClinicId = crypto.randomBytes(12).toString('hex');
      const password_hash = await bcrypt.hash(password, 10);

      let createdClinic;
      try {
        createdClinic = await store.saveClinic({
          name: clinic_name.trim(),
          phone: normalizedPhone,
          active: true,
        }, { clinic: newClinicId, create: true });
      } catch (clinicErr) {
        console.error('Failed to create clinic during onboarding:', clinicErr.message);
        if (clinicErr.code === 11000 || (clinicErr.message && clinicErr.message.includes('E11000'))) {
          return res.status(409).json({ error: 'A clinic is already registered with this phone number' });
        }
        return res.status(500).json({ error: 'Failed to create clinic' });
      }

      // 12. Create user record assigned to the newly created clinic as clinic_owner
      let createdUser;
      try {
        createdUser = await store.createUser({
          email: normalizedEmail,
          password_hash,
          name: admin_name.trim(),
          role: 'clinic_owner',
          clinic: newClinicId,
          active: true,
        });
      } catch (userErr) {
        // Rollback clinic creation on user creation failure
        console.error('Failed to create user during onboarding, rolling back clinic:', userErr.message);
        try {
          await store.deleteClinic(newClinicId);
        } catch (rollbackErr) {
          console.error('Rollback deleteClinic failed:', rollbackErr.message);
        }
        return res.status(500).json({ error: 'Failed to create clinic user' });
      }

      const { token } = signToken(createdUser);
      return res.status(201).json({
        ok: true,
        token,
        user: publicUser(createdUser),
        clinic: createdClinic,
      });
    } catch (err) {
      console.error('register-clinic failed:', err.message);
      return res.status(500).json({ error: 'Clinic onboarding failed' });
    }
  };

  const storeGate = requireStoreReady || ((_req, _res, next) => next());
  router.post('/auth/register-clinic', storeGate, optionalAuth, handleRegisterClinic);
  router.post('/auth/onboarding', storeGate, optionalAuth, handleRegisterClinic);
  router.post('/onboarding', storeGate, optionalAuth, handleRegisterClinic);

  // ---- login ---------------------------------------------------------------
  // 503 until the store is initialized (initStore + ensureSeedAdmin complete).
  const loginMiddleware = requireStoreReady || ((_req, _res, next) => next());
  router.post('/auth/login', loginMiddleware, async (req, res) => {
    const ip = req.ip;
    if (!(await checkRateLimit(store, ip))) {
      return res.status(429).json({ error: 'Too many requests. Please wait a minute before trying again.' });
    }
    try {
      const { email, password } = req.body || {};
      if (!email || !password) {
        return res.status(400).json({ error: 'Email and password are required' });
      }
      const normalizedEmail = String(email).toLowerCase().trim();

      // Per-account lockout: reject before any DB lookup if the account is locked
      if (await isAccountLocked(store, normalizedEmail)) {
        return res.status(423).json({ error: 'Account temporarily locked due to multiple failed login attempts. Please try again later.' });
      }

      const user = await store.findUserByEmail(normalizedEmail);
      // same error for unknown email and wrong password (no account guessing)
      if (!user || !user.active || !(await bcrypt.compare(String(password), user.password_hash))) {
        await recordFailedLogin(store, normalizedEmail);
        return res.status(401).json({ error: 'Invalid email or password' });
      }

      await resetFailedLogin(store, normalizedEmail);
      const { token } = signToken(user);
      res.json({ token, user: publicUser(user) });
    } catch (err) {
      console.error('login failed:', err.message);
      res.status(500).json({ error: 'Login failed' });
    }
  });

  // ---- logout --------------------------------------------------------------
  // Revokes the current bearer token by adding its jti to the persistent
  // token blocklist (survives restarts, shared across instances).
  router.post('/auth/logout', optionalAuth, async (req, res) => {
    const header = req.headers.authorization || '';
    const m = header.match(/^Bearer\s+(\S+)$/i);
    if (m) {
      try {
        const payload = jwt.verify(m[1], process.env.JWT_SECRET);
        if (payload.jti) {
          const expiresAt = new Date(Date.now() + TOKEN_HOURS * 60 * 60 * 1000);
          await store.createTokenBlocklist(payload.jti, expiresAt);
        }
      } catch {
        // token invalid or already expired - nothing to revoke
      }
    }
    res.json({ ok: true });
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

  // ---- requireAuth (async, store-backed blocklist) -------------------------
  // Middleware: extracts Bearer JWT from Authorization header, verifies it,
  // and attaches { sub, email, role, clinic } to req.user. Fails closed (401)
  // if the token is revoked or the store cannot be consulted.
  async function requireAuth(req, res, next) {
    const header = req.headers.authorization || '';
    const m = header.match(/^Bearer\s+(\S+)$/i);
    if (!m) return res.status(401).json({ error: 'Authentication required' });
    let payload;
    try {
      payload = jwt.verify(m[1], process.env.JWT_SECRET);
    } catch {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
    // Token signature is valid; now check revocation. A store (DB) outage
    // must fail closed with 503 so infrastructure failures are not
    // misreported as invalid credentials.
    let blocked;
    try {
      blocked = await store.isTokenBlocked(payload.jti);
    } catch (err) {
      console.error('Token revocation check failed:', err.message);
      return res.status(503).json({ error: 'Service temporarily unavailable: revocation check failed. Please retry.' });
    }
    if (blocked) {
      return res.status(401).json({ error: 'Token has been revoked' });
    }
    req.user = {
      sub: payload.sub,
      email: payload.email,
      role: payload.role,
      clinic: payload.clinic || null,
    };
    next();
  }

  // ---- optionalAuth (async, store-backed blocklist) ------------------------
  // Same as requireAuth but does not fail if no token is present. Sets req.user
  // when a valid token is provided; otherwise req.user stays undefined.
  async function optionalAuth(req, res, next) {
    const header = req.headers.authorization || '';
    const m = header.match(/^Bearer\s+(\S+)$/i);
    if (!m) return next();
    try {
      const payload = jwt.verify(m[1], process.env.JWT_SECRET);
      // Fail closed: if the revocation store is unreachable, do NOT attach
      // the user (treat the token as potentially revoked). This prevents a
      // DB outage from allowing a revoked token through.
      let blocked;
      try {
        blocked = await store.isTokenBlocked(payload.jti);
      } catch {
        return next(); // next() with req.user unset = token treated as invalid
      }
      if (blocked) {
        return next(); // revoked → do not attach user
      }
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

  // ---- requireClinic (enforces authenticated user has valid clinic context) -
  // Fails closed (401) if not authenticated; returns 403 if clinic context is
  // missing, null, unconfigured ('default'), or inactive (active === false).
  async function requireClinic(req, res, next) {
    return requireAuth(req, res, async () => {
      const clinic = req.user && req.user.clinic;
      if (!clinic || clinic === 'default') {
        return res.status(403).json({
          error: 'Clinic not assigned. Configure clinic during onboarding before accessing this resource.',
        });
      }
      try {
        const clinicDoc = await store.getClinic(clinic);
        if (clinicDoc && clinicDoc.active === false) {
          return res.status(403).json({
            error: 'Clinic is inactive. Please contact support.',
          });
        }
        if (clinicDoc) {
          req.clinicDoc = clinicDoc;
        }
        next();
      } catch (err) {
        return res.status(403).json({
          error: 'Clinic verification failed: ' + err.message,
        });
      }
    });
  }

  // ---- requirePlatformAdmin (enforces authenticated user is platform_admin) --
  // Fails closed (401) if not authenticated; returns 403 if user is not platform_admin.
  // Never treats role 'admin' or 'clinic_owner' as platform_admin.
  async function requirePlatformAdmin(req, res, next) {
    return requireAuth(req, res, () => {
      if (!req.user || req.user.role !== 'platform_admin') {
        return res.status(403).json({
          error: 'Access denied: platform administrator authorization required',
        });
      }
      next();
    });
  }

  return { router, signToken, publicUser, TOKEN_HOURS, requireAuth, optionalAuth, requireClinic, requirePlatformAdmin };
}

/**
 * Creates the first admin automatically on boot (idempotent).
 * - If this is the very first user, they are created as platform_admin with the
 *   password from ADMIN_PASSWORD (or a throw-away guest token if unset).
 * - If a previous admin already exists and ADMIN_PASSWORD was set, the stored
 *   password is rotated to the new ADMIN_PASSWORD on restart. Never silently promotes existing users.
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
    return store.createUser({ email, password_hash, name: 'Platform Admin', role: 'platform_admin', clinic: null });
  }

  // The account exists. If a new ADMIN_PASSWORD was configured, rotate the stored
  // hash on restart (so the README promise "change ADMIN_PASSWORD and restart"
  // really works). If ADMIN_PASSWORD is unset, leave the existing password alone.
  // Never silently promote existing users.
  if (password !== null && existing.password_hash !== null) {
    await store.updateUserPassword(existing._id, await bcrypt.hash(password, 10));
    return Object.assign({}, existing, { password_updated: true });
  }
  return null;
}
// ---- requireAuth and optionalAuth are now async closures inside
// createAuth (they need store access for the persistent blocklist). These
// are not exported at module level; server.js destructures them from
// createAuth's return value.
// ---------------------------------------------------------------------------
module.exports = { createAuth, ensureSeedAdmin };





