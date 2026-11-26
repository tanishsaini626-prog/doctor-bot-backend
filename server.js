'use strict';
/* ==========================================================================
 * MediBot backend - Twilio voice webhook + REST API for the React dashboard
 * --------------------------------------------------------------------------
 *   GET  /                         health page
 *   GET  /webhook/doctor-bot       Twilio calls this when the phone rings
 *   POST /webhook/doctor-bot       every speech turn
 *   POST /webhook/status           Twilio status callback (abandoned calls)
 *   GET  /api/appointments         list (filters: ?status=&q=&date=&limit=)
 *   GET  /api/appointments/:id     one appointment
 *   PATCH /api/appointments/:id    { "status": "Completed" | "Cancelled" }
 *   GET  /api/stats                dashboard counters
 *
 * Storage: STORE=auto (default) uses MongoDB when MONGODB_URI connects, and
 * falls back to an in-memory store otherwise, so the server always runs.
 *   STORE=mongo   -> require MongoDB, exit if it cannot connect
 *   STORE=memory  -> always in-memory (no database needed)
 * ========================================================================== */

// ---- 1. environment ------------------------------------------------------
// dotenv reads every listed file, so ".env" OR "doctor.env" both work here.
require('dotenv').config({ path: ['.env', 'doctor.env', '.env.local'] });

const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const path = require('path');

const BotEngine = require('./bot-engine');
const { createConversation } = require('./conversation');
const { createMongoStore, ensureIndexes } = require('./store-mongo');
const { createMemoryStore } = require('./store-memory');
const { createFileStore } = require('./store-file');
const { createAuth, ensureSeedAdmin } = require('./auth');
const { requireTwilioSignature } = require('./twilio-signature');
const { maskPhone, normalizePhone } = require('./phone');
const {
  getBillingMonth,
  evaluateSubscription,
  checkQuota,
  isQuotaEnforced,
  resolvePlan,
  createSubscriptionMiddleware,
} = require('./subscription');
const { createPaymentService } = require('./payment-service');
const { createBrowserReceptionist } = require('./browser-receptionist');
const { createLocalVoiceEngine } = require('./voice-local');

function parseTrustProxy(val) {
  if (val === undefined || val === null) return 1;
  if (typeof val === 'boolean') return val;
  const s = String(val).trim();
  if (s === '') return 1;
  if (s.toLowerCase() === 'true') return true;
  if (s.toLowerCase() === 'false') return false;
  if (/^-?\d+$/.test(s)) {
    const n = parseInt(s, 10);
    if (n < 0 || n > 100) throw new Error('Invalid TRUST_PROXY: hop count must be between 0 and 100');
    return n;
  }
  if (['loopback', 'linklocal', 'uniquelocal'].includes(s.toLowerCase())) {
    return s.toLowerCase();
  }
  const parts = s.split(',').map(p => p.trim()).filter(Boolean);
  const IP_OR_CIDR = /^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$/;
  for (const part of parts) {
    if (!IP_OR_CIDR.test(part) && !['loopback', 'linklocal', 'uniquelocal'].includes(part.toLowerCase())) {
      throw new Error(`Invalid TRUST_PROXY entry: ${part}`);
    }
  }
  return parts.length === 1 ? parts[0] : parts;
}

// --- configuration validation (fail fast on production-required secrets) ---
function assertEnv(name) {
  const value = process.env[name];
  if (value === undefined || String(value).trim() === '') {
    console.error('FATAL: Missing required environment variable: ' + name);
    process.exit(1);
  }
  return value;
}

const PORT = assertEnv('PORT') || 5000;
const MONGODB_URI = process.env.MONGODB_URI || '';   // optional; required only when STORE=mongo
const MAX_PER_SLOT = parseInt(process.env.MAX_PER_SLOT || '0', 10);   // 0 = unlimited
const STORE_MODE = (process.env.STORE || 'auto').toLowerCase();       // auto | mongo | file | memory
const NODE_ENV = process.env.NODE_ENV || 'development';
// Where the file-backed store keeps its JSON (ignored by git via .data/).
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, '.data', 'store.json');

// ---- production readiness checks ------------------------------------------
// In production, JWT_SECRET must be strong enough to resist brute-forcing.
// A short, guessable, or default secret would let attackers forge dashboard
// tokens. We check length, minimum entropy, and reject known defaults.
if (NODE_ENV === 'production') {
  const jwtSecret = process.env.JWT_SECRET || '';
  if (!jwtSecret) {
    console.error('FATAL: JWT_SECRET is required in production (NODE_ENV=production).');
    process.exit(1);
  }
  if (jwtSecret.length < 32) {
    console.error('FATAL: JWT_SECRET must be at least 32 characters in production (got ' + jwtSecret.length + ').');
    process.exit(1);
  }
  // Reject known weak defaults that attackers will try first.
  const WEAK_DEFAULTS = [
    'secret', 'password', 'changeme', 'default', 'changemeplease',
    'jwtsecret', 'jwt_secret', 'mysecretkey', 'supersecret', 'medibot-secret',
    'test-secret', 'development-secret', 'production-secret',
  ];
  const lower = jwtSecret.toLowerCase();
  if (WEAK_DEFAULTS.includes(lower)) {
    console.error('FATAL: JWT_SECRET is a known weak default. Set a strong, unique value in your secret manager.');
    process.exit(1);
  }
  // Reject secrets with less than ~28 bits of entropy: all same char,
  // strictly sequential runs (e.g. "aaaa...", "abcd...", "1234..."), or
  // keyboard walks (e.g. "qwerty...", "asdfg...").
  const allSame = /^(.)\1{31,}$/.test(jwtSecret);
  const seqUp = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const seqDown = seqUp.split('').reverse().join('');
  let sequential = false;
  for (let i = 0; i <= seqUp.length - 32; i++) {
    if (jwtSecret.includes(seqUp.slice(i, i + 32)) || jwtSecret.includes(seqDown.slice(i, i + 32))) {
      sequential = true;
      break;
    }
  }
  const keyboardWalks = ['qwertyuiopasdfghjklzxcvbnm', 'mnbvcxzlkjhgfdsapoiuytrewq'];
  let keyboardWalk = false;
  for (const walk of keyboardWalks) {
    if (jwtSecret.toLowerCase().includes(walk.slice(0, 32))) {
      keyboardWalk = true;
      break;
    }
  }
  if (allSame || sequential || keyboardWalk) {
    console.error('FATAL: JWT_SECRET has insufficient entropy (repeated, sequential, or keyboard-walk pattern). Use a cryptographically random value.');
    process.exit(1);
  }
  console.log('🔐 Production mode: JWT secret strength OK (' + jwtSecret.length + ' chars).');
  if (String(process.env.PAYMENT_PROVIDER || '').toLowerCase().trim() === 'mock') {
    console.error('FATAL: PAYMENT_PROVIDER=mock is not permitted in production (NODE_ENV=production).');
    process.exit(1);
  }
}

const app = express();
app.set('trust proxy', 1);                       // correct https:// behind ngrok / Render
const CORS_ORIGIN_RAW = process.env.CORS_ORIGIN || '';
const CORS_ORIGINS = CORS_ORIGIN_RAW.split(',').map(s => s.trim()).filter(Boolean);

app.use(cors({
  origin: CORS_ORIGINS.length === 0
    ? false
    : CORS_ORIGINS.includes('*')
      ? true
      : (origin) => origin && CORS_ORIGINS.includes(origin),
  optionsSuccessStatus: 204,
}));
app.use(express.urlencoded({ extended: false }));
const defaultJsonParser = express.json({
  limit: process.env.REQUEST_SIZE_LIMIT || '100kb',
  verify: (req, _res, buf) => {
    req.rawBody = buf.toString('utf8');
  },
});
const audioJsonParser = express.json({ limit: '5mb' });
app.use((req, res, next) => {
  if (req.path && /^\/api\/receptionist\/sessions\/[^/]+\/audio$/.test(req.path)) {
    return audioJsonParser(req, res, next);
  }
  return defaultJsonParser(req, res, next);
});

// ---- 3. security middleware -------------------------------------------------
// Helmet sets sensible security headers (CSP, HSTS, frame-ancestors, etc.)
// and is a baseline for production.
// ---- 3. security -----------------------------------------------------------
const helmet = require('helmet');
app.use(helmet());

// Set strict security headers; disable the cross-origin block if you add
// a trusted frontend origin via CORS_ORIGIN.
app.use((req, res, next) => {
  // [CORS_ORIGIN] is enforced via the cors() middleware above.
  next();
});

// ---- 4. storage ----------------------------------------------------------
mongoose.set('bufferTimeoutMS', 3000);           // fail fast, never freeze a live call

let activeStore = createMemoryStore();
let storeKind = 'memory';
const DELEGATED = [
  'getSession', 'saveSession', 'clearSession', 'findDuplicate', 'countBooked',
  'createAppointment', 'createAppointmentIfAvailable', 'listAppointments', 'getAppointment', 'updateAppointmentStatus', 'deleteAppointment', 'stats',
  'countUsers', 'findUserByEmail', 'createUser', 'updateUserPassword', 'logCallTurn', 'listCallLogs',
  'listDoctors', 'getDoctor', 'createDoctor', 'updateDoctor', 'deleteDoctor',
  'getClinic', 'saveClinic', 'deleteClinic', 'listClinics',
  'resolveClinicByPhone', 'getClinicByPhone',
  'createLead', 'listLeads', 'listPlatformLeads',
  'createTokenBlocklist', 'isTokenBlocked', 'clearExpiredTokenBlocklist',
  'checkLoginRateLimit', 'isAccountLocked', 'recordLoginFailure', 'resetLoginFailure',
  'createSubscriptionPlan', 'getSubscriptionPlan', 'listSubscriptionPlans', 'updateSubscriptionPlan',
  'getClinicSubscription', 'updateClinicSubscription',
  'getOrCreateClinicUsage', 'recordClinicUsage', 'getClinicUsage', 'listClinicUsage',
];
const store = new Proxy({}, {
  get(target, prop) {
    if (prop in target) return target[prop];
    if (typeof activeStore[prop] === 'function') {
      return (...args) => activeStore[prop](...args);
    }
    return activeStore[prop];
  },
  has(target, prop) {
    return (prop in target) || (prop in activeStore);
  },
});
for (const method of DELEGATED) {
  store[method] = (...args) => activeStore[method](...args);
}

// ---- store-readiness gate --------------------------------------------------
// login/appointment endpoints return 503 until initStore() + ensureSeedAdmin()
// have completed. Prevents requests from hitting a store that isn't ready yet.
let storeInitialized = false;
const storeReadyPromise = (async () => {
  await initStore();
  // Ensure indexes before accepting traffic: catches duplicate Confirmed
  // appointments that would block the unique partial index, and creates the
  // token blocklist TTL index. Fails fast so a human can resolve conflicts.
  if (storeKind === 'mongo') {
    try {
      await ensureIndexes();
      console.log('📇 MongoDB indexes verified (unique partial on appointments, TTL on token blocklist).');
    } catch (err) {
      console.error('❌ Index check failed:', err.message);
      if (STORE_MODE === 'mongo' || NODE_ENV === 'production') {
        console.error('   STORE=mongo or production was requested, so the server will not start.');
        process.exit(1);
      }
      // For auto/file mode we still continue (index is best-effort on fallback stores).
    }
  }
  try {
    const seeded = await ensureSeedAdmin(store);
    if (seeded && seeded.password_updated) {
      console.log('🔑 Admin password updated from ADMIN_PASSWORD in .env for', seeded.email);
    } else if (seeded) {
      console.log('👤 Created the first admin account:', seeded.email);
      if (!process.env.ADMIN_PASSWORD) {
        console.log('   Default password: medibot-admin  ->  change it by setting ADMIN_PASSWORD in .env and restarting.');
      }
    }
  } catch (err) {
    console.error('⚠️  Could not prepare the admin account:', err.message);
  }
  storeInitialized = true;
})();

function requireStoreReady(req, res, next) {
  const isReady = app.locals && typeof app.locals.storeReady === 'function' ? app.locals.storeReady() : storeInitialized;
  if (!isReady) {
    return res.status(503).json({
      error: 'Service temporarily unavailable: store is initializing. Please retry.'
    });
  }
  next();
}

