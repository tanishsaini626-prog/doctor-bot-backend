'use strict';
/* ==========================================================================
 * test-twilio-webhook-resolution.js - Batch 4B Multi-Tenant Twilio Webhook Resolution Tests
 *
 * Verifies:
 * 1. Resolving incoming Twilio 'To' number to exactly one active clinic.
 * 2. Normalization of varied phone formats.
 * 3. Rejection of unknown, inactive, or duplicate/ambiguous numbers.
 * 4. Propagation of trusted clinic ID to bot.handleTurn and appointment creation.
 * 5. Scoping of doctorProvider to the calling clinic (Clinic A cannot book against Clinic B's doctors).
 * 6. Correct clinic ownership for Confirmed, Emergency, and Abandoned appointments.
 * 7. Call logs contain correct clinic ownership and are isolated.
 * 8. Rejection of caller-supplied clinic IDs (untrusted).
 * 9. Twilio signature enforcement on webhook routes.
 * 10. Memory, file, and dedicated MongoDB (when TEST_MONGODB_URI available) testing.
 * ========================================================================== */

const { test, describe, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-must-be-at-least-32-chars-long-012345';

const BotEngine = require('./bot-engine');
const { createConversation } = require('./conversation');
const { requireTwilioSignature, computeSignature } = require('./twilio-signature');
const { createMemoryStore } = require('./store-memory');
const { createFileStore } = require('./store-file');
const { normalizePhone } = require('./phone');

const CLINIC_A_ID = '507f1f77bcf86cd799439011';
const CLINIC_B_ID = '507f1f77bcf86cd799439022';
const INACTIVE_CLINIC_ID = '507f1f77bcf86cd799439033';
const DUP1_CLINIC_ID = '507f1f77bcf86cd799439044';
const DUP2_CLINIC_ID = '507f1f77bcf86cd799439055';

const PHONE_CLINIC_A = '+91 91111 11111';
const PHONE_CLINIC_B = '+91 92222 22222';
const PHONE_INACTIVE = '+91 93333 33333';
const PHONE_AMBIGUOUS = '+91 94444 44444';
const PHONE_UNKNOWN = '+91 99999 99999';

// Setup clinics in store helper
async function seedClinicsAndDoctors(store) {
  // Clinic A
  await store.saveClinic({
    name: 'Alpha Care Clinic',
    phone: PHONE_CLINIC_A,
    greeting_text: 'नमस्ते! मैं अल्फा केयर क्लिनिक से बोल रही हूँ।',
    active: true,
  }, { clinic: CLINIC_A_ID, create: true });

  // Clinic B
  await store.saveClinic({
    name: 'Beta Health Clinic',
    phone: PHONE_CLINIC_B,
    greeting_text: 'नमस्ते! मैं बीटा हेल्थ क्लिनिक से बोल रही हूँ।',
    active: true,
  }, { clinic: CLINIC_B_ID, create: true });

  // Inactive Clinic
  await store.saveClinic({
    name: 'Inactive Clinic',
    phone: PHONE_INACTIVE,
    active: false,
  }, { clinic: INACTIVE_CLINIC_ID, create: true });

  // Duplicate / Ambiguous clinics sharing the same number
  await store.saveClinic({
    name: 'Duplicate Clinic 1',
    phone: PHONE_AMBIGUOUS,
    active: true,
  }, { clinic: DUP1_CLINIC_ID, create: true });

  await store.saveClinic({
    name: 'Duplicate Clinic 2',
    phone: PHONE_AMBIGUOUS,
    active: false,
  }, { clinic: DUP2_CLINIC_ID, create: true });

  // Doctor for Clinic A: works Monday (day 1) from 09:00 to 21:00
  await store.createDoctor({
    name: 'Dr. Alpha Sharma',
    specialty: 'General Physician',
    working_hours: [{ day: 1, start: '09:00', end: '21:00' }],
    holidays: [],
    active: true,
  }, { clinic: CLINIC_A_ID });

  // Doctor for Clinic B: OFF on Monday (day 1 working_hours empty, works Tuesday day 2)
  await store.createDoctor({
    name: 'Dr. Beta Varma',
    specialty: 'Cardiologist',
    working_hours: [{ day: 2, start: '09:00', end: '21:00' }],
    holidays: [],
    active: true,
  }, { clinic: CLINIC_B_ID });
}

// Helper to create an ephemeral express server with webhook routes
function createWebhookTestServer(store, options = {}) {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  const twilioSignatureMw = requireTwilioSignature(options.signatureOpts);

  async function doctorProvider(clinicId) {
    if (!clinicId) return null;
    const doctors = await store.listDoctors({ clinic: clinicId });
    const active = (doctors || []).filter(d => d.active !== false);
    return active[0] || null;
  }

  const bot = createConversation({
    store,
    maxPerSlot: options.maxPerSlot || 0,
    confirmBeforeBooking: options.confirmBeforeBooking !== false,
    doctorProvider,
    now: options.now || (() => new Date('2026-06-22T10:00:00Z')), // Monday
  });

  function actionUrl(req) {
    const proto = req.get('x-forwarded-proto') || req.protocol || 'http';
    return `${proto}://${req.get('host')}${req.path}`;
  }

  function twiml(res, xml, code = 200) {
    res.status(code).set('Content-Type', 'application/xml').send(xml);
  }

  // GET /webhook/doctor-bot
  app.get('/webhook/doctor-bot', twilioSignatureMw, async (req, res) => {
    const callSid = req.query.CallSid || (req.body && req.body.CallSid) || '';
    const from = req.query.From || (req.body && req.body.From) || '';
    const to = req.query.To || (req.body && req.body.To) || '';

    let resolution = null;
    if (to) {
      try {
        resolution = await store.resolveClinicByPhone(to);
      } catch (err) {
        console.error('Resolution error:', err.message);
      }
    }

    if (!resolution || !resolution.ok) {
      const reason = resolution ? resolution.reason : 'unknown';
      let refusalMsg = 'क्षमा कीजिए, यह नंबर किसी भी क्लिनिक से जुड़ा नहीं है। धन्यवाद!';
      if (reason === 'inactive') {
        refusalMsg = 'यह क्लिनिक इस समय सक्रिय नहीं है। कृपया बाद में कॉल कीजिए। धन्यवाद!';
      } else if (reason === 'ambiguous') {
        refusalMsg = 'क्षमा कीजिए, तकनीकी दिक्कत आ गई है। कृपया बाद में कॉल कीजिए।';
      }
      res.set('X-Clinic-Resolved', 'false').set('X-Clinic-Reject-Reason', reason);
      return twiml(res, BotEngine.wrapTwiml(BotEngine.say(refusalMsg) + BotEngine.hangup()));
    }

    const clinic = resolution.clinic;
    const clinicId = clinic._id;

    await store.clearSession(callSid);
    await store.saveSession({ call_sid: callSid, phone: from, to, clinic: clinicId });
    await store.logCallTurn(callSid, { phone: from, clinic: clinicId, status: 'in-progress' });

    res.set('X-Clinic-Resolved', 'true').set('X-Clinic-Id', String(clinicId));
    const greeting = clinic.greeting_text || undefined;
    twiml(res, bot.greetingTwiml(actionUrl(req), { greeting }));
  });

  // POST /webhook/doctor-bot
  app.post('/webhook/doctor-bot', twilioSignatureMw, async (req, res) => {
    const body = req.body || {};
    const callSid = body.CallSid || req.query.CallSid || '';
    const from = body.From || req.query.From || '';
    const to = body.To || req.query.To || '';
    const transcript = body.SpeechResult || '';

    let session = null;
    if (callSid) session = await store.getSession(callSid);

    let resolution = null;
    if (to) {
      try {
        resolution = await store.resolveClinicByPhone(to);
      } catch (err) {
        console.error('Resolution error:', err.message);
      }
    }

    let clinic = null;
    if (resolution && resolution.ok) {
      clinic = resolution.clinic;
    } else if (!to && session && session.clinic) {
      clinic = await store.getClinic(session.clinic);
    }

    if (!clinic) {
      const reason = resolution ? resolution.reason : 'unknown';
      let refusalMsg = 'क्षमा कीजिए, यह नंबर किसी भी क्लिनिक से जुड़ा नहीं है। धन्यवाद!';
      if (reason === 'inactive') {
        refusalMsg = 'यह क्लिनिक इस समय सक्रिय नहीं है। कृपया बाद में कॉल कीजिए। धन्यवाद!';
      } else if (reason === 'ambiguous') {
        refusalMsg = 'क्षमा कीजिए, तकनीकी दिक्कत आ गई है। कृपया बाद में कॉल कीजिए।';
      }
      res.set('X-Clinic-Resolved', 'false').set('X-Clinic-Reject-Reason', reason);
      return twiml(res, BotEngine.wrapTwiml(BotEngine.say(refusalMsg) + BotEngine.hangup()));
    }

    const clinicId = clinic._id;
    const result = await bot.handleTurn({
      callSid,
      from,
      to,
      clinic: clinicId,
      transcript,
      actionUrl: actionUrl(req),
    });

    await store.logCallTurn(callSid, {
      phone: from,
      clinic: clinicId,
      transcript,
      bot_action: result.status === 'Confirmed' ? 'booked'
        : result.asked_field ? 'asked:' + result.asked_field
        : String(result.status || 'ended').toLowerCase(),
    });

    res.set('X-Clinic-Resolved', 'true').set('X-Clinic-Id', String(clinicId));
    twiml(res, result.twiml);
  });

  // POST /webhook/status
  app.post('/webhook/status', twilioSignatureMw, async (req, res) => {
    const body = req.body || {};
    const callSid = body.CallSid || '';
    const to = body.To || '';

    let session = null;
    if (callSid) session = await store.getSession(callSid);

    let clinicId = (session && session.clinic) || null;
    if (!clinicId && to) {
      const resolution = await store.resolveClinicByPhone(to);
      if (resolution && resolution.ok) clinicId = resolution.clinic._id;
    }

    const result = await bot.handleStatus({
      callSid,
      callStatus: body.CallStatus,
      clinic: clinicId,
    });

    if (callSid) {
      await store.logCallTurn(callSid, {
        clinic: clinicId,
        status: String(body.CallStatus || '').toLowerCase() === 'completed' ? 'completed' : 'ended',
        duration_seconds: parseInt(body.CallDuration || '0', 10) || 0,
      });
    }

    res.json(result);
  });

  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        base: `http://127.0.0.1:${port}`,
        bot,
        close: () => new Promise((r) => {
          if (typeof server.closeAllConnections === 'function') {
            server.closeAllConnections();
          }
          server.close(r);
        }),
      });
    });
  });
}

