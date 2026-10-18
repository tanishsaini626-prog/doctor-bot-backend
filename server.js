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
const { createMongoStore } = require('./store-mongo');
const { createMemoryStore } = require('./store-memory');
const { createFileStore } = require('./store-file');
const { createAuth, requireAuth, ensureSeedAdmin } = require('./auth');
const { requireTwilioSignature } = require('./twilio-signature');

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
const MONGODB_URI = assertEnv('MONGODB_URI');   // fail fast if missing in production
const MAX_PER_SLOT = parseInt(process.env.MAX_PER_SLOT || '0', 10);   // 0 = unlimited
const STORE_MODE = (process.env.STORE || 'auto').toLowerCase();       // auto | mongo | file | memory
// Where the file-backed store keeps its JSON (ignored by git via .data/).
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, '.data', 'store.json');

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
app.use(express.json({ limit: process.env.REQUEST_SIZE_LIMIT || '100kb' }));

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
const DELEGATED = ['getSession', 'saveSession', 'clearSession', 'findDuplicate', 'countBooked',
  'createAppointment', 'listAppointments', 'getAppointment', 'updateAppointmentStatus', 'stats',
  'countUsers', 'findUserByEmail', 'createUser', 'updateUserPassword', 'logCallTurn', 'listCallLogs',
  'listDoctors', 'createDoctor', 'updateDoctor', 'deleteDoctor', 'getClinic', 'saveClinic',
  'createLead', 'listLeads'];
const store = {};
for (const method of DELEGATED) {
  store[method] = (...args) => activeStore[method](...args);
}

function storeReady() {
  return storeKind === 'memory' || storeKind === 'file' || mongoose.connection.readyState === 1;
}

async function initStore() {
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
    await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
    activeStore = createMongoStore();
    storeKind = 'mongo';
    console.log('✅ Connected to MongoDB - data will persist');
  } catch (err) {
    console.error('❌ MongoDB connection failed:', err.message);
    if (STORE_MODE === 'mongo') {
      console.error('   STORE=mongo was requested, so the server will not start.');
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
const { router: authRouter } = createAuth(store);

// ---- 2b. admin account ---------------------------------------------------
// JWT_SECRET is required in .env (generate one, never commit it). The first
// admin is created automatically so a fresh install can log in immediately.
initStore().then(async () => {
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
});

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
  if (!twilioClient || !clinicTo) return;
  try {
    await twilioClient.messages.create({
      from: whatsappFrom,
      to: clinicTo,
      body: bot.whatsappText(appointment),
    });
  } catch (err) {
    console.error('WhatsApp notification failed:', err.message);   // never break the call
  }
}

// ---- 4. helpers ---------------------------------------------------------
function actionUrl(req) {
  const proto = req.get('x-forwarded-proto') || req.protocol || 'https';
  return `${proto}://${req.get('host')}${req.path}`;
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

// Phone rings -> fresh session -> greeting + first question.
app.get('/webhook/doctor-bot', twilioSignature, async (req, res) => {
  const callSid = (req.query.CallSid) || (req.body && req.body.CallSid) || '';
  try {
    if (storeReady()) await store.clearSession(callSid);   // re-calling starts a clean conversation
  } catch (err) {
    console.error('Could not clear session:', err.message);
  }
  console.log('📞 Incoming call', callSid || '(no sid)', 'from', req.query.From || (req.body && req.body.From) || '');
  twiml(res, bot.greetingTwiml(actionUrl(req)));
});

// Every speech turn.
app.post('/webhook/doctor-bot', twilioSignature, async (req, res) => {
  const body = req.body || {};
  const callSid = body.CallSid || '';
  const from = body.From || '';
  const transcript = body.SpeechResult || '';
  console.log('🎙️ ', callSid || '(no sid)', '| caller:', JSON.stringify(transcript));

  try {
    const result = await bot.handleTurn({
      callSid,
      from,
      transcript,
      actionUrl: actionUrl(req),
      notifyClinic,
    });
    // keep a searchable call log (transcript + what the bot did)
    try {
      await store.logCallTurn(callSid, {
        phone: from,
        transcript,
        bot_action: result.status === 'Confirmed' ? 'booked'
          : result.asked_field ? 'asked:' + result.asked_field
          : String(result.status || 'ended').toLowerCase(),
      });
    } catch (logErr) {
      console.error('Call log failed:', logErr.message);   // never break the call
    }
    twiml(res, result.twiml);
  } catch (err) {
    // A crashed webhook would drop the call - always answer with valid TwiML.
    console.error('Turn failed:', err);
    twiml(res, BotEngine.wrapTwiml(
      BotEngine.say('क्षमा कीजिए, तकनीकी दिक्कत आ गई है। कृपया बाद में कॉल कीजिए।') + BotEngine.hangup()
    ));
  }
});

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
    console.log('📴 Call', body.CallSid, body.CallStatus, '->', result.status || 'no change');
    res.json(result);
  } catch (err) {
    console.error('Status callback failed:', err.message);
    res.status(500).json({ error: 'status callback failed' });
  }
});

// Dashboard APIs are private (Bearer JWT from /api/auth/login)
const private_api = requireAuth;

app.get('/api/appointments', private_api, async (req, res) => {
  try {
    const list = await store.listAppointments({
      status: req.query.status,
      q: req.query.q,
      date: req.query.date,
      limit: req.query.limit,
    });
    res.json(list);
  } catch (err) {
    console.error('List failed:', err.message);
    res.status(500).json({ error: 'Could not load appointments' });
  }
});