async function initStore() {
  if (NODE_ENV === 'production') {
    if (STORE_MODE === 'memory' || STORE_MODE === 'file') {
      console.error('FATAL: STORE=' + STORE_MODE + ' is not permitted in production (NODE_ENV=production). Production requires MongoDB.');
      process.exit(1);
    }
    if (!MONGODB_URI) {
      console.error('FATAL: MONGODB_URI is required in production (NODE_ENV=production). Set it in your environment/secret manager.');
      process.exit(1);
    }
  }

  // STORE=mongo must never fall back silently to file/memory.
  if (STORE_MODE === 'mongo' && !MONGODB_URI) {
    console.error('FATAL: STORE=mongo requires MONGODB_URI; set it in your environment/secret manager and restart.');
    process.exit(1);
  }
  if (STORE_MODE === 'memory') {
    console.log('🧠 STORE=memory - using the in-memory store (data is lost on restart)');
    return;
  }
  if (STORE_MODE === 'file') {
    activeStore = createFileStore(DATA_FILE);
    storeKind = 'file';
    console.log('💾 STORE=file - data persists to ' + DATA_FILE + ' (survives restarts)');
    return;
  }
  if (!MONGODB_URI) {
    activeStore = createFileStore(DATA_FILE);
    storeKind = 'file';
    console.warn('⚠️  MONGODB_URI is not set - using the file-backed store instead (' + DATA_FILE + ').');
    console.warn('    Data survives restarts on this machine. Set MONGODB_URI (free M0 cluster on');
    console.warn('    cloud.mongodb.com) for a shared database, or STORE=memory to opt out of persistence.');
    return;
  }
  try {
    // Mongoose connection lifecycle listeners (P0-3)
    mongoose.connection.on('disconnected', () => {
      console.warn('⚠️  MongoDB disconnected. Database storage is unready.');
    });
    mongoose.connection.on('reconnected', () => {
      console.log('🔄 MongoDB connection re-established.');
    });
    mongoose.connection.on('error', (err) => {
      console.error('❌ MongoDB connection error:', err && err.message ? err.message : err);
    });

    await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
    activeStore = createMongoStore({ maxPerSlot: MAX_PER_SLOT });
    storeKind = 'mongo';
    console.log('✅ Connected to MongoDB - data will persist');

    if (NODE_ENV === 'production') {
      const twilioSigVal = String(process.env.TWILIO_VALIDATE_SIGNATURE || '').toLowerCase();
      if (twilioSigVal === 'false') {
        console.error('FATAL: TWILIO_VALIDATE_SIGNATURE=false is not permitted in production (NODE_ENV=production).');
        process.exit(1);
      }
      const twilioAuthToken = process.env.TWILIO_AUTH_TOKEN || '';
      if (!twilioAuthToken || !String(twilioAuthToken).trim()) {
        console.error('FATAL: TWILIO_AUTH_TOKEN is required in production (NODE_ENV=production).');
        process.exit(1);
      }
      const internalKey = process.env.INTERNAL_SERVICE_KEY || '';
      if (!internalKey || internalKey.length < 32) {
        console.error('FATAL: INTERNAL_SERVICE_KEY must be at least 32 characters in production (got ' + internalKey.length + ').');
        process.exit(1);
      }
    }
  } catch (err) {
    console.error('❌ MongoDB connection failed:', err.message);
    if (STORE_MODE === 'mongo' || NODE_ENV === 'production') {
      console.error('   FATAL: MongoDB connection failed in production / STORE=mongo. Server will not start: ' + err.message);
      process.exit(1);
    }
    activeStore = createFileStore(DATA_FILE);
    storeKind = 'file';
    console.warn('⚠️  Falling back to the file-backed store (' + DATA_FILE + ') - bookings persist on this machine.');
    console.warn('    Fix MONGODB_URI in .env (create a free M0 cluster on cloud.mongodb.com) and restart for a shared DB.');
  }
}

// The voice bot reads the booking back and waits for "haan/sahi" before it
// saves. Set CONFIRM_BEFORE_BOOKING=false in .env to book the instant every
// slot is collected (the old, no-read-back behaviour).
const CONFIRM_BEFORE_BOOKING = String(process.env.CONFIRM_BEFORE_BOOKING || 'true').toLowerCase() !== 'false';

// Doctor availability for the voice flow: the first active doctor's working
// hours + holidays. If the clinic has not added a doctor yet we return null and
// the availability check is skipped, so a fresh install still books normally.
async function doctorProvider() {
  try {
    const doctors = await store.listDoctors();
    const active = (doctors || []).filter(d => d.active !== false);
    return active[0] || null;
  } catch (err) {
    console.error('doctorProvider failed:', err.message);
    return null;
  }
}

const bot = createConversation({
  store,
  maxPerSlot: MAX_PER_SLOT,
  confirmBeforeBooking: CONFIRM_BEFORE_BOOKING,
  doctorProvider,
});
const { router: authRouter, requireAuth, optionalAuth, requireClinic, requirePlatformAdmin } = createAuth(store, requireStoreReady);
const requireActiveSubscription = createSubscriptionMiddleware(store);
const paymentService = createPaymentService(store);
const browserReceptionist = createBrowserReceptionist({ store, maxPerSlot: MAX_PER_SLOT });
const localVoice = createLocalVoiceEngine();

// ---- 2b. admin account ---------------------------------------------------
// JWT_SECRET is required in .env (generate one, never commit it). The first
// admin is created automatically so a fresh install can log in immediately.
// initStore() + ensureSeedAdmin() run via storeReadyPromise (above); once
// storeInitialized is true, login/appointment routes stop returning 503.

// ---- 3. WhatsApp notification to the clinic (optional) -------------------
let twilioClient = null;
let whatsappFrom = '';
let clinicTo = '';
if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
  try {
    twilioClient = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    whatsappFrom = process.env.TWILIO_WHATSAPP_FROM || 'whatsapp:+14155238886';
    clinicTo = process.env.CLINIC_WHATSAPP_TO || '';
  } catch (err) {
    console.error('Twilio client not started:', err.message);
  }
}

async function notifyClinic(appointment) {
  if (!twilioClient || !clinicTo) return { sent: false, reason: 'not_configured' };
  const apptId = appointment && (appointment._id || appointment.id) ? String(appointment._id || appointment.id) : null;
  const apptEventId = apptId ? `whatsapp:appt:${apptId}` : null;

  // Idempotency guard: if this appointment's notification was already dispatched & recorded, skip retry
  if (apptEventId && typeof store.hasUsageEvent === 'function') {
    try {
      if (await store.hasUsageEvent(apptEventId)) {
        return { sent: false, duplicate: true };
      }
    } catch (_) {}
  }

  try {
    const msg = await twilioClient.messages.create({
      from: whatsappFrom,
      to: clinicTo,
      body: bot.whatsappText(appointment),
    });
    // Authoritative event: Track successfully dispatched WhatsApp message with persistent event ID
    if (appointment && appointment.clinic) {
      try {
        const billingMonth = getBillingMonth(new Date());
        const eventId = apptEventId || (msg && msg.sid ? `whatsapp:msg:${String(msg.sid).trim()}` : null);
        await store.recordClinicUsage(
          appointment.clinic,
          billingMonth,
          { whatsapp_count: 1 },
          eventId ? { eventId, eventType: 'whatsapp' } : { eventType: 'whatsapp' }
        );
      } catch (waUsageErr) {
        console.error('WhatsApp usage tracking failed:', waUsageErr.message);
      }
    }
    return { sent: true, sid: msg && msg.sid ? msg.sid : null };
  } catch (err) {
    // Failed messages must NOT count as successful dispatches
    console.error('WhatsApp notification failed:', err.message);   // never break the call
    return { sent: false, error: err.message };
  }
}

// ---- 4. helpers ---------------------------------------------------------
function actionUrl(req) {
  const proto = req.get('x-forwarded-proto') || req.protocol || 'https';
  return `${proto}://${req.get('host')}${req.path}`;
}

function publicUrlFor(req, targetPath) {
  const rawProto = req.get('x-forwarded-proto') || req.protocol || 'https';
  const proto = String(rawProto).split(',')[0].trim() || 'https';
  const rawHost = req.get('x-forwarded-host') || req.get('host') || '';
  const host = String(rawHost).split(',')[0].trim();
  return `${proto}://${host}${targetPath}`;
}

function twiml(res, xml, code = 200) {
  res.status(code).set('Content-Type', 'application/xml').send(xml);
}

// ---- 4b. Twilio signature check (used on all three webhook routes) -------
const twilioSignature = requireTwilioSignature();

// ---- 4c. analytics -------------------------------------------------------
// Computed in JS so it behaves identically on MongoDB and the memory store.
// Clinic-scale data is small; if it grows, move this into an aggregation.
const DAY_COUNT = 14;

function dayKey(value) {
  const d = value ? new Date(value) : null;
  return d && !isNaN(d.getTime()) ? d.toISOString().slice(0, 10) : null;
}

function buildAnalytics(appointments, calls) {
  const today = new Date();
  const days = [];
  for (let i = DAY_COUNT - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    days.push({
      date: key,
      label: d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }),
      calls: 0,
      bookings: 0,
    });
  }
  const byDay = new Map(days.map(d => [d.date, d]));

  for (const call of calls) {
    const bucket = byDay.get(dayKey(call.createdAt));
    if (bucket) bucket.calls += 1;
  }
  for (const appt of appointments) {
    const bucket = byDay.get(dayKey(appt.createdAt));
    if (bucket) bucket.bookings += 1;
  }

  const hours = new Map();
  for (const appt of appointments) {
    const slot = String(appt.time_slot_display || appt.time_slot || '');
    const match = slot.match(/(\d{1,2}):(\d{2})/);
    const label = match
      ? String(parseInt(match[1], 10)).padStart(2, '0') + ':00'
      : (slot.split(' ')[0] || 'Unknown');
    hours.set(label, (hours.get(label) || 0) + 1);
  }

  const reasons = new Map();
  for (const appt of appointments) {
    const reason = (appt.reason || 'Not specified').split(',')[0].trim();
    reasons.set(reason, (reasons.get(reason) || 0) + 1);
  }

  const statuses = new Map();
  for (const appt of appointments) {
    const status = appt.status || 'Confirmed';
    statuses.set(status, (statuses.get(status) || 0) + 1);
  }

  const booked = appointments.filter(a => a.status === 'Confirmed' || a.status === 'Completed').length;

  return {
    totals: {
      appointments: appointments.length,
      calls: calls.length,
      booked,
      emergency: appointments.filter(a => a.status === 'Emergency').length,
      conversion: calls.length ? Math.round((booked / calls.length) * 100) : 0,
    },
    perDay: days,
    hours: [...hours.entries()].map(([hour, count]) => ({ hour, count })).sort((a, b) => a.hour.localeCompare(b.hour)),
    reasons: [...reasons.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count).slice(0, 8),
    statuses: [...statuses.entries()].map(([status, count]) => ({ status, count })).sort((a, b) => b.count - a.count),
  };
}

// ---- 5. routes ----------------------------------------------------------
// Login / register (public)
app.use('/api', authRouter);

app.get('/', (req, res) => {
  res.json({
    service: 'MediBot backend',
    status: 'ok',
    store: storeKind,
    database: storeKind === 'memory' ? 'in-memory (not persistent)' : (storeKind === 'file' ? 'file-backed (persistent on this host)' : (mongoose.connection.readyState === 1 ? 'connected' : 'connecting')),
    signature_validation: String(process.env.TWILIO_VALIDATE_SIGNATURE || '').toLowerCase() === 'true',
    endpoints: ['/webhook/doctor-bot', '/webhook/status', '/api/auth/login', '/api/appointments', '/api/calls', '/api/stats'],
  });
});

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    store: storeKind,
    database: storeKind === 'mongo' ? (mongoose.connection.readyState === 1) : (storeKind !== 'memory'),
    uptime_seconds: Math.round(process.uptime()),
  });
});

app.get('/api/health/ready', (req, res) => {
  const isMongo = storeKind === 'mongo';
  const mongoReady = Boolean(mongoose.connection && mongoose.connection.readyState === 1);
  const isReady = isMongo ? (storeInitialized && mongoReady) : (app.locals && typeof app.locals.storeReady === 'function' ? app.locals.storeReady() : storeInitialized);

  if (!isReady) {
    return res.status(503).json({
      status: 'unready',
      ready: false,
      error: 'Storage backend is not ready',
      store: storeKind,
      database: isMongo ? (mongoReady ? 'connected' : 'disconnected') : 'ready',
    });
  }

  res.status(200).json({
    status: 'ready',
    ready: true,
    store: storeKind,
    database: isMongo ? 'connected' : 'ready',
    uptime_seconds: Math.round(process.uptime()),
  });
});