// ============================================================================
// SUITE 1: DIRECT STORE PHONE RESOLUTION TESTS
// ============================================================================
function runStoreResolutionSuite(storeFactory, storeName) {
  describe(`Store Phone Resolution: ${storeName}`, () => {
    let store;
    let tempDir = null;

    beforeEach(async () => {
      if (storeName === 'file') {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'twilio-res-test-'));
        store = storeFactory(path.join(tempDir, 'store.json'));
      } else if (storeName === 'mongo') {
        const { Clinic, Doctor } = require('./models');
        await Promise.all([
          Clinic.deleteMany({}),
          Doctor.deleteMany({}),
        ]);
        store = storeFactory();
      } else {
        store = storeFactory();
      }
      await seedClinicsAndDoctors(store);
    });

    afterEach(() => {
      if (tempDir && fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    test('Clinic A number resolves to Clinic A regardless of input format', async () => {
      // Formats: +91 91111 11111, +919111111111, 9111111111, 09111111111
      const formats = ['+91 91111 11111', '+919111111111', '9111111111', '09111111111'];
      for (const num of formats) {
        const res = await store.resolveClinicByPhone(num);
        assert.equal(res.ok, true, `Format ${num} must resolve ok: true`);
        assert.equal(res.clinic.name, 'Alpha Care Clinic');
        assert.equal(String(res.clinic._id), CLINIC_A_ID);

        const clinic = await store.getClinicByPhone(num);
        assert.ok(clinic);
        assert.equal(clinic.name, 'Alpha Care Clinic');
      }
    });

    test('Clinic B number resolves to Clinic B', async () => {
      const res = await store.resolveClinicByPhone(PHONE_CLINIC_B);
      assert.equal(res.ok, true);
      assert.equal(res.clinic.name, 'Beta Health Clinic');
      assert.equal(String(res.clinic._id), CLINIC_B_ID);

      const clinic = await store.getClinicByPhone(PHONE_CLINIC_B);
      assert.ok(clinic);
      assert.equal(clinic.name, 'Beta Health Clinic');
    });

    test('Unknown number is rejected safely', async () => {
      const res = await store.resolveClinicByPhone(PHONE_UNKNOWN);
      assert.equal(res.ok, false);
      assert.equal(res.reason, 'unknown');
      assert.equal(res.clinic, null);

      const clinic = await store.getClinicByPhone(PHONE_UNKNOWN);
      assert.equal(clinic, null);
    });

    test('Inactive clinic number is rejected', async () => {
      const res = await store.resolveClinicByPhone(PHONE_INACTIVE);
      assert.equal(res.ok, false);
      assert.equal(res.reason, 'inactive');
      assert.ok(res.clinic, 'Inactive clinic document is returned for inspection');
      assert.equal(res.clinic.active, false);

      // getClinicByPhone without opts returns null for inactive
      const clinic = await store.getClinicByPhone(PHONE_INACTIVE);
      assert.equal(clinic, null);

      // getClinicByPhone with includeInactive returns the clinic
      const inactiveDoc = await store.getClinicByPhone(PHONE_INACTIVE, { includeInactive: true });
      assert.ok(inactiveDoc);
      assert.equal(inactiveDoc.active, false);
    });

    test('Duplicate phone-number mappings are rejected as ambiguous', async () => {
      const res = await store.resolveClinicByPhone(PHONE_AMBIGUOUS);
      assert.equal(res.ok, false);
      assert.equal(res.reason, 'ambiguous');
      assert.equal(res.count, 2);

      await assert.rejects(
        async () => store.getClinicByPhone(PHONE_AMBIGUOUS),
        /Ambiguous clinic phone number/
      );
    });
  });
}

runStoreResolutionSuite(() => createMemoryStore(), 'memory');
runStoreResolutionSuite((filePath) => createFileStore(filePath), 'file');

// ============================================================================
// SUITE 2: HTTP TWILIO VOICE WEBHOOK RESOLUTION & SCOPING TESTS
// ============================================================================
describe('HTTP Twilio Webhook Resolution & Scoping', () => {
  let serverCtx;
  let store;

  before(async () => {
    store = createMemoryStore();
    await seedClinicsAndDoctors(store);
    serverCtx = await createWebhookTestServer(store, {
      signatureOpts: { enabled: false }, // signature tested separately
      now: () => new Date('2026-06-22T10:00:00Z'), // Monday
    });
  });

  after(async () => {
    if (serverCtx && serverCtx.close) {
      await serverCtx.close();
    }
  });

  test('GET /webhook/doctor-bot resolves Clinic A and returns Clinic A greeting', async () => {
    const res = await fetch(`${serverCtx.base}/webhook/doctor-bot?CallSid=CA-A1&From=%2B919000000001&To=${encodeURIComponent('+919111111111')}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-clinic-resolved'), 'true');
    assert.equal(res.headers.get('x-clinic-id'), CLINIC_A_ID);
    const xml = await res.text();
    assert.match(xml, /अल्फा केयर क्लिनिक/);

    // Verify session stored with Clinic A ID
    const session = await store.getSession('CA-A1');
    assert.ok(session);
    assert.equal(session.clinic, CLINIC_A_ID);

    // Verify CallLog created with Clinic A ID
    const logs = await store.listCallLogs({ clinic: CLINIC_A_ID });
    assert.ok(logs.some(l => l.call_sid === 'CA-A1'));
  });

  test('GET /webhook/doctor-bot resolves Clinic B and returns Clinic B greeting', async () => {
    const res = await fetch(`${serverCtx.base}/webhook/doctor-bot?CallSid=CA-B1&From=%2B919000000002&To=${encodeURIComponent('+919222222222')}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-clinic-resolved'), 'true');
    assert.equal(res.headers.get('x-clinic-id'), CLINIC_B_ID);
    const xml = await res.text();
    assert.match(xml, /बीटा हेल्थ क्लिनिक/);

    const session = await store.getSession('CA-B1');
    assert.equal(session.clinic, CLINIC_B_ID);

    // Call logs isolated
    const logsB = await store.listCallLogs({ clinic: CLINIC_B_ID });
    assert.ok(logsB.some(l => l.call_sid === 'CA-B1'));
    assert.ok(!logsB.some(l => l.call_sid === 'CA-A1'));
  });

  test('GET /webhook/doctor-bot rejects unknown number safely', async () => {
    const res = await fetch(`${serverCtx.base}/webhook/doctor-bot?CallSid=CA-UNK&From=%2B919000000003&To=${encodeURIComponent(PHONE_UNKNOWN)}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-clinic-resolved'), 'false');
    assert.equal(res.headers.get('x-clinic-reject-reason'), 'unknown');
    const xml = await res.text();
    assert.match(xml, /<Hangup\/>/);
    assert.match(xml, /क्लिनिक से जुड़ा नहीं है/);

    const session = await store.getSession('CA-UNK');
    assert.equal(session, null, 'No session must be stored for unknown clinic numbers');
  });

  test('GET /webhook/doctor-bot rejects inactive clinic number', async () => {
    const res = await fetch(`${serverCtx.base}/webhook/doctor-bot?CallSid=CA-INA&From=%2B919000000004&To=${encodeURIComponent(PHONE_INACTIVE)}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-clinic-resolved'), 'false');
    assert.equal(res.headers.get('x-clinic-reject-reason'), 'inactive');
    const xml = await res.text();
    assert.match(xml, /<Hangup\/>/);
    assert.match(xml, /सक्रिय नहीं है/);
  });

  test('GET /webhook/doctor-bot rejects duplicate/ambiguous number', async () => {
    const res = await fetch(`${serverCtx.base}/webhook/doctor-bot?CallSid=CA-AMB&From=%2B919000000005&To=${encodeURIComponent(PHONE_AMBIGUOUS)}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-clinic-resolved'), 'false');
    assert.equal(res.headers.get('x-clinic-reject-reason'), 'ambiguous');
    const xml = await res.text();
    assert.match(xml, /<Hangup\/>/);
    assert.match(xml, /तकनीकी दिक्कत/);
  });

  test('Caller-supplied clinic query or body parameter is completely ignored', async () => {
    // Malicious caller tries to hijack Clinic A call by appending ?clinic=CLINIC_B_ID
    const res = await fetch(`${serverCtx.base}/webhook/doctor-bot?CallSid=CA-SPOOF&From=%2B919000000006&To=${encodeURIComponent(PHONE_CLINIC_A)}&clinic=${CLINIC_B_ID}`);
    assert.equal(res.status, 200);
    // Must resolve to Clinic A because 'To' phone number belongs to Clinic A
    assert.equal(res.headers.get('x-clinic-id'), CLINIC_A_ID);
    const session = await store.getSession('CA-SPOOF');
    assert.equal(session.clinic, CLINIC_A_ID);
  });

  test('Doctor scoping: Clinic A books Monday, Clinic B rejects Monday (doctor off)', async () => {
    // 1. Initial turn for Clinic A on Monday
    const startA = await fetch(`${serverCtx.base}/webhook/doctor-bot?CallSid=CA-DOC-A&From=%2B919000011111&To=${encodeURIComponent(PHONE_CLINIC_A)}`);
    assert.equal(startA.status, 200);

    // Call speech turn: booking for Monday morning
    const turnA = await fetch(`${serverCtx.base}/webhook/doctor-bot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        CallSid: 'CA-DOC-A',
        From: '+919000011111',
        To: PHONE_CLINIC_A,
        SpeechResult: 'Mera naam Ramesh hai, bukhar hai, somwar subah 10 baje',
      }),
    });
    assert.equal(turnA.status, 200);
    const xmlA = await turnA.text();
    // Monday is working day for Dr. Alpha, so readback confirms
    assert.match(xmlA, /सही है\?/);

    // 2. Initial turn for Clinic B on Monday
    const startB = await fetch(`${serverCtx.base}/webhook/doctor-bot?CallSid=CA-DOC-B&From=%2B919000022222&To=${encodeURIComponent(PHONE_CLINIC_B)}`);
    assert.equal(startB.status, 200);

    // Call speech turn: booking for Monday on Clinic B
    const turnB = await fetch(`${serverCtx.base}/webhook/doctor-bot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        CallSid: 'CA-DOC-B',
        From: '+919000022222',
        To: PHONE_CLINIC_B,
        SpeechResult: 'Mera naam Suresh hai, bukhar hai, somwar subah 10 baje',
      }),
    });
    assert.equal(turnB.status, 200);
    const xmlB = await turnB.text();
    // Dr. Beta is OFF on Monday, so Monday is refused and re-asked!
    assert.match(xmlB, /डॉक्टर.*उपलब्ध नहीं हैं/);
  });

  test('Confirmed appointment is saved with correct clinic ID and isolated', async () => {
    // Complete booking turn on Clinic A: confirm with 'Haan'
    const confirmRes = await fetch(`${serverCtx.base}/webhook/doctor-bot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        CallSid: 'CA-DOC-A',
        From: '+919000011111',
        To: PHONE_CLINIC_A,
        SpeechResult: 'Haan sahi hai',
      }),
    });
    assert.equal(confirmRes.status, 200);
    const xmlConfirm = await confirmRes.text();
    assert.match(xmlConfirm, /बुक हो गई है/);

    // Verify appointment in Clinic A
    const apptsA = await store.listAppointments({ clinic: CLINIC_A_ID });
    const appt = apptsA.find(a => a.call_sid === 'CA-DOC-A');
    assert.ok(appt, 'Appointment must exist in Clinic A');
    assert.equal(appt.clinic, CLINIC_A_ID);
    assert.equal(appt.name, 'Ramesh');
    assert.equal(appt.status, 'Confirmed');

    // Verify Clinic B cannot see this appointment
    const apptsB = await store.listAppointments({ clinic: CLINIC_B_ID });
    assert.ok(!apptsB.some(a => a.call_sid === 'CA-DOC-A'), 'Clinic B must not see Clinic A appointment');
  });

  test('Emergency call retains correct clinic ownership', async () => {
    await fetch(`${serverCtx.base}/webhook/doctor-bot?CallSid=CA-EMG-A&From=%2B919000033333&To=${encodeURIComponent(PHONE_CLINIC_A)}`);

    const emgTurn = await fetch(`${serverCtx.base}/webhook/doctor-bot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        CallSid: 'CA-EMG-A',
        From: '+919000033333',
        To: PHONE_CLINIC_A,
        SpeechResult: 'Mera naam Geeta hai, seene me tez dard hai saans nahi aa rahi',
      }),
    });
    assert.equal(emgTurn.status, 200);
    const xml = await emgTurn.text();
    assert.match(xml, /108 पर कॉल कीजिए/);

    const apptsA = await store.listAppointments({ clinic: CLINIC_A_ID });
    const emgAppt = apptsA.find(a => a.call_sid === 'CA-EMG-A');
    assert.ok(emgAppt);
    assert.equal(emgAppt.status, 'Emergency');
    assert.equal(emgAppt.priority, 'URGENT');
    assert.equal(emgAppt.clinic, CLINIC_A_ID);
  });

  test('Abandoned call retains correct clinic ownership via status callback', async () => {
    // Start call on Clinic B
    await fetch(`${serverCtx.base}/webhook/doctor-bot?CallSid=CA-ABN-B&From=%2B919000044444&To=${encodeURIComponent(PHONE_CLINIC_B)}`);

    // Give partial answer (name provided)
    await fetch(`${serverCtx.base}/webhook/doctor-bot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        CallSid: 'CA-ABN-B',
        From: '+919000044444',
        To: PHONE_CLINIC_B,
        SpeechResult: 'Mera naam Anita hai',
      }),
    });

    // Caller hangs up mid-call -> status webhook fires
    const statusRes = await fetch(`${serverCtx.base}/webhook/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        CallSid: 'CA-ABN-B',
        To: PHONE_CLINIC_B,
        CallStatus: 'completed',
        CallDuration: '25',
      }),
    });
    assert.equal(statusRes.status, 200);
    const statusBody = await statusRes.json();
    assert.equal(statusBody.saved, true);
    assert.equal(statusBody.status, 'Abandoned');

    // Appointment must be saved under Clinic B
    const apptsB = await store.listAppointments({ clinic: CLINIC_B_ID });
    const abnAppt = apptsB.find(a => a.call_sid === 'CA-ABN-B');
    assert.ok(abnAppt);
    assert.equal(abnAppt.status, 'Abandoned');
    assert.equal(abnAppt.clinic, CLINIC_B_ID);
    assert.equal(abnAppt.name, 'Anita');
  });
});

// ============================================================================
// SUITE 3: TWILIO SIGNATURE VALIDATION TESTS ON WEBHOOKS
// ============================================================================
describe('Twilio Webhook Signature Validation', () => {
  let serverCtx;
  let store;
  const testToken = 'my_secret_twilio_auth_token_xyz987';

  before(async () => {
    store = createMemoryStore();
    await seedClinicsAndDoctors(store);
    serverCtx = await createWebhookTestServer(store, {
      signatureOpts: { enabled: true, authToken: testToken },
    });
  });

  after(async () => {
    if (serverCtx && serverCtx.close) {
      await serverCtx.close();
    }
  });

  test('Webhook rejects call when X-Twilio-Signature is missing (403)', async () => {
    const res = await fetch(`${serverCtx.base}/webhook/doctor-bot?CallSid=CA-SIG1&To=${encodeURIComponent(PHONE_CLINIC_A)}`);
    assert.equal(res.status, 403);
    const txt = await res.text();
    assert.match(txt, /Missing X-Twilio-Signature/);
  });

  test('Webhook rejects call when X-Twilio-Signature is invalid/forged (403)', async () => {
    const res = await fetch(`${serverCtx.base}/webhook/doctor-bot?CallSid=CA-SIG2&To=${encodeURIComponent(PHONE_CLINIC_A)}`, {
      headers: { 'X-Twilio-Signature': 'invalid_forged_sig' },
    });
    assert.equal(res.status, 403);
    const txt = await res.text();
    assert.match(txt, /Invalid Twilio signature/);
  });

  test('Webhook allows call through when X-Twilio-Signature is valid (200)', async () => {
    const url = `${serverCtx.base}/webhook/doctor-bot?CallSid=CA-SIG3&To=${encodeURIComponent(PHONE_CLINIC_A)}`;
    const sig = computeSignature(testToken, url, {});

    const res = await fetch(url, {
      headers: { 'X-Twilio-Signature': sig },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-clinic-resolved'), 'true');
    const xml = await res.text();
    assert.match(xml, /अल्फा केयर क्लिनिक/);
  });
});

// ============================================================================
// SUITE 4: DEDICATED MONGODB INTEGRATION SUITE
// ============================================================================
const mongodbUri = process.env.TEST_MONGODB_URI;
if (mongodbUri && mongodbUri.trim() !== '') {
  const { createMongoStore } = require('./store-mongo');
  const mongoose = require('mongoose');

  describe('MongoDB Twilio Webhook Resolution Suite', () => {
    before(async () => {
      const dbUri = mongodbUri.includes('?')
        ? mongodbUri.replace(/([^/?]+)(\?)/, '$1_twilio$2')
        : (mongodbUri.endsWith('/') ? `${mongodbUri}medibot_test_twilio` : `${mongodbUri}_twilio`);
      await mongoose.connect(dbUri, { serverSelectionTimeoutMS: 5000 });
    });
    after(async () => {
      await mongoose.disconnect();
    });

    runStoreResolutionSuite(() => createMongoStore(), 'mongo');
  });
} else {
  describe('MongoDB Twilio Webhook Resolution Suite (skipped - no TEST_MONGODB_URI)', () => {
    test('skipped gracefully when TEST_MONGODB_URI is not set', (t) => {
      t.skip('Set TEST_MONGODB_URI to run Twilio phone resolution against dedicated MongoDB database');
    });
  });
}
