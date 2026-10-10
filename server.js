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

const BotEngine = require('./bot-engine');
const { createConversation } = require('./conversation');
const { createMongoStore } = require('./store-mongo');
const { createMemoryStore } = require('./store-memory');
const { createAuth, requireAuth, ensureSeedAdmin } = require('./auth');
const { requireTwilioSignature } = require('./twilio-signature');

const PORT = process.env.PORT || 5000;
const MONGODB_URI = process.env.MONGODB_URI || '';
const MAX_PER_SLOT = parseInt(process.env.MAX_PER_SLOT || '0', 10);   // 0 = unlimited
const STORE_MODE = (process.env.STORE || 'auto').toLowerCase();       // auto | mongo | memory

const app = express();
app.set('trust proxy', 1);                       // correct https:// behind ngrok / Render
app.use(cors());
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ---- 2. storage ----------------------------------------------------------
mongoose.set('bufferTimeoutMS', 3000);           // fail fast, never freeze a live call

let activeStore = createMemoryStore();
let storeKind = 'memory';
const DELEGATED = ['getSession', 'saveSession', 'clearSession', 'findDuplicate', 'countBooked',
  'createAppointment', 'listAppointments', 'getAppointment', 'updateAppointmentStatus', 'stats',
  'countUsers', 'findUserByEmail', 'createUser', 'updateUserPassword', 'logCallTurn', 'listCallLogs'];
const store = {};
for (const method of DELEGATED) {
  store[method] = (...args) => activeStore[method](...args);
}

function storeReady() {
  return storeKind === 'memory' || mongoose.connection.readyState === 1;
}

async function initStore() {
  if (STORE_MODE === 'memory') {
    console.log('🧠 STORE=memory - using the in-memory store (data is lost on restart)');
    return;
  }
  if (!MONGODB_URI) {
    console.warn('⚠️  MONGODB_URI is not set - using the in-memory store instead.');
    console.warn('    Copy .env.example to .env and add your Atlas connection string to persist data.');
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
    console.warn('⚠️  Falling back to the in-memory store - bookings will NOT be saved to a database.');
    console.warn('    Fix MONGODB_URI in .env (create a free M0 cluster on cloud.mongodb.com) and restart.');
  }
}

const bot = createConversation({ store, maxPerSlot: MAX_PER_SLOT });
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

// ---- 5. routes ----------------------------------------------------------
// Login / register (public)
app.use('/api', authRouter);

app.get('/', (req, res) => {
  res.json({
    service: 'MediBot backend',
    status: 'ok',
    store: storeKind,
    database: storeKind === 'memory' ? 'in-memory (not persistent)' : (mongoose.connection.readyState === 1 ? 'connected' : 'connecting'),
    signature_validation: String(process.env.TWILIO_VALIDATE_SIGNATURE || '').toLowerCase() === 'true',
    endpoints: ['/webhook/doctor-bot', '/webhook/status', '/api/auth/login', '/api/appointments', '/api/calls', '/api/stats'],
  });
});

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    store: storeKind,
    database: mongoose.connection.readyState === 1,
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
    console.log('Storage:', storeKind === 'mongo' ? 'MongoDB' : 'in-memory');
    console.log('Twilio webhook: POST /webhook/doctor-bot');
    console.log('Signature validation:', String(process.env.TWILIO_VALIDATE_SIGNATURE || '').toLowerCase() === 'true' ? 'ON' : 'off (set TWILIO_VALIDATE_SIGNATURE=true before going live)');
    console.log('Slot cap:', MAX_PER_SLOT > 0 ? MAX_PER_SLOT + ' per slot' : 'unlimited');
    console.log('===================================');
  });
}

module.exports = app;   // lets tests and scripts import the app without a 2nd listener