async function handleIncomingCall(req, res) {
  const callSid = (req.query.CallSid) || (req.body && req.body.CallSid) || (req.body && req.body.call_sid) || '';
  const to = (req.query.To) || (req.body && req.body.To) || (req.body && req.body.to) || '';
  const from = (req.query.From) || (req.body && req.body.From) || (req.body && req.body.from) || '';

  // 1. Resolve clinic by To phone number
  const clinicResult = await store.resolveClinicByPhone(to);
  if (!clinicResult.ok) {
    res.setHeader('x-clinic-resolved', 'false');
    res.setHeader('x-clinic-reject-reason', clinicResult.reason || 'unknown');
    let message = 'क्षमा कीजिए, यह नंबर किसी भी क्लिनिक से जुड़ा नहीं है।';
    if (clinicResult.reason === 'inactive') {
      message = 'क्षमा कीजिए, यह क्लिनिक इस समय सक्रिय नहीं है।';
    } else if (clinicResult.reason === 'ambiguous') {
      message = 'क्षमा कीजिए, यह नंबर एक से अधिक क्लिनिक से जुड़ा हुआ है।';
    }
    return twiml(res, BotEngine.wrapTwiml(BotEngine.say(message) + BotEngine.hangup()));
  }

  const clinic = clinicResult.clinic;
  res.setHeader('x-clinic-resolved', 'true');
  res.setHeader('x-clinic-id', String(clinic._id || clinic.id));

  // 2. Clear previous session for this callSid and save verified session
  const clinicId = clinic._id || clinic.id;
  try {
    if (callSid) {
      await store.saveSession({
        call_sid: String(callSid).trim(),
        clinic: clinicId,
        phone: from,
        to: to,
        verified: true,
        status: 'Incomplete',
        source: (req.body && req.body.source === 'browser-simulator') || (req.query && req.query.source === 'browser-simulator') ? 'browser-simulator' : 'voice-gateway',
        call_usage_recorded: false,
        createdAt: new Date(),
      });
    }
  } catch (err) {
    console.error('Could not save session:', err.message);
  }

  console.log('📞 Incoming call', callSid || '(no sid)', 'from', from, 'to', to, 'clinic:', clinic.name);

  const gatherUrl = publicUrlFor(req, '/webhook/gather');

  // 3. Forward to n8n if configured
  const n8nIncomingUrl = process.env.N8N_INCOMING_URL || process.env.N8N_INCOMING_WEBHOOK_URL;
  if (!n8nIncomingUrl) {
    if (process.env.VOICE_MODE === 'n8n' || process.env.NODE_ENV === 'staging' || process.env.NODE_ENV === 'production') {
      console.error('FATAL: N8N_INCOMING_URL is required in staging/production voice gateway mode.');
      res.setHeader('x-gateway-error', 'missing_n8n_url');
      return twiml(res, BotEngine.wrapTwiml(
        BotEngine.say('क्षमा कीजिए, सेवा वर्तमान में उपलब्ध नहीं है। कृपया बाद में प्रयास करें।') + BotEngine.hangup()
      ), 503);
    }
  }

  if (n8nIncomingUrl) {
    try {
      const forwardBody = new URLSearchParams(Object.assign({}, req.query, req.body, {
        CallSid: callSid,
        call_sid: callSid,
        To: to,
        From: from,
        clinic_id: clinicId,
        clinic_name: clinic.name,
        gather_url: gatherUrl,
      }));
      const n8nRes = await fetch(n8nIncomingUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-Internal-Service-Key': process.env.INTERNAL_SERVICE_KEY || '',
          'X-Call-Sid': callSid,
        },
        body: forwardBody.toString(),
        signal: AbortSignal.timeout(8000),
      });
      if (n8nRes.ok) {
        const text = await n8nRes.text();
        return twiml(res, text);
      }
      console.error('n8n incoming webhook returned status', n8nRes.status);
      return twiml(res, BotEngine.wrapTwiml(
        BotEngine.say('क्षमा कीजिए, तकनीकी दिक्कत आ गई है। कृपया बाद में कॉल कीजिए।') + BotEngine.hangup()
      ));
    } catch (fwdErr) {
      console.error('Forward to n8n failed:', fwdErr.message);
      return twiml(res, BotEngine.wrapTwiml(
        BotEngine.say('क्षमा कीजिए, तकनीकी दिक्कत आ गई है। कृपया बाद में कॉल कीजिए।') + BotEngine.hangup()
      ));
    }
  }

  // Fallback to local bot greeting
  const greeting = (clinic && clinic.greeting_text)
    ? clinic.greeting_text
    : (clinic && clinic.name
      ? `नमस्ते! मैं ${clinic.name} से बोल रही हूँ। अपॉइंटमेंट बुक करने के लिए कृपया अपना पूरा नाम बताइए।`
      : undefined);
  twiml(res, bot.greetingTwiml(gatherUrl, greeting ? { greeting } : undefined));
}

async function handleGatherTurn(req, res) {
  const body = req.body || {};
  const query = req.query || {};
  const callSid = body.CallSid || body.call_sid || query.call_sid || query.CallSid || '';
  const from = body.From || body.from || query.From || query.from || '';
  const transcript = body.SpeechResult || body.transcript || '';

  console.log('🎙️ ', callSid || '(no sid)', '| caller:', JSON.stringify(transcript));

  // 1. Session check
  let session = null;
  if (callSid) {
    try {
      session = await store.getSession(String(callSid).trim());
    } catch (_) {}
  }

  if (!session || session.verified !== true) {
    res.setHeader('x-session-verified', 'false');
    return twiml(res, BotEngine.wrapTwiml(
      BotEngine.say('क्षमा कीजिए, आपका सत्र अमान्य है। कृपया दोबारा कॉल करें।') + BotEngine.hangup()
    ), 403);
  }
  res.setHeader('x-session-verified', 'true');

  const gatherUrl = publicUrlFor(req, '/webhook/gather');

  // 2. Forward to n8n if configured
  const n8nGatherUrl = process.env.N8N_GATHER_URL || process.env.N8N_GATHER_WEBHOOK_URL;
  if (!n8nGatherUrl) {
    if (process.env.VOICE_MODE === 'n8n' || process.env.NODE_ENV === 'staging' || process.env.NODE_ENV === 'production') {
      console.error('FATAL: N8N_GATHER_URL is required in staging/production voice gateway mode.');
      res.setHeader('x-gateway-error', 'missing_n8n_url');
      return twiml(res, BotEngine.wrapTwiml(
        BotEngine.say('क्षमा कीजिए, सेवा वर्तमान में उपलब्ध नहीं है। कृपया बाद में प्रयास करें।') + BotEngine.hangup()
      ), 503);
    }
  }

  if (n8nGatherUrl) {
    try {
      const forwardBody = new URLSearchParams(Object.assign({}, query, body, {
        CallSid: callSid,
        call_sid: callSid,
        From: from,
        gather_url: gatherUrl,
      }));
      const queryString = new URLSearchParams(query).toString();
      const targetUrl = queryString ? `${n8nGatherUrl}?${queryString}` : n8nGatherUrl;

      const n8nRes = await fetch(targetUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-Internal-Service-Key': process.env.INTERNAL_SERVICE_KEY || '',
          'X-Call-Sid': callSid,
        },
        body: forwardBody.toString(),
        signal: AbortSignal.timeout(8000),
      });

      if (n8nRes.ok) {
        const text = await n8nRes.text();
        return twiml(res, text);
      }
      console.error('n8n gather webhook returned status', n8nRes.status);
      return twiml(res, BotEngine.wrapTwiml(
        BotEngine.say('क्षमा कीजिए, तकनीकी दिक्कत आ गई है। कृपया बाद में कॉल कीजिए।') + BotEngine.hangup()
      ));
    } catch (fwdErr) {
      console.error('Forward to n8n gather failed:', fwdErr.message);
      return twiml(res, BotEngine.wrapTwiml(
        BotEngine.say('क्षमा कीजिए, तकनीकी दिक्कत आ गई है। कृपया बाद में कॉल कीजिए।') + BotEngine.hangup()
      ));
    }
  }

  // Fallback to local bot turn handler
  try {
    const result = await bot.handleTurn({
      callSid,
      from,
      transcript,
      actionUrl: gatherUrl,
      notifyClinic,
    });
    try {
      await store.logCallTurn(callSid, {
        phone: from,
        transcript,
        bot_action: result.status === 'Confirmed' ? 'booked'
          : result.asked_field ? 'asked:' + result.asked_field
          : String(result.status || 'ended').toLowerCase(),
      });
    } catch (logErr) {
      console.error('Call log failed:', logErr.message);
    }
    twiml(res, result.twiml);
  } catch (err) {
    console.error('Turn failed:', err);
    twiml(res, BotEngine.wrapTwiml(
      BotEngine.say('क्षमा कीजिए, तकनीकी दिक्कत आ गई है। कृपया बाद में कॉल कीजिए।') + BotEngine.hangup()
    ));
  }
}

// Ingress routes: Twilio signature validated on all external entry points
app.get(['/webhook/doctor-bot', '/api/voice/webhook'], twilioSignature, handleIncomingCall);
app.post(['/webhook/doctor-bot', '/api/voice/webhook'], twilioSignature, handleIncomingCall);
app.post(['/webhook/gather', '/api/voice/gather'], twilioSignature, handleGatherTurn);

// Twilio status callback -> saves calls where the caller hung up mid-way.
app.post('/webhook/status', twilioSignature, async (req, res) => {
  const body = req.body || {};
  try {
    const result = await bot.handleStatus({ callSid: body.CallSid, callStatus: body.CallStatus });
    try {
      await store.logCallTurn(body.CallSid, {
        status: String(body.CallStatus || '').toLowerCase() === 'completed' ? 'completed' : 'ended',
        duration_seconds: parseInt(body.CallDuration || '0', 10) || 0,
      });
    } catch (logErr) {
      console.error('Call log status failed:', logErr.message);
    }

    // Authoritative event: Track completed calls & duration (idempotently per callSid via persistent UsageEvent)
    if (body.CallSid) {
      try {
        const callSid = String(body.CallSid).trim();
        const callStatusLower = String(body.CallStatus || '').trim().toLowerCase();
        // Only completed incoming calls count toward billable usage; ignore initiated/ringing/in-progress/unanswered
        if (callStatusLower === 'completed') {
          const session = await store.getSession(callSid);
          if (session && session.clinic && !session.call_usage_recorded) {
            // Distinguish browser simulations from real billable calls
            if (session.source !== 'browser-simulator') {
              const rawDuration = Number(body.CallDuration);
              const durationSec = (Number.isFinite(rawDuration) && rawDuration > 0)
                ? Math.min(rawDuration, 86400) // cap at 24h to guard against corrupted payloads
                : 0;
              const durationMin = Math.ceil(durationSec / 60);
              const billingMonth = getBillingMonth(session.createdAt || new Date());
              await store.recordClinicUsage(
                session.clinic,
                billingMonth,
                {
                  call_count: 1,
                  call_minutes: durationMin,
                },
                {
                  eventId: `call:${callSid}`,
                  eventType: 'call',
                }
              );
            }
            await store.saveSession(Object.assign({}, session, { call_usage_recorded: true }));
          }
        }
      } catch (usageErr) {
        console.error('Call usage tracking failed:', usageErr.message);
      }
    }

    console.log('📴 Call', body.CallSid, body.CallStatus, '->', result.status || 'no change');
    res.json(result);
  } catch (err) {
    console.error('Status callback failed:', err.message);
    res.status(500).json({ error: 'status callback failed' });
  }
});

// ============================================================================
// Voice Gateway Endpoints (Phase 3C / 3E)
// ============================================================================

function createSimpleRateLimiter(opts) {
  const windowMs = (opts && opts.windowMs) || 60000;
  const max = (opts && opts.max) || 100;
  const hits = new Map();
  return {
    middleware: (req, res, next) => {
      const ip = req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
      const now = Date.now();
      const userHits = (hits.get(ip) || []).filter(t => now - t < windowMs);
      if (userHits.length >= max) {
        return res.status(429).json({ error: 'Too many requests' });
      }
      userHits.push(now);
      hits.set(ip, userHits);
      next();
    },
    reset: () => hits.clear(),
  };
}

const voiceWebhookLimiter = createSimpleRateLimiter({ max: 60 });
const voiceSessionLimiter = createSimpleRateLimiter({ max: 60 });
const voiceBookingLimiter = createSimpleRateLimiter({ max: 30 });

function authenticateVoiceService(req, res, next) {
  const key = req.headers['x-internal-service-key'];
  if (!key || key !== process.env.INTERNAL_SERVICE_KEY) {
    return res.status(401).json({ error: 'Unauthorized: Invalid internal service key' });
  }
  next();
}

app.post('/api/voice/session', voiceSessionLimiter.middleware, requireStoreReady, authenticateVoiceService, async (req, res) => {
  const body = req.body || {};
  const callSid = body.call_sid || body.CallSid;
  const to = body.to || body.To;
  const from = body.from || body.From || '';

  if (!callSid || !to) {
    return res.status(400).json({ error: 'call_sid and to are required' });
  }

  // Resolve clinic by To phone number
  const clinicResult = await store.resolveClinicByPhone(to);
  if (!clinicResult.ok) {
    res.setHeader('x-clinic-resolved', 'false');
    res.setHeader('x-clinic-reject-reason', clinicResult.reason || 'unknown');
    if (clinicResult.reason === 'inactive') {
      return res.status(403).json({ ok: false, error: 'Clinic is inactive' });
    }
    if (clinicResult.reason === 'ambiguous') {
      return res.status(409).json({ ok: false, error: 'Ambiguous clinic mapping' });
    }
    return res.status(404).json({ ok: false, error: 'Unknown clinic' });
  }

  const clinic = clinicResult.clinic;

  const session = {
    call_sid: String(callSid).trim(),
    clinic: clinic._id || clinic.id,
    phone: from,
    to: to,
    verified: true,
    status: 'Incomplete',
    createdAt: new Date(),
  };
  try {
    await store.saveSession(session);
  } catch (err) {
    if (err.code === 'SESSION_CLINIC_CONFLICT' || (err.message && err.message.includes('different clinic'))) {
      return res.status(409).json({ ok: false, error: 'Call session already exists for a different clinic', code: 'SESSION_CLINIC_CONFLICT' });
    }
    console.error('Save session failed:', err.message);
    return res.status(500).json({ ok: false, error: 'Failed to save voice session' });
  }

  res.setHeader('x-clinic-resolved', 'true');
  return res.status(201).json({
    ok: true,
    clinicId: clinic._id || clinic.id,
    clinicName: clinic.name,
    session,
  });
});

