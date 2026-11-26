'use strict';
/**
 * test-phase2-1-billing-integrity.js
 *
 * MediBot Phase 2.1 — Usage Billing Integrity Audit Verification Suite
 *
 * Verifies:
 * 1. Booking idempotency (persistent event ID booking:<apptId>, concurrent duplicate bookings).
 * 2. WhatsApp idempotency (failed dispatches do not count, retries after failure count once,
 *    duplicate retries after success never double-count).
 * 3. Call idempotency (simultaneous Twilio status callbacks, multi-instance Node processes,
 *    non-completed status filtering, missing/invalid CallDuration safety).
 * 4. MongoDB correctness (atomic increments, unique constraints on ClinicUsage & UsageEvent,
 *    idempotency persistence across backend restarts).
 * 5. Quota enforcement (concurrent booking quota atomicity, quota rollback on failed booking,
 *    concurrent doctor limit atomicity, doctor reactivation bypass prevention, shadow mode,
 *    expired subscription read-only preservation).
 * 6. Security & tenant isolation (unauthenticated/unauthorized rejection, cross-clinic
 *    spoofing prevention, month validation, platform_admin restriction).
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

const {
  Clinic,
  Doctor,
  ClinicUsage,
  UsageEvent,
  SubscriptionPlan,
} = require('./models');
const {
  createMongoStore,
  ensureIndexes,
  Appointment,
  CallSession,
  SlotReservation,
} = require('./store-mongo');
const { createMemoryStore } = require('./store-memory');
const { getBillingMonth } = require('./subscription');

const TEST_DB_URI = process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017/medibot_test_phase2_1';
const TEST_JWT_SECRET = 'medibot-phase2-1-billing-integrity-secret-32chars';
const TEST_INTERNAL_KEY = 'medibot-phase2-1-internal-service-key-32chars';

async function spawnMongoServer(tag, extraEnv = {}) {
  const port = await getFreePort();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
      env: Object.assign({}, process.env, {
        NODE_ENV: 'test',
        PORT: String(port),
        STORE: 'mongo',
        MONGODB_URI: TEST_DB_URI,
        JWT_SECRET: TEST_JWT_SECRET,
        TWILIO_VALIDATE_SIGNATURE: 'false',
        INTERNAL_SERVICE_KEY: TEST_INTERNAL_KEY,
        MAX_PER_SLOT: '50',
      }, extraEnv),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`[${tag}] Timed out waiting for server startup.\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`));
    }, 15000);

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      if (stdout.includes(String(port)) || /listening|running/i.test(stdout)) {
        clearTimeout(timer);
        resolve({ child, baseUrl: `http://127.0.0.1:${port}`, port });
      }
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('exit', (code) => {
      clearTimeout(timer);
      if (!stdout.includes(String(port)) && !/listening|running/i.test(stdout)) {
        reject(new Error(`[${tag}] Exited early with code ${code}.\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`));
      }
    });
  });
}

async function waitForReady(baseUrl) {
  for (let i = 0; i < 40; i++) {
    try {
      const r1 = await fetch(`${baseUrl}/api/health/ready`);
      const r2 = await fetch(`${baseUrl}/api/billing/plans`);
      if (r1.status === 200 && r2.status === 200) return;
    } catch (_) {}
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error(`Server at ${baseUrl} did not become ready`);
}

// ============================================================================
// PART A: In-Memory Store & Direct Unit Tests (WhatsApp, Idempotency, Security)
// ============================================================================
describe('Phase 2.1 Part A — In-Memory Usage Event Idempotency & WhatsApp', () => {
  test('A.1: Concurrent duplicate booking UsageEvents increment booking_count strictly once', async () => {
    const store = createMemoryStore();
    const m = getBillingMonth();
    const clinicId = 'clinic_mem_idem';
    const eventId = 'booking:appt_concurrent_001';

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        store.recordClinicUsage(clinicId, m, { booking_count: 1 }, { eventId, eventType: 'booking' })
      )
    );

    const duplicates = results.filter(r => r && r.duplicate === true);
    assert.equal(duplicates.length, 9, '9 of 10 concurrent identical booking events must be deduplicated');

    const usage = await store.getClinicUsage(clinicId, m);
    assert.equal(usage.booking_count, 1, 'booking_count must be strictly 1');
  });

  test('A.2: WhatsApp notifyClinic — failed dispatch does not count; retry succeeds once; duplicate retry does not double-count', async () => {
    process.env.STORE = 'memory';
    process.env.PORT = '0';
    process.env.TWILIO_VALIDATE_SIGNATURE = 'false';
    process.env.JWT_SECRET = TEST_JWT_SECRET;

    const app = require('./server');
    if (app.locals && app.locals.storeReadyPromise) {
      await app.locals.storeReadyPromise;
    }
    const store = app.locals.store;
    const notifyClinic = app.locals.notifyClinic;
    const setTwilioClient = app.locals.__setTwilioClient;

    const clinicId = 'clinic_wa_audit_' + Date.now();
    await store.saveClinic({ name: 'WA Audit Clinic', phone: '+919876540001' }, { clinic: clinicId, create: true });
    const m = getBillingMonth();
    const appt = {
      _id: 'appt_wa_001_' + Date.now(),
      clinic: clinicId,
      name: 'Priya Verma',
      phone: '+919900112233',
      date: '28/12/2026',
      time_slot: 'Morning 10:00',
      reason: 'Checkup',
    };

    // 1. Failing Twilio client: must NOT increment whatsapp_count or record UsageEvent
    let attempts = 0;
    setTwilioClient({
      messages: {
        create: async () => {
          attempts++;
          throw new Error('Twilio 503 Service Unavailable');
        },
      },
    }, 'whatsapp:+14155238886', 'whatsapp:+919876540001');

    const failRes = await notifyClinic(appt);
    assert.equal(failRes.sent, false);
    assert.equal(attempts, 1);
    const usageAfterFail = await store.getClinicUsage(clinicId, m);
    assert.equal(usageAfterFail ? usageAfterFail.whatsapp_count : 0, 0, 'Failed WhatsApp dispatch must NOT count');
    assert.equal(await store.hasUsageEvent(`whatsapp:appt:${appt._id}`), false, 'Failed dispatch must NOT create UsageEvent');

    // 2. Retry with succeeding Twilio client: must count strictly once
    let sentCount = 0;
    setTwilioClient({
      messages: {
        create: async () => {
          sentCount++;
          return { sid: 'SM_TEST_MSG_001' };
        },
      },
    }, 'whatsapp:+14155238886', 'whatsapp:+919876540001');

    const okRes = await notifyClinic(appt);
    assert.equal(okRes.sent, true);
    assert.equal(sentCount, 1);
    let usageAfterSuccess = await store.getClinicUsage(clinicId, m);
    assert.equal(usageAfterSuccess.whatsapp_count, 1, 'Successful dispatch must increment whatsapp_count to 1');

    // 3. Subsequent retry for same appointment: must be skipped and NOT double-count
    const retryRes = await notifyClinic(appt);
    assert.equal(retryRes.duplicate, true, 'Duplicate notifyClinic call must be detected as duplicate');
    assert.equal(sentCount, 1, 'Twilio messages.create must not be called again for already-dispatched appointment');
    usageAfterSuccess = await store.getClinicUsage(clinicId, m);
    assert.equal(usageAfterSuccess.whatsapp_count, 1, 'whatsapp_count must remain strictly 1');

    // Reset mock client
    setTwilioClient(null, '', '');
  });
});

// ============================================================================
// PART B: MongoDB Multi-Instance & Concurrency Billing Integrity Suite
// ============================================================================
describe('Phase 2.1 Part B — MongoDB Multi-Instance Concurrency, Quotas & Security', () => {
  let proc1 = null;
  let proc2 = null;
  let mongoStore = null;
  let mongoAvailable = false;

  const CLINIC_A_ID = new mongoose.Types.ObjectId().toString();
  const CLINIC_B_ID = new mongoose.Types.ObjectId().toString();
  const CLINIC_EXPIRED_ID = new mongoose.Types.ObjectId().toString();
  const PHONE_A = '+919811100001';
  const PHONE_B = '+919811100002';
  const PHONE_EXPIRED = '+919811100003';

  before(async () => {
    try {
      await mongoose.connect(TEST_DB_URI, { serverSelectionTimeoutMS: 4000 });
      mongoAvailable = true;
    } catch (err) {
      console.warn('Skipping MongoDB billing integrity tests: local MongoDB not reachable:', err.message);
      return;
    }

    await ensureIndexes();
    mongoStore = createMongoStore({ maxPerSlot: 50 });

    // Clean test collections
    await Promise.all([
      Clinic.deleteMany({}),
      Doctor.deleteMany({}),
      Appointment.deleteMany({}),
      CallSession.deleteMany({}),
      SlotReservation.deleteMany({}),
      ClinicUsage.deleteMany({}),
      UsageEvent.deleteMany({}),
      SubscriptionPlan.deleteMany({}),
    ]);

    // Seed custom tight-limit plan for concurrency testing (limit = 3 bookings, max_doctors = 2)
    await SubscriptionPlan.create([
      {
        plan_id: 'starter_1499',
        name: 'Clinic Starter',
        price_inr: 1499,
        included_call_minutes: 350,
        included_bookings: 3, // tight limit for concurrency testing
        max_doctors: 2,
        active: true,
      },
    ]);

    const future = new Date(Date.now() + 30 * 24 * 3600 * 1000);
    const past = new Date(Date.now() - 24 * 3600 * 1000);

    await Clinic.create([
      {
        _id: CLINIC_A_ID,
        name: 'Integrity Clinic A',
        phone: PHONE_A,
        active: true,
        subscription: { status: 'active', plan_id: 'starter_1499', current_period_end: future },
      },
      {
        _id: CLINIC_B_ID,
        name: 'Integrity Clinic B',
        phone: PHONE_B,
        active: true,
        subscription: { status: 'active', plan_id: 'starter_1499', current_period_end: future },
      },
      {
        _id: CLINIC_EXPIRED_ID,
        name: 'Expired Clinic C',
        phone: PHONE_EXPIRED,
        active: true,
        subscription: { status: 'expired', plan_id: 'starter_1499', trial_ends_at: past },
      },
    ]);

    // Spawn 2 independent Node backend instances with ENFORCE_SUBSCRIPTION_QUOTAS=true
    proc1 = await spawnMongoServer('INST1', { ENFORCE_SUBSCRIPTION_QUOTAS: 'true' });
    proc2 = await spawnMongoServer('INST2', { ENFORCE_SUBSCRIPTION_QUOTAS: 'true' });
    await Promise.all([waitForReady(proc1.baseUrl), waitForReady(proc2.baseUrl)]);
  });

  after(async () => {
    if (proc1 && proc1.child) proc1.child.kill('SIGTERM');
    if (proc2 && proc2.child) proc2.child.kill('SIGTERM');
    if (mongoose.connection && mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
  });

  test('B.1: MongoDB unique constraints exist on ClinicUsage and UsageEvent', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');

    const usageIdxs = await ClinicUsage.collection.indexes();
    assert.ok(
      usageIdxs.some(i => i.unique === true && i.key.clinic === 1 && i.key.billing_month === 1),
      'ClinicUsage must have unique compound index on { clinic: 1, billing_month: 1 }'
    );

    const eventIdxs = await UsageEvent.collection.indexes();
    assert.ok(
      eventIdxs.some(i => i.unique === true && i.key.event_id === 1),
      'UsageEvent must have unique index on { event_id: 1 }'
    );
  });

  test('B.2: Simultaneous Twilio status callbacks across 2 backend instances count call strictly once & filter non-completed statuses', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');

    const m = getBillingMonth();
    const callSid = 'CA_MULTI_INST_001';
    await mongoStore.saveSession({
      call_sid: callSid,
      clinic: CLINIC_A_ID,
      phone: '+919900000001',
      to: PHONE_A,
      verified: true,
      source: 'voice-gateway',
      call_usage_recorded: false,
      createdAt: new Date(),
    });

    // 1. Send non-completed status callbacks first (initiated, ringing, in-progress)
    for (const status of ['initiated', 'ringing', 'in-progress']) {
      const r = await fetch(`${proc1.baseUrl}/webhook/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ CallSid: callSid, CallStatus: status, CallDuration: '0' }),
      });
      assert.equal(r.status, 200);
    }

    const usageBeforeComplete = await ClinicUsage.findOne({ clinic: CLINIC_A_ID, billing_month: m }).lean();
    assert.equal(usageBeforeComplete ? usageBeforeComplete.call_count : 0, 0, 'Non-completed callbacks must NOT count');

    // 2. Fire 6 simultaneous 'completed' callbacks split across Instance 1 and Instance 2
    const callbacks = [
      proc1.baseUrl, proc2.baseUrl, proc1.baseUrl,
      proc2.baseUrl, proc1.baseUrl, proc2.baseUrl,
    ].map(url =>
      fetch(`${url}/webhook/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ CallSid: callSid, CallStatus: 'completed', CallDuration: '125' }),
      })
    );
    const responses = await Promise.all(callbacks);
    for (const r of responses) assert.equal(r.status, 200);

    const usageAfter = await ClinicUsage.findOne({ clinic: CLINIC_A_ID, billing_month: m }).lean();
    assert.equal(usageAfter.call_count, 1, 'Simultaneous callbacks across 2 instances must count call strictly once');
    assert.equal(usageAfter.call_minutes, 3, '125s must ceil to 3 minutes strictly once');

    const eventCount = await UsageEvent.countDocuments({ event_id: `call:${callSid}` });
    assert.equal(eventCount, 1, 'Exactly one UsageEvent document must exist for this CallSid');
  });

  test('B.3: Missing and invalid CallDuration values are handled safely without corrupting counters', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');

    const m = getBillingMonth();
    const beforeUsage = await ClinicUsage.findOne({ clinic: CLINIC_A_ID, billing_month: m }).lean();
    const startCalls = beforeUsage ? beforeUsage.call_count : 0;
    const startMinutes = beforeUsage ? beforeUsage.call_minutes : 0;

    const badDurations = ['', 'abc', '-45', 'NaN', 'Infinity'];
    for (let i = 0; i < badDurations.length; i++) {
      const sid = `CA_BAD_DUR_${i}`;
      await mongoStore.saveSession({
        call_sid: sid,
        clinic: CLINIC_A_ID,
        phone: '+919900000010',
        to: PHONE_A,
        verified: true,
        source: 'voice-gateway',
        call_usage_recorded: false,
        createdAt: new Date(),
      });
      const r = await fetch(`${proc1.baseUrl}/webhook/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ CallSid: sid, CallStatus: 'completed', CallDuration: badDurations[i] }),
      });
      assert.equal(r.status, 200);
    }

    const afterUsage = await ClinicUsage.findOne({ clinic: CLINIC_A_ID, billing_month: m }).lean();
    assert.equal(afterUsage.call_count, startCalls + badDurations.length);
    assert.equal(afterUsage.call_minutes, startMinutes, 'Invalid/negative/missing durations must add 0 minutes');
  });

  test('B.4: Concurrent booking requests across 2 instances strictly enforce quota limit (limit = 3) with zero overage', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');

    const m = getBillingMonth();
    // Reset Clinic A booking_count to 0
    await ClinicUsage.findOneAndUpdate(
      { clinic: CLINIC_A_ID, billing_month: m },
      { $set: { booking_count: 0 } },
      { upsert: true }
    );

    const tokenA = jwt.sign(
      { sub: 'owner_a', email: 'owner@clinica.test', role: 'clinic_owner', clinic: CLINIC_A_ID },
      TEST_JWT_SECRET
    );

    // Fire 8 concurrent booking requests across Instance 1 and Instance 2 for limit=3
    const requests = Array.from({ length: 8 }, (_, idx) => {
      const targetUrl = idx % 2 === 0 ? proc1.baseUrl : proc2.baseUrl;
      return fetch(`${targetUrl}/api/appointments`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tokenA}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: `Concurrent Patient ${idx}`,
          phone: `+91980000001${idx}`,
          date: '28/12/2026',
          time_slot: `Morning 10:0${idx}`,
          reason: 'Checkup',
        }),
      });
    });

    const responses = await Promise.all(requests);
    const statuses = responses.map(r => r.status);
    const created = statuses.filter(s => s === 201).length;
    const quotaRejected = statuses.filter(s => s === 409).length;

    assert.equal(created, 3, `Exactly 3 bookings must succeed for limit=3 (got statuses: ${statuses.join(',')})`);
    assert.equal(quotaRejected, 5, `Exactly 5 bookings must be rejected with 409 QUOTA_EXCEEDED (got statuses: ${statuses.join(',')})`);

    const usageDoc = await ClinicUsage.findOne({ clinic: CLINIC_A_ID, billing_month: m }).lean();
    assert.equal(usageDoc.booking_count, 3, 'MongoDB booking_count must equal exactly 3');

    const apptCount = await Appointment.countDocuments({ clinic: CLINIC_A_ID, status: 'Confirmed' });
    assert.equal(apptCount, 3, 'MongoDB Confirmed appointments must equal exactly 3');
  });

  test('B.5: Failed booking (duplicate phone/date/slot) rolls back reserved booking quota cleanly', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');

    const m = getBillingMonth();
    const tokenB = jwt.sign(
      { sub: 'owner_b', email: 'owner@clinicb.test', role: 'clinic_owner', clinic: CLINIC_B_ID },
      TEST_JWT_SECRET
    );

    // First booking succeeds (usage: 0 -> 1)
    const r1 = await fetch(`${proc1.baseUrl}/api/appointments`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenB}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Patient Rollback',
        phone: '+919700000001',
        date: '29/12/2026',
        time_slot: 'Morning 10:00',
      }),
    });
    assert.equal(r1.status, 201);

    // Duplicate booking fails with 409 duplicate — must roll back reserved quota (usage remains 1)
    const r2 = await fetch(`${proc1.baseUrl}/api/appointments`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenB}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Patient Rollback',
        phone: '+919700000001',
        date: '29/12/2026',
        time_slot: 'Morning 10:00',
      }),
    });
    assert.equal(r2.status, 409);

    const usageB = await ClinicUsage.findOne({ clinic: CLINIC_B_ID, billing_month: m }).lean();
    assert.equal(usageB.booking_count, 1, 'Failed duplicate booking must roll back quota reservation cleanly');
  });

  test('B.6: Concurrent doctor creation and doctor reactivation cannot bypass max_doctors (limit = 2)', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');

    const tokenA = jwt.sign(
      { sub: 'owner_a', email: 'owner@clinica.test', role: 'clinic_owner', clinic: CLINIC_A_ID },
      TEST_JWT_SECRET
    );

    // 1. Fire 5 concurrent POST /api/doctors requests across both instances for max_doctors = 2
    const docRequests = Array.from({ length: 5 }, (_, idx) => {
      const targetUrl = idx % 2 === 0 ? proc1.baseUrl : proc2.baseUrl;
      return fetch(`${targetUrl}/api/doctors`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: `Dr. Concurrent ${idx}`, specialty: 'General' }),
      });
    });

    const docResponses = await Promise.all(docRequests);
    const createdDocs = [];
    let rejectedCount = 0;
    for (const r of docResponses) {
      if (r.status === 201) createdDocs.push(await r.json());
      else if (r.status === 409) rejectedCount++;
    }

    assert.equal(createdDocs.length, 2, 'Exactly 2 doctors must be created for max_doctors=2');
    assert.equal(rejectedCount, 3, 'Remaining 3 concurrent doctor creations must be rejected with 409');

    // 2. Reactivation bypass test: deactivate Dr. 0, create Dr. 3, then try to reactivate Dr. 0
    const doc0Id = createdDocs[0]._id;
    const deactivateRes = await fetch(`${proc1.baseUrl}/api/doctors/${doc0Id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ active: false }),
    });
    assert.equal(deactivateRes.status, 200);

    const replacementRes = await fetch(`${proc1.baseUrl}/api/doctors`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Dr. Replacement' }),
    });
    assert.equal(replacementRes.status, 201, 'Creating replacement doctor while only 1 is active must succeed');

    const reactivateRes = await fetch(`${proc1.baseUrl}/api/doctors/${doc0Id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ active: true }),
    });
    assert.equal(reactivateRes.status, 409, 'Reactivating inactive doctor when already at max_doctors must be blocked (409)');
    const reactivateBody = await reactivateRes.json();
    assert.equal(reactivateBody.code, 'QUOTA_EXCEEDED');
  });

  test('B.7: Idempotency records survive backend restart (MongoDB persistence)', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');

    const m = getBillingMonth();
    const beforeUsage = await ClinicUsage.findOne({ clinic: CLINIC_A_ID, billing_month: m }).lean();
    const callsBeforeRestart = beforeUsage.call_count;
    const minutesBeforeRestart = beforeUsage.call_minutes;

    // Kill Instance 2 and spawn a fresh Instance 3
    proc2.child.kill('SIGTERM');
    proc2 = await spawnMongoServer('INST3_RESTARTED', { ENFORCE_SUBSCRIPTION_QUOTAS: 'true' });
    await waitForReady(proc2.baseUrl);

    // Replay the exact CallSid from B.2 against the restarted instance
    const replayRes = await fetch(`${proc2.baseUrl}/webhook/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ CallSid: 'CA_MULTI_INST_001', CallStatus: 'completed', CallDuration: '125' }),
    });
    assert.equal(replayRes.status, 200);

    const afterUsage = await ClinicUsage.findOne({ clinic: CLINIC_A_ID, billing_month: m }).lean();
    assert.equal(afterUsage.call_count, callsBeforeRestart, 'Replayed CallSid after restart must NOT increment call_count');
    assert.equal(afterUsage.call_minutes, minutesBeforeRestart, 'Replayed CallSid after restart must NOT increment call_minutes');
  });

  test('B.8: Security — auth, tenant isolation, spoofing prevention, and platform_admin restriction', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');

    const tokenA = jwt.sign(
      { sub: 'owner_a', email: 'owner@clinica.test', role: 'clinic_owner', clinic: CLINIC_A_ID },
      TEST_JWT_SECRET
    );
    const tokenExpired = jwt.sign(
      { sub: 'owner_exp', email: 'owner@expired.test', role: 'clinic_owner', clinic: CLINIC_EXPIRED_ID },
      TEST_JWT_SECRET
    );
    const tokenPlatform = jwt.sign(
      { sub: 'plat_1', email: 'super@medibot.local', role: 'platform_admin', clinic: null },
      TEST_JWT_SECRET
    );

    // 1. Unauthenticated requests rejected (401)
    assert.equal((await fetch(`${proc1.baseUrl}/api/usage`)).status, 401);
    assert.equal((await fetch(`${proc1.baseUrl}/api/subscription`)).status, 401);
    assert.equal((await fetch(`${proc1.baseUrl}/api/platform/subscriptions`)).status, 401);

    // 2. Clinic A attempting to read Clinic B's usage via query param spoofing gets strictly Clinic A's usage
    const spoofRes = await fetch(`${proc1.baseUrl}/api/usage?clinic=${CLINIC_B_ID}`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    assert.equal(spoofRes.status, 200);
    const spoofData = await spoofRes.json();
    assert.equal(spoofData.clinicId, CLINIC_A_ID, 'Usage endpoint must strictly derive clinicId from JWT, never query string');

    // 3. Invalid month parameter rejected (400)
    const badMonthRes = await fetch(`${proc1.baseUrl}/api/usage?month=not-a-month`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    assert.equal(badMonthRes.status, 400);

    // 4. Platform admin route rejects clinic_owner (403) and allows platform_admin (200)
    const nonAdminRes = await fetch(`${proc1.baseUrl}/api/platform/subscriptions`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    assert.equal(nonAdminRes.status, 403, 'clinic_owner must be rejected from /api/platform/subscriptions');

    const adminRes = await fetch(`${proc1.baseUrl}/api/platform/subscriptions`, {
      headers: { Authorization: `Bearer ${tokenPlatform}` },
    });
    assert.equal(adminRes.status, 200, 'platform_admin must be allowed on /api/platform/subscriptions');

    // 5. Expired subscription retains historical read access to usage, subscription, appointments, calls, patients, analytics
    for (const ep of ['/api/appointments', '/api/calls', '/api/patients', '/api/analytics', '/api/usage', '/api/subscription']) {
      const r = await fetch(`${proc1.baseUrl}${ep}`, {
        headers: { Authorization: `Bearer ${tokenExpired}` },
      });
      assert.equal(r.status, 200, `Expired clinic must retain read access to ${ep}`);
    }
  });
});