app.get('/api/appointments/:id', private_api, async (req, res) => {
  try {
    const one = await store.getAppointment(req.params.id);
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
    const updated = await store.updateAppointmentStatus(req.params.id, status);
    if (!updated) return res.status(404).json({ error: 'Not found' });
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: 'Invalid id' });
  }
});

// Call log for the dashboard (transcripts + what the bot did)
app.get('/api/calls', private_api, async (req, res) => {
  try {
    const list = await store.listCallLogs({ limit: req.query.limit });
    res.json(list);
  } catch (err) {
    console.error('Call log list failed:', err.message);
    res.status(500).json({ error: 'Could not load call logs' });
  }
});

// ---- doctors -------------------------------------------------------------
app.get('/api/doctors', private_api, async (req, res) => {
  try {
    res.json(await store.listDoctors());
  } catch (err) {
    res.status(500).json({ error: 'Could not load doctors' });
  }
});

app.post('/api/doctors', private_api, async (req, res) => {
  const body = req.body || {};
  if (!body.name || !String(body.name).trim()) {
    return res.status(400).json({ error: 'Doctor name is required' });
  }
  const slot = parseInt(body.slot_minutes, 10);
  if (body.slot_minutes !== undefined && (!slot || slot < 5 || slot > 120)) {
    return res.status(400).json({ error: 'slot_minutes must be between 5 and 120' });
  }
  try {
    const doctor = await store.createDoctor({
      name: String(body.name).trim(),
      specialty: body.specialty ? String(body.specialty).trim() : 'General Physician',
      slot_minutes: slot || 15,
      working_hours: Array.isArray(body.working_hours) ? body.working_hours : undefined,
      holidays: Array.isArray(body.holidays) ? body.holidays : [],
      active: body.active !== false,
    });
    res.status(201).json(doctor);
  } catch (err) {
    res.status(500).json({ error: 'Could not create the doctor' });
  }
});

app.patch('/api/doctors/:id', private_api, async (req, res) => {
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
  if (body.working_hours !== undefined) patch.working_hours = body.working_hours;
  if (body.holidays !== undefined) patch.holidays = body.holidays;
  if (body.active !== undefined) patch.active = !!body.active;
  if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nothing to update' });
  try {
    const updated = await store.updateDoctor(req.params.id, patch);
    if (!updated) return res.status(404).json({ error: 'Doctor not found' });
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: 'Could not update the doctor' });
  }
});

app.delete('/api/doctors/:id', private_api, async (req, res) => {
  try {
    const removed = await store.deleteDoctor(req.params.id);
    if (!removed) return res.status(404).json({ error: 'Doctor not found' });
    res.json({ deleted: true });
  } catch (err) {
    res.status(400).json({ error: 'Could not delete the doctor' });
  }
});

// ---- clinic settings -----------------------------------------------------
app.get('/api/clinic', private_api, async (req, res) => {
  try {
    const clinic = await store.getClinic();
    res.json(clinic || {
      name: 'Dr. Sharma Clinic', phone: '', whatsapp_to: '',
      greeting_text: 'नमस्ते! मैं डॉ. शर्मा क्लिनिक से बोल रही हूँ। अपॉइंटमेंट बुक करने के लिए कृपया अपना पूरा नाम बताइए।',
      languages: ['hi-IN'], timezone: 'Asia/Kolkata',
    });
  } catch (err) {
    res.status(500).json({ error: 'Could not load the clinic' });
  }
});

app.patch('/api/clinic', private_api, async (req, res) => {
  const body = req.body || {};
  const patch = {};
  for (const field of ['name', 'phone', 'whatsapp_to', 'greeting_text', 'timezone']) {
    if (body[field] !== undefined) patch[field] = String(body[field]);
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
    res.json(await store.saveClinic(patch));
  } catch (err) {
    res.status(500).json({ error: 'Could not save the clinic settings' });
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
  const clinic = String(body.clinic || '').trim();
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
  if (clinic.length > 150) {
    return res.status(400).json({ error: 'Clinic name is too long.' });
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
      clinic,
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
    res.json(await store.listLeads({ limit: req.query.limit }));
  } catch (err) {
    console.error('Lead list failed:', err.message);
    res.status(500).json({ error: 'Could not load leads' });
  }
});

// ---- analytics -----------------------------------------------------------
app.get('/api/analytics', private_api, async (req, res) => {
  try {
    const [appointments, calls] = await Promise.all([
      store.listAppointments({ limit: 500 }),
      store.listCallLogs({ limit: 500 }),
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
    const appointments = await store.listAppointments({ limit: 500 });
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
    res.json(await store.stats());
  } catch (err) {
    console.error('Stats failed:', err.message);
    res.status(500).json({ error: 'Could not load stats' });
  }
});

app.use((req, res) => res.status(404).json({ error: 'Unknown route: ' + req.path }));

// ---- 6. go --------------------------------------------------------------
if (require.main === module) {
  app.listen(PORT, () => {
    console.log('===================================');
    console.log('MediBot backend running on port ' + PORT);
    console.log('Storage:', storeKind === 'mongo' ? 'MongoDB' : storeKind === 'file' ? 'file-backed (' + DATA_FILE + ')' : 'in-memory');
    console.log('Twilio webhook: POST /webhook/doctor-bot');
    console.log('Signature validation:', String(process.env.TWILIO_VALIDATE_SIGNATURE || '').toLowerCase() === 'true' ? 'ON' : 'off (set TWILIO_VALIDATE_SIGNATURE=true before going live)');
    console.log('Slot cap:', MAX_PER_SLOT > 0 ? MAX_PER_SLOT + ' per slot' : 'unlimited');
    console.log('===================================');
  });
}

module.exports = app;   // lets tests and scripts import the app without a 2nd listener