async function handleVoiceBooking(req, res) {
  const body = req.body || {};
  const { call_sid, phone, date, time_slot, name, doctorId } = body;
  const callSid = call_sid || body.callSid;

  // 1. Validation
  if (!callSid || !phone || !date || !time_slot) {
    return res.status(400).json({ error: 'call_sid, phone, date, and time_slot are required' });
  }

  // 1b. Date validation
  function validateBookingDate(dateStr) {
    if (!dateStr || typeof dateStr !== 'string') return false;
    const parts = dateStr.trim().split('/');
    if (parts.length === 3) {
      const day = parseInt(parts[0], 10);
      const month = parseInt(parts[1], 10) - 1;
      const year = parseInt(parts[2], 10);
      if (isNaN(day) || isNaN(month) || isNaN(year)) return false;
      const d = new Date(year, month, day);
      if (d.getFullYear() !== year || d.getMonth() !== month || d.getDate() !== day) return false;
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      if (d < today) return false;
      return true;
    }
    const isoParts = dateStr.trim().split('-');
    if (isoParts.length === 3) {
      const year = parseInt(isoParts[0], 10);
      const month = parseInt(isoParts[1], 10) - 1;
      const day = parseInt(isoParts[2], 10);
      if (isNaN(day) || isNaN(month) || isNaN(day)) return false;
      const d = new Date(year, month, day);
      if (d.getFullYear() !== year || d.getMonth() !== month || d.getDate() !== day) return false;
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      if (d < today) return false;
      return true;
    }
    return false;
  }
  if (!validateBookingDate(date)) {
    return res.status(400).json({ error: 'Invalid or past appointment date' });
  }

  // 2. Session verification
  const session = await store.getSession(String(callSid).trim());
  if (!session || session.verified !== true) {
    return res.status(403).json({ error: 'Invalid or unverified call session', code: 'InvalidSession' });
  }

  // 3. Clinic active check
  const clinicId = session.clinic ? session.clinic.toString() : '';
  const clinic = await store.getClinic(clinicId);
  if (!clinic || clinic.active === false) {
    return res.status(403).json({ error: 'Clinic is inactive' });
  }

  // 3b. Server-side subscription validation
  const subEval = evaluateSubscription(clinic.subscription);
  if (!subEval.canBook) {
    return res.status(403).json({
      error: 'Clinic subscription inactive or expired',
      code: 'SUBSCRIPTION_INACTIVE',
      status: subEval.status,
      reason: subEval.reason,
    });
  }

  // 4. Cross-clinic tenant check
  if (body.clinic && String(body.clinic) !== String(clinicId)) {
    return res.status(403).json({ error: 'Cross-clinic access denied' });
  }

  // 5. Doctor ownership check
  if (doctorId) {
    let doc = null;
    try {
      doc = await store.getDoctor(doctorId, clinicId);
    } catch (_) {}
    if (!doc || String(doc.clinic) !== String(clinicId)) {
      return res.status(400).json({ error: 'Doctor not found for this clinic' });
    }
  }

  // 7. Idempotency Check: if this exact call_sid already booked an appointment
  // Checked BEFORE quota reservation so idempotent retries never consume or hit quota.
  try {
    const existingList = await store.listAppointments({ clinic: clinicId, call_sid: callSid.trim() });
    const existing = (existingList || []).find(a => a.status === 'Confirmed');
    if (existing) {
      const isIdentical =
        String(existing.phone || '').trim() === String(phone).trim() &&
        String(existing.date || '').trim() === String(date).trim() &&
        String(existing.time_slot || '').trim() === String(time_slot).trim() &&
        (!existing.name || String(existing.name).trim().toLowerCase() === String(name).trim().toLowerCase());

      if (isIdentical) {
        return res.status(200).json({
          idempotent: true,
          appointment: existing,
          message: 'Existing appointment returned for idempotent request',
        });
      } else {
        // Different payload with the same call_sid: conflict / cannot mutate or return mismatched booking
        return res.status(409).json({
          error: 'Call session already has a confirmed appointment with different booking parameters',
          code: 'IDEMPOTENCY_CONFLICT',
        });
      }
    }
  } catch (err) {
    console.error('Idempotency check failed:', err.message);
  }

  // 7b. Monthly booking quota check / atomic reservation
  const currentBillingMonth = getBillingMonth(new Date());
  const planId = clinic.subscription && clinic.subscription.plan_id;
  let quotaReserved = false;

  if (isQuotaEnforced() && typeof store.reserveBookingQuota === 'function') {
    const plan = await resolvePlan(store, planId);
    const limit = (plan && plan.included_bookings != null) ? plan.included_bookings : 150;
    const reservation = await store.reserveBookingQuota(clinicId, currentBillingMonth, limit);
    if (!reservation.allowed) {
      return res.status(409).json({
        error: 'Monthly booking quota exceeded for this clinic plan',
        code: 'QUOTA_EXCEEDED',
        metric: 'bookings',
        limit: reservation.limit,
        usage: reservation.currentUsage,
      });
    }
    quotaReserved = true;
  } else {
    const quotaCheck = await checkQuota({
      store,
      clinicId,
      planId,
      metric: 'bookings',
      billingMonth: currentBillingMonth,
    });
    if (!quotaCheck.allowed) {
      return res.status(409).json({
        error: 'Monthly booking quota exceeded for this clinic plan',
        code: 'QUOTA_EXCEEDED',
        metric: 'bookings',
        limit: quotaCheck.limit,
        usage: quotaCheck.currentUsage,
      });
    }
    if (quotaCheck.shadowWarning) {
      res.setHeader('X-Quota-Warning', quotaCheck.shadowWarning);
    }
  }

  // 8. Atomic booking using createAppointmentIfAvailable()
  let result;
  try {
    result = await store.createAppointmentIfAvailable({
      name,
      phone,
      date,
      date_iso: BotEngine.isoForDateValue(date),
      time_slot,
      time_slot_display: time_slot,
      reason: body.reason ? String(body.reason).trim() : 'Voice Booking',
      booking_for: body.booking_for || 'Self',
      status: 'Confirmed',
      priority: 'Normal',
      source: 'voice-gateway',
      call_sid: callSid.trim(),
      doctorId: doctorId || undefined,
      clinic: clinicId,
    }, MAX_PER_SLOT);
  } catch (createErr) {
    if (quotaReserved && typeof store.releaseBookingQuota === 'function') {
      try { await store.releaseBookingQuota(clinicId, currentBillingMonth); } catch (_) {}
    }
    throw createErr;
  }

  if (!result.ok) {
    if (quotaReserved && typeof store.releaseBookingQuota === 'function') {
      try { await store.releaseBookingQuota(clinicId, currentBillingMonth); } catch (_) {}
    }
    if (result.reason === 'duplicate') {
      // F-02: Re-check existing appointment for this call_sid to safely handle concurrent race
      try {
        const existingList = await store.listAppointments({ clinic: clinicId, call_sid: callSid.trim() });
        const existing = (existingList || []).find(a => a.status === 'Confirmed');
        if (existing) {
          const isIdentical =
            String(existing.phone || '').trim() === String(phone).trim() &&
            String(existing.date || '').trim() === String(date).trim() &&
            String(existing.time_slot || '').trim() === String(time_slot).trim() &&
            (!existing.name || String(existing.name).trim().toLowerCase() === String(name).trim().toLowerCase());

          if (isIdentical) {
            return res.status(200).json({
              idempotent: true,
              appointment: existing,
              message: 'Existing appointment returned for idempotent request',
            });
          } else {
            return res.status(409).json({
              error: 'Call session already has a confirmed appointment with different booking parameters',
              code: 'IDEMPOTENCY_CONFLICT',
            });
          }
        }
      } catch (_) {}
      return res.status(409).json({ error: 'An appointment already exists for this phone, date, and time slot' });
    }
    if (result.reason === 'slot_full') {
      return res.status(409).json({ error: 'This time slot is already full' });
    }
    return res.status(500).json({ error: 'Could not create appointment' });
  }

  // 8b. Authoritative event: Track successfully created booking with persistent appointment event ID
  try {
    const bookingMonth = quotaReserved ? currentBillingMonth : getBillingMonth(result.appointment.createdAt || new Date());
    const apptId = result.appointment && (result.appointment._id || result.appointment.id);
    await store.recordClinicUsage(
      clinicId,
      bookingMonth,
      { booking_count: 1 },
      {
        eventId: apptId ? `booking:${String(apptId)}` : null,
        eventType: 'booking',
        skipCounterIncrement: quotaReserved,
      }
    );
  } catch (usageErr) {
    console.error('Booking usage tracking failed:', usageErr.message);
  }

  // 9. Update session status
  try {
    await store.saveSession(Object.assign({}, session, { status: 'Confirmed', completed: true }));
  } catch (_) {}

  // 10. Notify clinic
  try {
    await notifyClinic(result.appointment);
  } catch (_) {}

  return res.status(201).json(result.appointment);
}

app.post(['/api/voice/book', '/api/voice/appointments'], voiceBookingLimiter.middleware, requireStoreReady, authenticateVoiceService, handleVoiceBooking);

// Dashboard APIs are private (Bearer JWT from /api/auth/login) and require valid clinic context
const private_api = requireClinic;
// Gate all appointment endpoints until the store is initialized.
app.use('/api/appointments', requireStoreReady);

app.get('/api/appointments', private_api, async (req, res) => {
  try {
    const userClinic = req.user.clinic;
    if (!userClinic) {
      return res.status(403).json({ error: 'Clinic not assigned. Configure clinic during onboarding before viewing appointments.' });
    }
    const filter = { clinic: userClinic };
    if (req.query.status) filter.status = req.query.status;
    if (req.query.q) filter.q = req.query.q;
    if (req.query.date) filter.date = req.query.date;
    if (req.query.limit) filter.limit = req.query.limit;
    const list = await store.listAppointments(filter);
    res.json(list);
  } catch (err) {
    console.error('List failed:', err.message);
    res.status(500).json({ error: 'Could not load appointments' });
  }
});

// Pre-check for duplicate before booking (returns whether a clash exists).
app.get('/api/appointments/check-duplicate', private_api, async (req, res) => {
  const { phone, date, time_slot } = req.query;
  if (!phone || !date || !time_slot) {
    return res.status(400).json({ error: 'phone, date, and time_slot query parameters are required' });
  }
  try {
    const existing = await store.findDuplicate({ phone, date, time_slot, clinic: req.user.clinic });
    res.json({ duplicate: !!existing, appointment: existing || null });
  } catch (err) {
    res.status(500).json({ error: 'Duplicate check failed' });
  }
});


app.get('/api/appointments/:id', private_api, async (req, res) => {
  try {
    const filter = { _id: req.params.id, clinic: req.user.clinic };
    const one = await store.getAppointment(filter);
    if (!one) return res.status(404).json({ error: 'Not found' });
    res.json(one);
  } catch (err) {
    res.status(400).json({ error: 'Invalid id' });
  }
});

app.patch('/api/appointments/:id', private_api, async (req, res) => {
  const allowed = ['Confirmed', 'Completed', 'Cancelled', 'Incomplete'];
  const status = req.body && req.body.status;
  if (!allowed.includes(status)) {
    return res.status(400).json({ error: 'status must be one of ' + allowed.join(', ') });
  }
  try {
    const updated = await store.updateAppointmentStatus(req.params.id, status, { clinic: req.user.clinic });
    if (!updated) return res.status(404).json({ error: 'Not found' });
    res.json(updated);
  } catch (err) {
    if (err && (err.code === 'SLOT_FULL' || (err.message && err.message.includes('already full')))) {
      return res.status(409).json({ error: 'This time slot is already full' });
    }
    res.status(400).json({ error: 'Invalid id' });
  }
});

// Delete an appointment (clinic-scoped).
// Only the owning clinic's users can delete appointments.
app.delete('/api/appointments/:id', private_api, async (req, res) => {
  try {
    const removed = await store.deleteAppointment(req.params.id, { clinic: req.user.clinic });
    if (!removed) return res.status(404).json({ error: 'Not found' });
    res.json({ deleted: true });
  } catch (err) {
    res.status(400).json({ error: 'Invalid id' });
  }
});

// ---- manual appointment creation (dashboard use case) --------------------
function parseTimeToMinutes(str) {
  if (!str) return null;
  const s = String(str).trim();
  // 12-hour format with AM/PM: e.g. "10:00 AM", "08:00 PM", "8:30pm", "8 pm"
  const m12 = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)$/i.exec(s);
  if (m12) {
    let hours = parseInt(m12[1], 10);
    const mins = m12[2] ? parseInt(m12[2], 10) : 0;
    const isPm = /p/i.test(m12[3]);
    if (isPm && hours < 12) hours += 12;
    if (!isPm && hours === 12) hours = 0;
    return hours * 60 + mins;
  }
  // 24-hour format: e.g. "09:00", "17:30", "9:00"
  const m24 = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (m24) {
    return parseInt(m24[1], 10) * 60 + parseInt(m24[2], 10);
  }
  // Try finding HH:MM AM/PM embedded or trailing
  const mEmbedded = /(\d{1,2}):(\d{2})(?:\s*(am|pm))?/i.exec(s);
  if (mEmbedded) {
    let hours = parseInt(mEmbedded[1], 10);
    const mins = parseInt(mEmbedded[2], 10);
    if (mEmbedded[3]) {
      const isPm = /p/i.test(mEmbedded[3]);
      if (isPm && hours < 12) hours += 12;
      if (!isPm && hours === 12) hours = 0;
    }
    return hours * 60 + mins;
  }
  return null;
}

function slotWithinHours(slot, workingHours) {
  if (!Array.isArray(workingHours) || workingHours.length === 0) return true; // no hours = always open
  const slotMinutes = parseTimeToMinutes(slot);
  if (slotMinutes === null) return true; // window slots (e.g. "Morning") pass
  return workingHours.some((wh) => {
    const start = parseTimeToMinutes(wh.start);
    const end = parseTimeToMinutes(wh.end);
    return start !== null && end !== null && slotMinutes >= start && slotMinutes <= end;
  });
}

app.post('/api/appointments', private_api, requireActiveSubscription, async (req, res) => {
  const body = req.body || {};
  const { name, phone, date, time_slot, reason, booking_for, status, doctorId } = body;

  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: 'Patient name is required' });
  }
  if (!phone || !String(phone).trim()) {
    return res.status(400).json({ error: 'Phone number is required' });
  }
  if (!date || !String(date).trim()) {
    return res.status(400).json({ error: 'Appointment date is required' });
  }
  if (!time_slot || !String(time_slot).trim()) {
    return res.status(400).json({ error: 'Time slot is required' });
  }

  // Validate date format (DD/MM/YYYY) and range (not in the past, not too far ahead).
  const dateRes = BotEngine.parseDate(String(date).trim(), new Date());
  if (dateRes.status !== 'ok') {
    const reasons = {
      invalid_date: 'Invalid date format. Use DD/MM/YYYY (e.g. 24/06/2026).',
      past_date: 'Appointment date cannot be in the past.',
      too_far: 'Appointment date is too far in the future.',
      closed_day: 'The clinic is closed on that day of the week.',
    };
    return res.status(400).json({ error: reasons[dateRes.status] || 'Invalid date.' });
  }

  const userClinic = req.user.clinic;

  // Doctor availability validation (optional doctorId).
  if (doctorId) {
    if (typeof doctorId !== 'string' || !doctorId.trim()) {
      return res.status(400).json({ error: 'Invalid doctor ID format' });
    }
    let doctor = null;
    try {
      doctor = await store.getDoctor(doctorId.trim(), { clinic: userClinic });
    } catch (err) {
      if (err.name === 'CastError' || (err.message && (err.message.includes('Cast') || err.message.includes('Invalid') || err.message.includes('BSONError')))) {
        return res.status(400).json({ error: 'Invalid doctor ID' });
      }
      return res.status(500).json({ error: 'Doctor availability check failed.' });
    }
    if (!doctor) {
      return res.status(400).json({ error: 'Doctor not found for this clinic' });
    }
    const dateIso = BotEngine.isoForDateValue(String(date).trim());
    const weekday = BotEngine.dayOfWeekFromDate(String(date).trim());
    const holidays = Array.isArray(doctor.holidays) ? doctor.holidays : [];
    const hours = Array.isArray(doctor.working_hours) ? doctor.working_hours : [];
    const hasSchedule = hours.length > 0;
    const offThatDay = weekday !== null && hasSchedule && !hours.some(h => Number(h.day) === weekday);
    const outsideHours = hasSchedule && !slotWithinHours(time_slot, hours.filter(h => Number(h.day) === weekday));
    if (holidays.includes(dateIso)) {
      return res.status(400).json({ error: 'The clinic is closed on that date (holiday).' });
    }
    if (offThatDay) {
      return res.status(400).json({ error: 'The doctor is not available on that day of the week.' });
    }
    if (outsideHours) {
      return res.status(400).json({ error: 'The requested time slot is outside the doctor\'s working hours.' });
    }
  }

  // Subscription booking quota check / atomic reservation
  const clinic = await store.getClinic(userClinic);
  const currentBillingMonth = getBillingMonth(new Date());
  const planId = clinic && clinic.subscription && clinic.subscription.plan_id;
  let quotaReserved = false;

  if (isQuotaEnforced() && typeof store.reserveBookingQuota === 'function') {
    const plan = await resolvePlan(store, planId);
    const limit = (plan && plan.included_bookings != null) ? plan.included_bookings : 150;
    const reservation = await store.reserveBookingQuota(userClinic, currentBillingMonth, limit);
    if (!reservation.allowed) {
      return res.status(409).json({
        error: 'Monthly booking quota exceeded for this clinic plan',
        code: 'QUOTA_EXCEEDED',
        metric: 'bookings',
        limit: reservation.limit,
        usage: reservation.currentUsage,
      });
    }
    quotaReserved = true;
  } else {
    const quotaCheck = await checkQuota({
      store,
      clinicId: userClinic,
      planId,
      metric: 'bookings',
      billingMonth: currentBillingMonth,
    });
    if (!quotaCheck.allowed) {
      return res.status(409).json({
        error: 'Monthly booking quota exceeded for this clinic plan',
        code: 'QUOTA_EXCEEDED',
        metric: 'bookings',
        limit: quotaCheck.limit,
        usage: quotaCheck.currentUsage,
      });
    }
    if (quotaCheck.shadowWarning) {
      res.setHeader('X-Quota-Warning', quotaCheck.shadowWarning);
    }
  }

  // Atomic duplicate check + slot cap + create (transaction on MongoDB, lock on memory/file).
  // Scoped to the authenticated user's clinic; ignores any request-body clinic field.
  let result;
  try {
    result = await store.createAppointmentIfAvailable({
      name: String(name).trim(),
      phone: String(phone).trim(),
      date: String(date).trim(),
      time_slot: String(time_slot).trim(),
      time_slot_display: String(time_slot).trim(),
      reason: reason ? String(reason).trim() : 'Not specified',
      booking_for: booking_for || 'Self',
      status: status || 'Confirmed',
      priority: 'Normal',
      source: 'dashboard',
      doctorId: doctorId ? String(doctorId).trim() : undefined,
      clinic: userClinic,
    }, MAX_PER_SLOT);
  } catch (createErr) {
    if (quotaReserved && typeof store.releaseBookingQuota === 'function') {
      try { await store.releaseBookingQuota(userClinic, currentBillingMonth); } catch (_) {}
    }
    throw createErr;
  }

  if (!result.ok) {
    if (quotaReserved && typeof store.releaseBookingQuota === 'function') {
      try { await store.releaseBookingQuota(userClinic, currentBillingMonth); } catch (_) {}
    }
    if (result.reason === 'duplicate') {
      return res.status(409).json({
        error: 'An appointment already exists for this phone, date, and time slot',
      });
    }
    if (result.reason === 'slot_full') {
      return res.status(409).json({ error: 'This time slot is already full' });
    }
    return res.status(500).json({ error: 'Could not create appointment' });
  }

  // Authoritative event: Track successfully created booking with persistent appointment event ID
  try {
    const bookingMonth = quotaReserved ? currentBillingMonth : getBillingMonth(result.appointment.createdAt || new Date());
    const apptId = result.appointment && (result.appointment._id || result.appointment.id);
    await store.recordClinicUsage(
      userClinic,
      bookingMonth,
      { booking_count: 1 },
      {
        eventId: apptId ? `booking:${String(apptId)}` : null,
        eventType: 'booking',
        skipCounterIncrement: quotaReserved,
      }
    );
  } catch (usageErr) {
    console.error('Manual booking usage tracking failed:', usageErr.message);
  }

  res.status(201).json(result.appointment);
});

// Call log for the dashboard (transcripts + what the bot did)
app.get('/api/calls', private_api, async (req, res) => {
  try {
    const filter = { clinic: req.user.clinic };
    const list = await store.listCallLogs(filter, { limit: req.query.limit });
    res.json(list);
  } catch (err) {
    console.error('Call log list failed:', err.message);
    res.status(500).json({ error: 'Could not load call logs' });
  }
});

// ---- doctors -------------------------------------------------------------
function requireClinicOwner(req, res, next) {
  const role = req.user && req.user.role;
  if (role === 'clinic_owner' || role === 'admin') {
    return next();
  }
  return res.status(403).json({
    error: 'Only the clinic owner can modify clinic settings or doctor schedules.',
    code: 'OWNER_ONLY',
  });
}

function validateWorkingHours(workingHours) {
  if (!Array.isArray(workingHours)) return { ok: false, error: 'working_hours must be an array' };
  const timeRe = /^([01]\d|2[0-3]):([0-5]\d)$/;
  const normalized = [];
  for (const entry of workingHours) {
    if (!entry || typeof entry !== 'object') {
      return { ok: false, error: 'Each working_hours entry must be an object' };
    }
    const day = Number(entry.day);
    if (!Number.isInteger(day) || day < 0 || day > 6) {
      return { ok: false, error: 'working_hours day must be an integer between 0 (Sun) and 6 (Sat)' };
    }
    const start = String(entry.start || '').trim();
    const end = String(entry.end || '').trim();
    if (!timeRe.test(start) || !timeRe.test(end)) {
      return { ok: false, error: 'working_hours start and end must use 24-hour HH:mm format' };
    }
    if (start >= end) {
      return { ok: false, error: 'working_hours start time must be earlier than end time' };
    }
    normalized.push({ day, start, end });
  }
  return { ok: true, value: normalized };
}

app.get('/api/doctors', private_api, async (req, res) => {
  try {
    const userClinic = req.user.clinic;
    if (!userClinic) {
      return res.status(403).json({ error: 'Clinic not assigned. Configure clinic during onboarding before viewing doctors.' });
    }
    const filter = { clinic: userClinic };
    res.json(await store.listDoctors(filter));
  } catch (err) {
    res.status(500).json({ error: 'Could not load doctors' });
  }
});

app.post('/api/doctors', private_api, requireClinicOwner, requireActiveSubscription, async (req, res) => {
  const body = req.body || {};
  if (!body.name || !String(body.name).trim()) {
    return res.status(400).json({ error: 'Doctor name is required' });
  }
  const slot = parseInt(body.slot_minutes, 10);
  if (body.slot_minutes !== undefined && (!slot || slot < 5 || slot > 120)) {
    return res.status(400).json({ error: 'slot_minutes must be between 5 and 120' });
  }
  let validatedHours;
  if (body.working_hours !== undefined) {
    const wh = validateWorkingHours(body.working_hours);
    if (!wh.ok) return res.status(400).json({ error: wh.error });
    validatedHours = wh.value;
  }

  // Atomic doctor limit check & creation against subscribed plan
  const userClinic = req.user.clinic;
  const clinic = await store.getClinic(userClinic);
  const planId = clinic && clinic.subscription && clinic.subscription.plan_id;
  const plan = await resolvePlan(store, planId);
  const maxDoctors = (plan && plan.max_doctors != null) ? plan.max_doctors : 2;
  const enforced = isQuotaEnforced();

  const doctorData = {
    name: String(body.name).trim(),
    specialty: body.specialty ? String(body.specialty).trim() : 'General Physician',
    slot_minutes: slot || 15,
    working_hours: validatedHours !== undefined ? validatedHours : undefined,
    holidays: Array.isArray(body.holidays) ? body.holidays : [],
    active: body.active !== false,
    clinic: userClinic,
  };

  try {
    if (typeof store.createDoctorIfWithinLimit === 'function') {
      const result = await store.createDoctorIfWithinLimit(doctorData, {
        clinic: userClinic,
        maxDoctors,
        enforce: enforced,
      });
      if (!result.ok && result.reason === 'quota_exceeded') {
        return res.status(409).json({
          error: 'Doctor limit reached for this clinic subscription plan',
          code: 'QUOTA_EXCEEDED',
          metric: 'max_doctors',
          limit: result.limit,
          usage: result.currentUsage,
        });
      }
      if (!enforced && doctorData.active && result.currentUsage >= maxDoctors) {
        res.setHeader('X-Quota-Warning', `Plan quota exceeded for max_doctors: ${result.currentUsage}/${maxDoctors} (shadow mode)`);
      }
      return res.status(201).json(result.doctor);
    }

    const doctor = await store.createDoctor(doctorData, { clinic: userClinic });
    res.status(201).json(doctor);
  } catch (err) {
    res.status(500).json({ error: 'Could not create the doctor' });
  }
});

app.patch('/api/doctors/:id', private_api, requireClinicOwner, requireActiveSubscription, async (req, res) => {
  const body = req.body || {};
  const patch = {};
  if (body.name !== undefined) {
    if (!String(body.name).trim()) return res.status(400).json({ error: 'Doctor name cannot be empty' });
    patch.name = String(body.name).trim();
  }
  if (body.specialty !== undefined) patch.specialty = String(body.specialty).trim();
  if (body.slot_minutes !== undefined) {
    const slot = parseInt(body.slot_minutes, 10);
    if (!slot || slot < 5 || slot > 120) return res.status(400).json({ error: 'slot_minutes must be between 5 and 120' });
    patch.slot_minutes = slot;
  }
  if (body.working_hours !== undefined) {
    const wh = validateWorkingHours(body.working_hours);
    if (!wh.ok) return res.status(400).json({ error: wh.error });
    patch.working_hours = wh.value;
  }
  if (body.holidays !== undefined) patch.holidays = body.holidays;
  if (body.active !== undefined) patch.active = !!body.active;
  // When updating a doctor, ensure the clinic field is not changed to a different clinic
  if (patch.clinic && patch.clinic !== req.user.clinic) {
    return res.status(403).json({ error: 'Cannot reassign doctor to a different clinic' });
  }
  // Preserve the original clinic if not being explicitly changed
  if (!patch.clinic && req.user.clinic) {
    patch.clinic = req.user.clinic;
  }
  try {
    // Atomic doctor update with cross-process max_doctors guard on reactivation
    if (typeof store.updateDoctorIfWithinLimit === 'function') {
      const clinic = await store.getClinic(req.user.clinic);
      const planId = clinic && clinic.subscription && clinic.subscription.plan_id;
      const plan = await resolvePlan(store, planId);
      const maxDoctors = (plan && plan.max_doctors != null) ? plan.max_doctors : 2;
      const enforced = isQuotaEnforced();

      const result = await store.updateDoctorIfWithinLimit(req.params.id, patch, {
        clinic: req.user.clinic,
        maxDoctors,
        enforce: enforced,
      });
      if (!result.ok) {
        if (result.reason === 'quota_exceeded') {
          return res.status(409).json({
            error: 'Doctor limit reached for this clinic subscription plan',
            code: 'QUOTA_EXCEEDED',
            metric: 'max_doctors',
            limit: result.limit,
            usage: result.currentUsage,
          });
        }
        return res.status(404).json({ error: 'Doctor not found' });
      }
      if (!enforced && result.reactivated && result.currentUsage >= maxDoctors) {
        res.setHeader('X-Quota-Warning', `Plan quota exceeded for max_doctors: ${result.currentUsage}/${maxDoctors} (shadow mode)`);
      }
      return res.json(result.doctor);
    }

    const updated = await store.updateDoctor(req.params.id, patch, { clinic: req.user.clinic });
    if (!updated) return res.status(404).json({ error: 'Doctor not found' });
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: 'Could not update the doctor' });
  }
});

app.delete('/api/doctors/:id', private_api, requireClinicOwner, requireActiveSubscription, async (req, res) => {
  try {
    const deleted = await store.deleteDoctor(req.params.id, { clinic: req.user.clinic });
    if (!deleted) return res.status(404).json({ error: 'Doctor not found' });
    res.json({ deleted: true });
  } catch (err) {
    res.status(400).json({ error: 'Could not delete the doctor' });
  }
});

// ---- clinic settings -----------------------------------------------------
// Clinic settings are scoped to the authenticated user's clinic.
// Only the clinic owner or admin can modify settings.
app.get('/api/clinic', private_api, async (req, res) => {
  try {
    const userClinic = req.user && req.user.clinic;
    if (!userClinic) {
      return res.status(403).json({ error: 'Clinic not assigned. Configure clinic during onboarding before viewing settings.' });
    }
    const clinic = await store.getClinic(userClinic);
    if (!clinic) {
      return res.status(404).json({ error: 'Clinic not found' });
    }
    res.json(clinic);
  } catch (err) {
    console.error('Could not load clinic:', err.message);
    res.status(500).json({ error: 'Could not load the clinic' });
  }
});

const updateClinicHandler = async (req, res) => {
  const userClinic = req.user && req.user.clinic;
  if (!userClinic || userClinic === 'default') {
    return res.status(403).json({ error: 'Clinic not assigned. Configure clinic during onboarding before modifying settings.' });
  }

  const body = req.body || {};
  const patch = {};
  for (const field of ['name', 'whatsapp_to', 'greeting_text', 'timezone']) {
    if (body[field] !== undefined) patch[field] = String(body[field]);
  }
  if (body.phone !== undefined) {
    const rawPhone = String(body.phone).trim();
    const normalized = normalizePhone(rawPhone);
    const digitsOnly = normalized ? normalized.replace(/\D/g, '') : '';
    if (!normalized || digitsOnly.length < 10 || digitsOnly.length > 15) {
      return res.status(400).json({ error: 'A valid 10-digit Indian phone number is required for the clinic' });
    }
    patch.phone = normalized;
  }
  if (body.languages !== undefined) {
    if (!Array.isArray(body.languages)) return res.status(400).json({ error: 'languages must be an array' });
    patch.languages = body.languages.map(String);
  }
  if (body.greeting_text !== undefined && !String(body.greeting_text).trim()) {
    return res.status(400).json({ error: 'The greeting cannot be empty' });
  }
  if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nothing to update' });
  try {
    const updated = await store.saveClinic(patch, { clinic: userClinic });
    if (!updated) {
      return res.status(404).json({ error: 'Clinic not found' });
    }
    res.json(updated);
  } catch (err) {
    if (err.code === 11000 || (err.message && (err.message.includes('E11000') || err.message.includes('duplicate key')))) {
      return res.status(409).json({ error: 'A clinic with this phone number already exists' });
    }
    if (err.message && err.message.includes('Invalid clinic ID')) {
      return res.status(400).json({ error: 'Invalid clinic ID' });
    }
    console.error('Could not save clinic:', err.message);
    res.status(500).json({ error: 'Could not save the clinic settings' });
  }
};
app.patch('/api/clinic', private_api, requireClinicOwner, requireActiveSubscription, updateClinicHandler);
app.put('/api/clinic', private_api, requireClinicOwner, requireActiveSubscription, updateClinicHandler);

// ---- subscription & usage endpoints (Phase 2 commercial SaaS) ------------
// GET /api/subscription - Clinic subscription status, plan limits, and current usage
app.get('/api/subscription', private_api, async (req, res) => {
  try {
    const userClinic = req.user.clinic;
    if (!userClinic) {
      return res.status(403).json({ error: 'Clinic not assigned' });
    }
    const clinic = await store.getClinic(userClinic);
    if (!clinic) {
      return res.status(404).json({ error: 'Clinic not found' });
    }
    const evaluation = evaluateSubscription(clinic.subscription);
    const plan = await resolvePlan(store, clinic.subscription && clinic.subscription.plan_id);
    const currentBillingMonth = getBillingMonth(new Date());
    const currentUsage = (await store.getClinicUsage(userClinic, currentBillingMonth)) || {
      call_count: 0,
      call_minutes: 0,
      booking_count: 0,
      whatsapp_count: 0,
    };
    const doctors = await store.listDoctors({ clinic: userClinic });
    const activeDoctorsCount = (doctors || []).filter(d => d.active !== false).length;

    res.json({
      clinicId: userClinic,
      clinicName: clinic.name,
      subscription: clinic.subscription,
      evaluation,
      plan,
      currentBillingMonth,
      usage: {
        call_count: currentUsage.call_count || 0,
        call_minutes: currentUsage.call_minutes || 0,
        booking_count: currentUsage.booking_count || 0,
        whatsapp_count: currentUsage.whatsapp_count || 0,
        doctor_count: activeDoctorsCount,
      },
      limits: {
        included_call_minutes: plan.included_call_minutes,
        included_bookings: plan.included_bookings,
        max_doctors: plan.max_doctors,
      },
      quotaEnforcement: isQuotaEnforced(),
    });
  } catch (err) {
    console.error('Subscription retrieval failed:', err.message);
    res.status(500).json({ error: 'Could not load subscription details' });
  }
});

// GET /api/usage - Current or specified month's usage for the clinic
app.get('/api/usage', private_api, async (req, res) => {
  try {
    const userClinic = req.user.clinic;
    if (!userClinic) {
      return res.status(403).json({ error: 'Clinic not assigned' });
    }
    const month = req.query.month ? String(req.query.month).trim() : getBillingMonth(new Date());
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
      return res.status(400).json({ error: 'Invalid month format. Expected YYYY-MM.' });
    }
    const usage = await store.getClinicUsage(userClinic, month);
    res.json({
      clinicId: userClinic,
      billingMonth: month,
      usage: usage || {
        clinic: userClinic,
        billing_month: month,
        call_count: 0,
        call_minutes: 0,
        booking_count: 0,
        whatsapp_count: 0,
      },
    });
  } catch (err) {
    console.error('Usage retrieval failed:', err.message);
    res.status(500).json({ error: 'Could not load clinic usage' });
  }
});

// ---- billing & subscription payment endpoints (Phase 3 commercial SaaS) --
function requireBillingOwner(req, res, next) {
  const role = req.user && req.user.role;
  if (role !== 'clinic_owner' && role !== 'admin' && role !== 'platform_admin') {
    return res.status(403).json({
      error: 'Forbidden: Only the clinic owner can manage subscription plans and billing',
      code: 'BILLING_UNAUTHORIZED_ROLE',
    });
  }
  next();
}

// GET /api/billing/plans - List active subscription plans (configurable prices)
app.get('/api/billing/plans', requireStoreReady, async (req, res) => {
  try {
    const plans = await store.listSubscriptionPlans({ activeOnly: true });
    res.json({
      plans: plans || [],
      currency: 'INR',
      provider: paymentService.providerName,
      is_test_mode: paymentService.providerName === 'mock',
    });
  } catch (err) {
    console.error('Billing plans retrieval failed:', err.message);
    res.status(500).json({ error: 'Could not load subscription plans' });
  }
});

// GET /api/billing/subscription - Authenticated clinic's subscription & lifecycle state
app.get('/api/billing/subscription', requireStoreReady, private_api, async (req, res) => {
  try {
    const userClinic = req.user.clinic;
    const clinic = await store.getClinic(userClinic);
    if (!clinic) {
      return res.status(404).json({ error: 'Clinic not found' });
    }
    const evaluation = evaluateSubscription(clinic.subscription);
    const plan = await resolvePlan(store, clinic.subscription && clinic.subscription.plan_id);
    const currentBillingMonth = getBillingMonth(new Date());
    const usage = (await store.getClinicUsage(userClinic, currentBillingMonth)) || {
      call_count: 0,
      call_minutes: 0,
      booking_count: 0,
      whatsapp_count: 0,
    };
    const doctors = await store.listDoctors({ clinic: userClinic });
    const activeDoctorsCount = (doctors || []).filter(d => d.active !== false).length;

    res.json({
      clinicId: userClinic,
      clinicName: clinic.name,
      subscription: clinic.subscription,
      evaluation,
      plan,
      currentBillingMonth,
      usage: {
        call_count: usage.call_count || 0,
        call_minutes: usage.call_minutes || 0,
        booking_count: usage.booking_count || 0,
        whatsapp_count: usage.whatsapp_count || 0,
        doctor_count: activeDoctorsCount,
      },
      limits: {
        included_call_minutes: plan.included_call_minutes,
        included_bookings: plan.included_bookings,
        max_doctors: plan.max_doctors,
        included_whatsapp: plan.included_whatsapp !== undefined ? plan.included_whatsapp : null,
      },
      provider: paymentService.providerName,
      is_test_mode: paymentService.providerName === 'mock',
    });
  } catch (err) {
    console.error('Billing subscription retrieval failed:', err.message);
    res.status(500).json({ error: 'Could not load billing subscription' });
  }
});

// POST /api/billing/simulate-upgrade - Simulate an upgrade request without activating or charging
app.post('/api/billing/simulate-upgrade', requireStoreReady, private_api, requireBillingOwner, async (req, res) => {
  const body = req.body || {};
  const planId = body.plan_id ? String(body.plan_id).trim().toLowerCase() : '';
  if (!planId) {
    return res.status(400).json({ error: 'plan_id is required' });
  }

  try {
    const userClinic = req.user.clinic;
    const clinic = await store.getClinic(userClinic);
    if (!clinic) {
      return res.status(404).json({ error: 'Clinic not found' });
    }

    const targetPlan = await store.getSubscriptionPlan(planId);
    if (!targetPlan || targetPlan.active === false) {
      return res.status(404).json({ error: 'Subscription plan not found or inactive' });
    }

    const currentPlan = await resolvePlan(store, clinic.subscription && clinic.subscription.plan_id);

    return res.status(200).json({
      ok: true,
      simulated: true,
      message: 'Simulated upgrade request received successfully. No real charge has been made.',
      currentPlan: {
        plan_id: currentPlan.plan_id,
        name: currentPlan.name,
        price_inr: currentPlan.price_inr,
      },
      targetPlan: {
        plan_id: targetPlan.plan_id,
        name: targetPlan.name,
        price_inr: targetPlan.price_inr,
        billing_interval: targetPlan.billing_interval,
        included_call_minutes: targetPlan.included_call_minutes,
        included_bookings: targetPlan.included_bookings,
        max_doctors: targetPlan.max_doctors,
        features: targetPlan.features,
      },
      proposedPriceInr: targetPlan.price_inr,
      status: 'simulated_pending',
      note: 'Commercial payments are simulated in demonstration mode (₹0 cost). Actual subscription remains in its current state.',
    });
  } catch (err) {
    console.error('Simulate upgrade failed:', err.message);
    return res.status(500).json({ error: 'Could not process simulated upgrade request' });
  }
});

// POST /api/billing/checkout - Create a pending checkout session (NEVER activates directly)
app.post('/api/billing/checkout', requireStoreReady, private_api, requireBillingOwner, async (req, res) => {
  const body = req.body || {};

  // Security: Explicitly reject any browser-supplied payment-success or activation flags
  if (
    body.payment_success !== undefined ||
    body.paymentSuccess !== undefined ||
    body.paid !== undefined ||
    body.activate !== undefined ||
    body.status !== undefined
  ) {
    return res.status(400).json({
      error: 'Browser requests cannot supply payment status or directly activate subscriptions',
      code: 'FORBIDDEN_CLIENT_PAYMENT_FLAG',
    });
  }

  const planId = body.plan_id ? String(body.plan_id).trim().toLowerCase() : '';
  if (!planId) {
    return res.status(400).json({ error: 'plan_id is required' });
  }

  try {
    const userClinic = req.user.clinic;
    const clinic = await store.getClinic(userClinic);
    if (!clinic) {
      return res.status(404).json({ error: 'Clinic not found' });
    }

    const plan = await store.getSubscriptionPlan(planId);
    if (!plan || plan.active === false) {
      return res.status(404).json({ error: 'Subscription plan not found or inactive' });
    }

    const checkout = await paymentService.createCheckoutSession({
      clinic,
      plan,
      userId: req.user.sub || req.user.id || '',
    });

    return res.status(201).json({
      ok: true,
      checkout,
    });
  } catch (err) {
    const status = err.statusCode || 500;
    console.error('Billing checkout creation failed:', err.message);
    return res.status(status).json({
      error: err.message || 'Could not create checkout session',
      code: err.code || 'CHECKOUT_FAILED',
    });
  }
});

// GET /api/billing/invoices - Strictly clinic-scoped invoice list
app.get('/api/billing/invoices', requireStoreReady, private_api, async (req, res) => {
  try {
    const userClinic = req.user.clinic;
    const invoices = await store.listInvoices(userClinic, { limit: req.query.limit });
    res.json({
      clinicId: userClinic,
      invoices: invoices || [],
    });
  } catch (err) {
    console.error('Billing invoice list failed:', err.message);
    res.status(500).json({ error: 'Could not load invoices' });
  }
});

// GET /api/billing/invoices/:id - Strictly clinic-scoped single invoice retrieval
app.get('/api/billing/invoices/:id', requireStoreReady, private_api, async (req, res) => {
  try {
    const userClinic = req.user.clinic;
    const invoice = await store.getInvoice(req.params.id, { clinic: userClinic });
    if (!invoice) {
      return res.status(404).json({ error: 'Invoice not found' });
    }
    res.json(invoice);
  } catch (err) {
    res.status(400).json({ error: 'Invalid invoice ID' });
  }
});

// POST /api/billing/cancel - Cancel authenticated clinic's subscription
app.post('/api/billing/cancel', requireStoreReady, private_api, requireBillingOwner, async (req, res) => {
  try {
    const userClinic = req.user.clinic;
    const clinic = await store.getClinic(userClinic);
    if (!clinic) {
      return res.status(404).json({ error: 'Clinic not found' });
    }
    const body = req.body || {};
    const cancelAtPeriodEnd = body.cancel_at_period_end !== false;
    const result = await paymentService.cancelSubscription({ clinic, cancelAtPeriodEnd });
    return res.status(200).json(result);
  } catch (err) {
    const status = err.statusCode || 500;
    console.error('Billing cancellation failed:', err.message);
    return res.status(status).json({
      error: err.message || 'Could not cancel subscription',
      code: err.code || 'CANCEL_FAILED',
    });
  }
});

// POST /api/billing/webhook - Cryptographically verified payment webhook handler
app.post('/api/billing/webhook', requireStoreReady, async (req, res) => {
  try {
    const signature = req.get('x-payment-signature') || '';
    const rawBody = typeof req.rawBody === 'string' ? req.rawBody : JSON.stringify(req.body || {});
    const result = await paymentService.handleWebhook({
      rawBody,
      signature,
      payload: req.body || {},
    });
    return res.status(result.statusCode || (result.ok ? 200 : 400)).json(result);
  } catch (err) {
    const status = err.statusCode || 500;
    console.error('Billing webhook failed:', err.message);
    return res.status(status).json({
      ok: false,
      error: err.message || 'Webhook processing failed',
      code: err.code || 'WEBHOOK_ERROR',
    });
  }
});

// ---- browser-based AI receptionist simulator (Phase 4 & 5A) --------------
// Dedicated JWT-authenticated browser simulation API.
// Strictly isolated from Twilio sessions & INTERNAL_SERVICE_KEY.
// Never sends Twilio calls/WhatsApp messages or consumes billable call minutes.
const receptionistSessionLimiter = createSimpleRateLimiter({ max: 15, windowMs: 60000 });
const receptionistAudioLimiter = createSimpleRateLimiter({ max: 20, windowMs: 60000 });

app.get('/api/receptionist/capabilities', requireStoreReady, private_api, async (req, res) => {
  try {
    const userClinic = req.user.clinic;
    const doctors = await store.listDoctors({ clinic: userClinic });
    const activeDoctors = (doctors || [])
      .filter(d => d.active !== false)
      .map(d => ({
        _id: d._id || d.id,
        name: d.name,
        specialty: d.specialty || 'General Physician',
      }));
    res.json({
      ok: true,
      clinicId: userClinic,
      voice: localVoice.getCapabilities(),
      doctors: activeDoctors,
      supported_languages: [
        { code: 'hi', label: 'हिंदी (Hindi)' },
        { code: 'hinglish', label: 'Hinglish' },
        { code: 'en', label: 'English' },
      ],
    });
  } catch (err) {
    console.error('Receptionist capabilities failed:', err.message);
    res.status(500).json({ error: 'Could not load receptionist capabilities' });
  }
});

app.post('/api/receptionist/warmup', requireStoreReady, private_api, async (req, res) => {
  try {
    const status = await localVoice.warmup();
    res.status(200).json(status);
  } catch (err) {
    res.status(200).json({ ok: false, warmed: false, available: false, reason: err.message });
  }
});

app.post('/api/receptionist/sessions', receptionistSessionLimiter.middleware, requireStoreReady, private_api, requireActiveSubscription, async (req, res) => {
  try {
    const body = req.body || {};
    const userClinic = req.user.clinic;
    const sessionData = await browserReceptionist.startSession({
      clinicId: userClinic,
      language: body.language || 'hi',
      doctorId: body.doctorId || null,
      userId: req.user.sub || req.user.id || '',
    });

    let audio = null;
    if (body.speak === true) {
      const tts = await localVoice.synthesize({ text: sessionData.reply, lang: sessionData.language });
      if (tts && tts.ok) {
        audio = {
          audio_base64: tts.audio_base64,
          mime_type: tts.mime_type,
          voice: tts.voice,
          engine: 'kokoro-onnx',
        };
      }
    }

    return res.status(201).json(Object.assign({ ok: true, audio }, sessionData));
  } catch (err) {
    const status = err.statusCode || 500;
    console.error('Receptionist session start failed:', err.message);
    return res.status(status).json({ error: err.message || 'Could not start simulation session' });
  }
});

app.post('/api/receptionist/sessions/:sessionId/turn', requireStoreReady, private_api, requireActiveSubscription, async (req, res) => {
  try {
    const body = req.body || {};
    const userClinic = req.user.clinic;
    const result = await browserReceptionist.processTurn({
      sessionId: req.params.sessionId,
      clinicId: userClinic,
      text: body.text || '',
    });

    let audio = null;
    if (body.speak === true && result.reply) {
      const sess = browserReceptionist.getSessionForClinic(req.params.sessionId, userClinic);
      const lang = (sess && sess.language) || body.language || 'hi';
      const tts = await localVoice.synthesize({ text: result.reply, lang });
      if (tts && tts.ok) {
        audio = {
          audio_base64: tts.audio_base64,
          mime_type: tts.mime_type,
          voice: tts.voice,
          engine: 'kokoro-onnx',
        };
      }
    }

    return res.status(200).json(Object.assign({ ok: true, audio }, result));
  } catch (err) {
    const status = err.statusCode || 500;
    return res.status(status).json({ error: err.message || 'Could not process conversation turn' });
  }
});

app.get('/api/receptionist/sessions/:sessionId', requireStoreReady, private_api, async (req, res) => {
  try {
    const state = browserReceptionist.getSessionState({
      sessionId: req.params.sessionId,
      clinicId: req.user.clinic,
    });
    if (!state) {
      return res.status(404).json({ error: 'Simulation session not found' });
    }
    return res.status(200).json(Object.assign({ ok: true }, state));
  } catch (err) {
    return res.status(500).json({ error: 'Could not load simulation session' });
  }
});

app.post('/api/receptionist/sessions/:sessionId/audio', receptionistAudioLimiter.middleware, requireStoreReady, private_api, requireActiveSubscription, async (req, res) => {
  try {
    const body = req.body || {};
    const userClinic = req.user.clinic;
    const sess = browserReceptionist.getSessionForClinic(req.params.sessionId, userClinic);
    if (!sess) {
      return res.status(404).json({ error: 'Simulation session not found' });
    }

    if (!body.audio_base64 || typeof body.audio_base64 !== 'string') {
      return res.status(400).json({ error: 'audio_base64 is required' });
    }

    const sttLang = sess.language === 'en' ? 'en' : (sess.language === 'hi' ? 'hi' : null);
    const stt = await localVoice.transcribe({
      audio_base64: body.audio_base64,
      mime_type: body.mime_type || 'audio/webm',
      language: sttLang,
    });

    if (!stt || !stt.ok) {
      return res.status(503).json({
        ok: false,
        fallback: true,
        code: 'LOCAL_STT_UNAVAILABLE',
        error: (stt && stt.error) || 'Local speech recognition failed. Please use text input fallback.',
      });
    }

    const transcript = String(stt.text || '').trim();
    const result = await browserReceptionist.processTurn({
      sessionId: req.params.sessionId,
      clinicId: userClinic,
      text: transcript,
    });

    let audio = null;
    if (body.speak !== false && result.reply) {
      const tts = await localVoice.synthesize({ text: result.reply, lang: sess.language });
      if (tts && tts.ok) {
        audio = {
          audio_base64: tts.audio_base64,
          mime_type: tts.mime_type,
          voice: tts.voice,
          engine: 'kokoro-onnx',
        };
      }
    }

    return res.status(200).json(Object.assign({
      ok: true,
      transcript,
      detected_language: stt.language || '',
      stt_engine: 'faster-whisper',
      audio,
    }, result));
  } catch (err) {
    const status = err.statusCode || 500;
    console.error('Receptionist audio turn failed:', err.message);
    return res.status(status).json({ error: err.message || 'Could not process audio turn' });
  }
});

app.post('/api/receptionist/sessions/:sessionId/end', requireStoreReady, private_api, async (req, res) => {
  try {
    const result = await browserReceptionist.endSession({
      sessionId: req.params.sessionId,
      clinicId: req.user.clinic,
    });
    if (!result) {
      return res.status(404).json({ error: 'Simulation session not found' });
    }
    return res.status(200).json(Object.assign({ ok: true }, result));
  } catch (err) {
    return res.status(500).json({ error: 'Could not end simulation session' });
  }
});

// ---- leads (Phase D marketing site) --------------------------------------
// Public demo-request form. No auth (it is on the public landing page), but it
// is protected by an in-process rate limiter, a honeypot field and strict
// server-side validation. Leads persist through the same store as everything
// else (MongoDB when configured, in-memory otherwise).
const LEAD_WINDOW_MS = 10 * 60 * 1000;   // 10 minutes
const LEAD_MAX_PER_IP = 5;               // max demo requests per IP per window
const leadHits = new Map();              // ip -> [timestamps]

function leadRateLimited(ip) {
  const now = Date.now();
  const arr = (leadHits.get(ip) || []).filter(t => now - t < LEAD_WINDOW_MS);
  if (arr.length >= LEAD_MAX_PER_IP) {
    leadHits.set(ip, arr);
    return true;
  }
  arr.push(now);
  leadHits.set(ip, arr);
  // keep the map from growing without bound
  if (leadHits.size > 5000) {
    for (const [k, v] of leadHits) if (!v.some(t => now - t < LEAD_WINDOW_MS)) leadHits.delete(k);
  }
  return false;
}
// Test-only seam: lets the test suite reset the limiter between cases without
// affecting production behaviour.
app.locals.__resetLeadLimiter = () => leadHits.clear();
app.locals.__resetVoiceRateLimiters = () => {
  voiceWebhookLimiter.reset();
  voiceSessionLimiter.reset();
  voiceBookingLimiter.reset();
  receptionistSessionLimiter.reset();
  receptionistAudioLimiter.reset();
};
app.locals.__resetReceptionistLimiters = () => {
  receptionistSessionLimiter.reset();
  receptionistAudioLimiter.reset();
};
app.locals.shutdownLocalVoice = () => localVoice.shutdown();
app.locals.maskPhone = maskPhone;
app.locals.store = store;
app.locals.storeReady = () => {
  if (!storeInitialized) return false;
  if (storeKind === 'mongo') {
    return Boolean(mongoose.connection && mongoose.connection.readyState === 1);
  }
  return true;
};
app.locals.storeReadyPromise = storeReadyPromise;
app.locals.notifyClinic = notifyClinic;
app.locals.__setTwilioClient = (client, from, to) => {
  twilioClient = client;
  if (from !== undefined) whatsappFrom = from;
  if (to !== undefined) clinicTo = to;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
// Accept Indian and international formats: optional +, 7-15 digits, spaces/dashes allowed.
const cleanDigits = (s) => String(s || '').replace(/[^\d]/g, '');
const isValidPhone = (s) => { const d = cleanDigits(s); return d.length >= 7 && d.length <= 15; };

app.post('/api/leads', async (req, res) => {
  const body = req.body || {};
  const ip = req.ip || req.socket?.remoteAddress || '';

  // Honeypot: a hidden field only bots fill in. Silently accept so bots think
  // it worked, but do not store anything.
  if (String(body.company_website || '').trim()) {
    return res.status(201).json({ ok: true });
  }

  if (leadRateLimited(ip)) {
    return res.status(429).json({ error: 'बहुत ज़्यादा requests। कृपया कुछ देर बाद कोशिश करें। (Too many requests, please try again later.)' });
  }

  const name = String(body.name || '').trim();
  const email = String(body.email || '').trim();
  const phone = String(body.phone || '').trim();
  const clinicNameInput = String(body.clinic_name !== undefined ? body.clinic_name : (body.clinic || '')).trim();
  const message = String(body.message || '').trim();
  const consent = body.consent === true || body.consent === 'true' || body.consent === 'on';

  // ---- validation (server-side; the browser check is only a convenience) --
  if (name.length < 2 || name.length > 100) {
    return res.status(400).json({ error: 'Please enter your name (2-100 characters).' });
  }
  if (!email || !EMAIL_RE.test(email) || email.length > 200) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }
  if (!phone || !isValidPhone(phone)) {
    return res.status(400).json({ error: 'Please enter a valid phone number.' });
  }
  if (!clinicNameInput || clinicNameInput.length < 2 || clinicNameInput.length > 150) {
    return res.status(400).json({ error: 'Please enter your clinic name (2-150 characters).' });
  }
  if (message.length > 2000) {
    return res.status(400).json({ error: 'Message is too long (max 2000 characters).' });
  }
  if (!consent) {
    return res.status(400).json({ error: 'Please agree to be contacted so we can respond.' });
  }

  try {
    const lead = await store.createLead({
      name,
      clinic_name: clinicNameInput,
      clinic: null,
      scope: 'platform',
      phone,
      email: email.toLowerCase(),
      message,
      source: String(body.source || 'landing').slice(0, 40),
      consent: true,
      ip: String(ip).slice(0, 64),
      user_agent: String(req.get('user-agent') || '').slice(0, 300),
      status: 'new',
    });
    // Do not echo the whole stored doc back to a public client.
    res.status(201).json({ ok: true, id: lead._id });
  } catch (err) {
    console.error('Lead capture failed:', err.message);
    res.status(500).json({ error: 'Could not save your request. Please try again.' });
  }
});

// Admin: view captured leads (dashboard only).
app.get('/api/leads', private_api, async (req, res) => {
  try {
    const userClinic = req.user.clinic;
    if (!userClinic) {
      return res.status(403).json({ error: 'Clinic not assigned. Configure clinic during onboarding before viewing leads.' });
    }
    const filter = { clinic: userClinic };
    res.json(await store.listLeads(filter));
  } catch (err) {
    console.error('Lead list failed:', err.message);
    res.status(500).json({ error: 'Could not load leads' });
  }
});

// ---- platform admin endpoints (Batch 4F) ---------------------------------
// Strict platform-level management endpoints. Gated by requirePlatformAdmin.
// Clinic owners, clinic staff, and unauthenticated requests are rejected.

// GET /api/platform/clinics - List all registered clinics
app.get('/api/platform/clinics', requirePlatformAdmin, async (req, res) => {
  try {
    const clinics = await store.listClinics();
    res.json(clinics);
  } catch (err) {
    console.error('Platform clinic list failed:', err.message);
    res.status(500).json({ error: 'Could not load clinics' });
  }
});

// GET /api/platform/clinics/:id - View clinic details
app.get('/api/platform/clinics/:id', requirePlatformAdmin, async (req, res) => {
  try {
    const clinic = await store.getClinic(req.params.id);
    if (!clinic) return res.status(404).json({ error: 'Clinic not found' });
    res.json(clinic);
  } catch (err) {
    console.error('Platform clinic details failed:', err.message);
    res.status(400).json({ error: 'Invalid clinic ID' });
  }
});

// PATCH /api/platform/clinics/:id - Activate or deactivate a clinic
app.patch('/api/platform/clinics/:id', requirePlatformAdmin, async (req, res) => {
  const { active } = req.body || {};
  if (typeof active !== 'boolean') {
    return res.status(400).json({ error: 'Field "active" must be a boolean' });
  }
  try {
    const updated = await store.saveClinic({ active }, { clinic: req.params.id });
    if (!updated) return res.status(404).json({ error: 'Clinic not found' });
    res.json(updated);
  } catch (err) {
    console.error('Platform clinic status update failed:', err.message);
    res.status(400).json({ error: 'Failed to update clinic status' });
  }
});

// GET /api/platform/leads - View platform-level marketing leads
app.get('/api/platform/leads', requirePlatformAdmin, async (req, res) => {
  try {
    const leads = await store.listPlatformLeads();
    res.json(leads);
  } catch (err) {
    console.error('Platform lead list failed:', err.message);
    res.status(500).json({ error: 'Could not load platform leads' });
  }
});

// GET /api/platform/subscriptions - Platform admin view of subscriptions across clinics
app.get('/api/platform/subscriptions', requirePlatformAdmin, async (req, res) => {
  try {
    const clinics = await store.listClinics();
    const results = (clinics || []).map(clinic => ({
      id: clinic._id || clinic.id,
      name: clinic.name,
      active: clinic.active !== false,
      subscription: clinic.subscription,
      evaluation: evaluateSubscription(clinic.subscription),
    }));
    res.json(results);
  } catch (err) {
    console.error('Platform subscriptions list failed:', err.message);
    res.status(500).json({ error: 'Could not load subscriptions' });
  }
});

// ---- analytics -----------------------------------------------------------
app.get('/api/analytics', private_api, async (req, res) => {
  try {
    const userClinic = req.user.clinic;
    if (!userClinic) {
      return res.status(403).json({ error: 'Clinic not assigned. Configure clinic during onboarding before viewing analytics.' });
    }
    const appointmentFilter = { clinic: userClinic };
    const callLogFilter = { clinic: userClinic };
    const [appointments, calls] = await Promise.all([
      store.listAppointments(appointmentFilter),
      store.listCallLogs(callLogFilter),
    ]);
    res.json(buildAnalytics(appointments, calls));
  } catch (err) {
    console.error('Analytics failed:', err.message);
    res.status(500).json({ error: 'Could not build analytics' });
  }
});

// ---- patients (grouped by phone, with visit history) ---------------------
app.get('/api/patients', private_api, async (req, res) => {
  try {
    const userClinic = req.user.clinic;
    if (!userClinic) {
      return res.status(403).json({ error: 'Clinic not assigned. Configure clinic during onboarding before viewing patients.' });
    }
    const filter = { clinic: userClinic };
    const appointments = await store.listAppointments(filter);
    const byPhone = new Map();
    for (const appt of appointments) {
      const phone = appt.phone || 'unknown';
      if (!byPhone.has(phone)) {
        byPhone.set(phone, { phone, name: appt.name || 'Unknown', visits: 0, lastVisit: null, statuses: [], history: [] });
      }
      const patient = byPhone.get(phone);
      patient.visits += 1;
      patient.history.push(appt);
      if (!patient.lastVisit || String(appt.createdAt) > String(patient.lastVisit)) {
        patient.lastVisit = appt.createdAt;
        patient.name = appt.name || patient.name;   // most recent name wins
      }
      if (!patient.statuses.includes(appt.status)) patient.statuses.push(appt.status);
    }
    const patients = [...byPhone.values()].sort((a, b) => String(b.lastVisit).localeCompare(String(a.lastVisit)));
    res.json(patients);
  } catch (err) {
    console.error('Patients failed:', err.message);
    res.status(500).json({ error: 'Could not load patients' });
  }
});

app.get('/api/stats', private_api, async (req, res) => {
  try {
    const filter = { clinic: req.user.clinic };
    res.json(await store.stats(filter));
  } catch (err) {
    console.error('Stats failed:', err.message);
    res.status(500).json({ error: 'Could not load stats' });
  }
});

if (process.env.NODE_ENV === 'test') {
  app.get('/api/test/sanitized-error', (req, res, next) => {
    const err = new Error('Database connection pool secret timeout at InternalDB.connect()');
    err.stack = 'SecretStack: Database connection pool secret timeout\n  at InternalDB.connect (/var/secret/db.js:10:5)';
    next(err);
  });
}

app.use((req, res) => res.status(404).json({ error: 'Unknown route: ' + req.path }));

// Sanitized Express error-handling middleware: prevents stack trace exposure to clients (P0-2)
app.use((err, req, res, next) => {
  console.error(`❌ Request Error [${req.method} ${req.path}]:`, err && err.stack ? err.stack : (err && err.message ? err.message : err));
  if (res.headersSent) {
    return next(err);
  }
  const status = Number(err.status || err.statusCode) || 500;
  const code = err.code || (status === 500 ? 'INTERNAL_SERVER_ERROR' : 'REQUEST_ERROR');
  const message = status < 500 ? (err.message || 'Request failed') : 'Internal server error';
  res.status(status).json({ error: message, code });
});

// ---- 6. go --------------------------------------------------------------
// Periodic cleanup of expired token blocklist entries (also handled by TTL
// index in MongoDB, but application-level cleanup ensures prompt reuse of jti).
setInterval(async () => {
  try {
    await store.clearExpiredTokenBlocklist();
  } catch {
    // best-effort cleanup; never crash the server
  }
}, 60 * 60 * 1000).unref();

// ---- 6. Graceful shutdown and process lifecycle (P0-2) --------------------
let isShuttingDown = false;

async function gracefulShutdown(serverInstance, { timeoutMs = 10000, exit = true, signal = 'SIGTERM', exitCode = null, closeDatabase = true } = {}) {
  if (isShuttingDown) {
    return { ok: false, alreadyShuttingDown: true };
  }
  isShuttingDown = true;
  const isFatal = signal === 'uncaughtException' || signal === 'unhandledRejection';
  const finalExitCode = exitCode !== null ? exitCode : (isFatal ? 1 : 0);
  console.log(`🛑 Received ${signal}, starting graceful shutdown...`);

  // Stop accepting new connections on the HTTP server
  const closeServerPromise = new Promise((resolve, reject) => {
    if (!serverInstance || typeof serverInstance.close !== 'function') {
      return resolve();
    }
    if (typeof serverInstance.closeIdleConnections === 'function') {
      try { serverInstance.closeIdleConnections(); } catch (_) {}
    }
    const idlePoll = setInterval(() => {
      if (typeof serverInstance.closeIdleConnections === 'function') {
        try { serverInstance.closeIdleConnections(); } catch (_) {}
      }
    }, 50);
    if (idlePoll.unref) idlePoll.unref();

    serverInstance.close((err) => {
      clearInterval(idlePoll);
      if (err && err.code !== 'ERR_SERVER_NOT_RUNNING') return reject(err);
      resolve();
    });
  });

  let timedOut = false;
  let timer = null;
  const timeoutPromise = new Promise((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      console.error(`⚠️ Graceful shutdown timed out after ${timeoutMs}ms.`);
      resolve();
    }, timeoutMs);
    if (timer && timer.unref) timer.unref();
  });

  try {
    await Promise.race([closeServerPromise, timeoutPromise]);

    if (!timedOut) {
      console.log('🔒 Closed HTTP server, in-flight requests completed.');
    }

    // Shut down local Python voice worker if running
    try {
      localVoice.shutdown();
    } catch (_) {}

    // Close MongoDB connection if open
    if (closeDatabase && mongoose.connection && mongoose.connection.readyState !== 0) {
      try {
        await mongoose.connection.close(false);
        console.log('📴 Closed MongoDB connection.');
      } catch (dbErr) {
        console.error('Error closing MongoDB connection:', dbErr.message);
      }
    }

    if (timer) clearTimeout(timer);

    if (timedOut) {
      console.error('❌ Shutdown timed out before all operations completed.');
      if (exit) process.exit(1);
      return { ok: false, timedOut: true, exitCode: 1 };
    }

    try { localVoice.shutdown(); } catch (_) {}
    console.log('✅ Graceful shutdown completed cleanly.');
    if (exit) process.exit(finalExitCode);
    return { ok: true, timedOut: false, exitCode: finalExitCode };
  } catch (err) {
    if (timer) clearTimeout(timer);
    console.error('❌ Error during graceful shutdown:', err.message);
    if (exit) process.exit(1);
    return { ok: false, error: err.message, timedOut, exitCode: 1 };
  }
}

function setupProcessLifecycle(httpServerInstance, { exitOnFatal = true } = {}) {
  const onShutdown = (signal) => {
    gracefulShutdown(httpServerInstance, { signal, exit: true, timeoutMs: 10000, exitCode: 0 });
  };

  const onFatalError = (err, origin) => {
    console.error(`💥 FATAL [${origin}]:`, err && err.stack ? err.stack : err);
    console.error(`Process uptime: ${Math.round(process.uptime())}s. Initiating emergency shutdown...`);
    gracefulShutdown(httpServerInstance, { signal: origin, exit: exitOnFatal, timeoutMs: 5000, exitCode: 1 });
  };

  process.on('SIGTERM', () => onShutdown('SIGTERM'));
  process.on('SIGINT', () => onShutdown('SIGINT'));
  process.on('uncaughtException', (err) => onFatalError(err, 'uncaughtException'));
  process.on('unhandledRejection', (reason) => onFatalError(reason, 'unhandledRejection'));
}

let httpServer = null;
if (require.main === module) {
  httpServer = app.listen(PORT, () => {
    console.log('===================================');
    console.log('MediBot backend running on port ' + PORT);
    console.log('Storage:', storeKind === 'mongo' ? 'MongoDB' : storeKind === 'file' ? 'file-backed (' + DATA_FILE + ')' : 'in-memory');
    console.log('Twilio webhook: POST /webhook/doctor-bot');
    console.log('Signature validation:', String(process.env.TWILIO_VALIDATE_SIGNATURE || '').toLowerCase() === 'true' ? 'ON' : 'off (set TWILIO_VALIDATE_SIGNATURE=true before going live)');
    console.log('Slot cap:', MAX_PER_SLOT > 0 ? MAX_PER_SLOT + ' per slot' : 'unlimited');
    console.log('Trust proxy:', app.get('trust proxy'));
    console.log('===================================');
  });

  setupProcessLifecycle(httpServer, { exitOnFatal: true });
}

app.maskPhone = maskPhone;
app.parseTrustProxy = parseTrustProxy;
app.gracefulShutdown = gracefulShutdown;
app.setupProcessLifecycle = setupProcessLifecycle;
app.getIsShuttingDown = () => isShuttingDown;
app.resetShutdownForTests = () => { isShuttingDown = false; };
module.exports = app;   // lets tests and scripts import the app without a 2nd listener
module.exports.maskPhone = maskPhone;
module.exports.parseTrustProxy = parseTrustProxy;
module.exports.gracefulShutdown = gracefulShutdown;
module.exports.setupProcessLifecycle = setupProcessLifecycle;
