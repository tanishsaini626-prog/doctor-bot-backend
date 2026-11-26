'use strict';
/* ==========================================================================
 * test-phase3f1-remediation.js
 *
 * MediBot Phase 3F.1 - Critical & High Security Remediation Verification
 *
 * Verifies fixes for F-01 through F-04:
 * - F-01: Multi-instance slot capacity (database-level atomic conditional reservation across independent Node.js processes)
 * - F-02: Concurrent CallSid idempotency & unique partial index on appointments.call_sid
 * - F-03: Strict verified session enforcement (session.verified === true)
 * - F-04: Session ownership protection (prevent CallSid reassignment across clinics; 409 Conflict)
 *
 * Uses:
 * - Two real independent Node.js child processes communicating with the same local MongoDB test database.
 * - Real local HTTP requests.
 * ========================================================================== */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

const TEST_DB_URI = process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017/medibot_test_phase3e';
const TEST_INTERNAL_KEY = 'phase3f1-remediation-secret-internal-key-32c';
const TEST_JWT_SECRET = 'medibot-phase3f1-ephemeral-jwt-secret-min32chars';

// Fixed IDs for predictable cross-clinic testing
const CLINIC_A_ID = '60d0fe4f5311236168a109a1';
const CLINIC_B_ID = '60d0fe4f5311236168a109b2';
const DOCTOR_A_ID = '60d0fe4f5311236168a109d4';
const DOCTOR_B_ID = '60d0fe4f5311236168a109e5';

const PHONE_CLINIC_A = '+91 91111 11111';
const PHONE_CLINIC_B = '+91 92222 22222';

let childProcess1 = null;
let childProcess2 = null;
let baseUrl1 = null;
let baseUrl2 = null;

let ipCounter = 20;
function nextIp() {
  ipCounter += 1;
  return `10.44.0.${ipCounter}`;
}

function getFutureDate(targetWeekday = 1) { // 1 = Monday
  const d = new Date();
  d.setDate(d.getDate() + 1);
  while (d.getDay() !== targetWeekday) {
    d.setDate(d.getDate() + 1);
  }
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();
  return `${day}/${month}/${year}`;
}

function spawnServerProcess(label) {
  return new Promise((resolve, reject) => {
    const env = Object.assign({}, process.env, {
      NODE_ENV: 'test',
      STORE: 'mongo',
      MONGODB_URI: TEST_DB_URI,
      TEST_MONGODB_URI: TEST_DB_URI,
      MAX_PER_SLOT: '1',
      INTERNAL_SERVICE_KEY: TEST_INTERNAL_KEY,
      JWT_SECRET: TEST_JWT_SECRET,
      TEST_JWT_SECRET: TEST_JWT_SECRET,
      PORT: '0',
    });

    const script = `
      const app = require('./server');
      (async () => {
        if (app.locals.storeReadyPromise) {
          await app.locals.storeReadyPromise;
        }
        const server = app.listen(0, '127.0.0.1', () => {
          const port = server.address().port;
          console.log('${label}_READY_PORT:' + port);
        });
        process.on('SIGTERM', () => { server.closeAllConnections?.(); server.close(() => process.exit(0)); });
      })();
    `;

    const child = spawn(process.execPath, ['-e', script], {
      cwd: __dirname,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let resolved = false;
    let output = '';

    child.stdout.on('data', (chunk) => {
      const str = chunk.toString();
      output += str;
      const match = str.match(new RegExp(`${label}_READY_PORT:(\\d+)`));
      if (match && !resolved) {
        resolved = true;
        const port = match[1];
        resolve({ child, port, baseUrl: `http://127.0.0.1:${port}` });
      }
    });

    child.stderr.on('data', (chunk) => {
      output += chunk.toString();
    });

    child.on('error', (err) => {
      if (!resolved) {
        resolved = true;
        reject(err);
      }
    });

    child.on('exit', (code) => {
      if (!resolved) {
        resolved = true;
        reject(new Error(`${label} exited unexpectedly with code ${code}. Output: ${output}`));
      }
    });
  });
}

const {
  createMongoStore,
  ensureIndexes,
  Appointment,
  CallSession,
  SlotReservation,
  Clinic,
  Doctor,
  User,
} = require('./store-mongo');

describe('MediBot Phase 3F.1: Critical & High Security Remediation', () => {
  let directStore;
  const bookingDate = getFutureDate(1); // Next Monday

  before(async () => {
    // 1. Connect directly to test MongoDB
    await mongoose.connect(TEST_DB_URI, { serverSelectionTimeoutMS: 5000 });
    directStore = createMongoStore({ maxPerSlot: 1 });

    // 2. Clean up collections
    await Promise.all([
      Appointment.deleteMany({}),
      Clinic.deleteMany({}),
      Doctor.deleteMany({}),
      CallSession.deleteMany({}),
      SlotReservation.deleteMany({}),
      User.deleteMany({}),
    ]);

    // 3. Ensure indexes (including new call_sid partial unique index)
    await ensureIndexes();

    // 4. Seed Clinic A & Doctor A
    await directStore.saveClinic({
      name: 'Alpha Health Hospital',
      phone: PHONE_CLINIC_A,
      greeting_text: 'नमस्ते! अल्फा हेल्थ में आपका स्वागत है।',
      active: true,
    }, { clinic: CLINIC_A_ID, create: true });

    await directStore.createDoctor({
      _id: DOCTOR_A_ID,
      id: DOCTOR_A_ID,
      name: 'Dr. Alpha Physician',
      specialty: 'General Medicine',
      working_hours: [{ day: 1, start: '09:00', end: '21:00' }],
      active: true,
    }, { clinic: CLINIC_A_ID });

    // Seed Clinic B & Doctor B
    await directStore.saveClinic({
      name: 'Beta Health Clinic',
      phone: PHONE_CLINIC_B,
      greeting_text: 'नमस्ते! बीटा हेल्थ में आपका स्वागत है।',
      active: true,
    }, { clinic: CLINIC_B_ID, create: true });

    await directStore.createDoctor({
      _id: DOCTOR_B_ID,
      id: DOCTOR_B_ID,
      name: 'Dr. Beta Specialist',
      specialty: 'Surgery',
      working_hours: [{ day: 1, start: '09:00', end: '21:00' }],
      active: true,
    }, { clinic: CLINIC_B_ID });

    // 5. Spawn TWO independent Node.js processes pointing to the same MongoDB test database
    const proc1 = await spawnServerProcess('PROC1');
    childProcess1 = proc1.child;
    baseUrl1 = proc1.baseUrl;

    const proc2 = await spawnServerProcess('PROC2');
    childProcess2 = proc2.child;
    baseUrl2 = proc2.baseUrl;
  });

  after(async () => {
    if (childProcess1) {
      childProcess1.kill('SIGTERM');
    }
    if (childProcess2) {
      childProcess2.kill('SIGTERM');
    }
    if (mongoose.connection && mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
  });

  // ==========================================================================
  // F-01: Multi-Instance Slot Capacity Across Independent Processes
  // ==========================================================================
  test('F-01: Concurrent booking across independent Node processes strictly enforces slot capacity (maxPerSlot = 1)', async () => {
    const slotTime = 'Morning 10:00';

    // Create 2 verified sessions for Clinic A
    await directStore.saveSession({ call_sid: 'CA-P3F1-C1', clinic: CLINIC_A_ID, phone: '+919811111111', to: PHONE_CLINIC_A, verified: true });
    await directStore.saveSession({ call_sid: 'CA-P3F1-C2', clinic: CLINIC_A_ID, phone: '+919822222222', to: PHONE_CLINIC_A, verified: true });

    // Simultaneous request to Process 1 and Process 2
    const req1 = fetch(`${baseUrl1}/api/voice/book`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Service-Key': TEST_INTERNAL_KEY,
        'X-Forwarded-For': nextIp(),
      },
      body: JSON.stringify({
        call_sid: 'CA-P3F1-C1',
        name: 'Caller On Process 1',
        phone: '+919811111111',
        date: bookingDate,
        time_slot: slotTime,
        doctorId: DOCTOR_A_ID,
      }),
    });

    const req2 = fetch(`${baseUrl2}/api/voice/book`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Service-Key': TEST_INTERNAL_KEY,
        'X-Forwarded-For': nextIp(),
      },
      body: JSON.stringify({
        call_sid: 'CA-P3F1-C2',
        name: 'Caller On Process 2',
        phone: '+919822222222',
        date: bookingDate,
        time_slot: slotTime,
        doctorId: DOCTOR_A_ID,
      }),
    });

    const [res1, res2] = await Promise.all([req1, req2]);
    const b1 = await res1.json().catch(() => ({}));
    const b2 = await res2.json().catch(() => ({}));
    const statuses = [res1.status, res2.status];

    assert.ok(statuses.includes(201), `Exactly one multi-process concurrent request must succeed with 201 Created (got ${statuses.join(', ')}: ${JSON.stringify(b1)}, ${JSON.stringify(b2)})`);
    assert.ok(statuses.includes(409), `The competing multi-process request must be rejected with 409 Conflict (got ${statuses.join(', ')}: ${JSON.stringify(b1)}, ${JSON.stringify(b2)})`);

    // Confirm database state
    const confirmedCount = await Appointment.countDocuments({
      clinic: CLINIC_A_ID,
      date: bookingDate,
      time_slot: slotTime,
      status: 'Confirmed',
    });
    assert.equal(confirmedCount, 1, 'MongoDB must have exactly 1 confirmed appointment in slot');

    const slotDoc = await SlotReservation.findById(`${CLINIC_A_ID}:${bookingDate}:${slotTime}`).lean();
    assert.ok(slotDoc, 'SlotReservation document must exist');
    assert.equal(slotDoc.booked, 1, 'SlotReservation booked counter must equal 1');
  });

  // ==========================================================================
  // F-02: Concurrent Conflicting CallSid Across Independent Processes
  // ==========================================================================
  test('F-02: Concurrent requests with same CallSid but different payloads cannot create two appointments', async () => {
    const slotTimeA = 'Afternoon 14:00';
    const slotTimeB = 'Afternoon 15:00';
    const sharedCallSid = 'CA-CONC-CONFLICT-SID';

    await directStore.saveSession({ call_sid: sharedCallSid, clinic: CLINIC_A_ID, phone: '+919833333333', to: PHONE_CLINIC_A, verified: true });

    const reqProcess1 = fetch(`${baseUrl1}/api/voice/book`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Service-Key': TEST_INTERNAL_KEY,
        'X-Forwarded-For': nextIp(),
      },
      body: JSON.stringify({
        call_sid: sharedCallSid,
        name: 'Patient Variant A',
        phone: '+919833333333',
        date: bookingDate,
        time_slot: slotTimeA,
        doctorId: DOCTOR_A_ID,
      }),
    });

    const reqProcess2 = fetch(`${baseUrl2}/api/voice/book`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Service-Key': TEST_INTERNAL_KEY,
        'X-Forwarded-For': nextIp(),
      },
      body: JSON.stringify({
        call_sid: sharedCallSid,
        name: 'Patient Variant B',
        phone: '+919844444444', // Different phone
        date: bookingDate,
        time_slot: slotTimeB, // Different slot
        doctorId: DOCTOR_A_ID,
      }),
    });

    const [resA, resB] = await Promise.all([reqProcess1, reqProcess2]);
    const bA = await resA.json().catch(() => ({}));
    const bB = await resB.json().catch(() => ({}));
    const statuses = [resA.status, resB.status];

    assert.ok(statuses.includes(201), `One of the competing CallSid requests must succeed with 201 (got ${statuses.join(', ')}: ${JSON.stringify(bA)}, ${JSON.stringify(bB)})`);
    assert.ok(statuses.includes(409), `The conflicting CallSid request must be rejected with 409 (got ${statuses.join(', ')}: ${JSON.stringify(bA)}, ${JSON.stringify(bB)})`);

    // Confirm exactly 1 confirmed appointment exists in MongoDB with this call_sid
    const sidCount = await Appointment.countDocuments({ call_sid: sharedCallSid, status: 'Confirmed' });
    assert.equal(sidCount, 1, 'MongoDB unique partial index must guarantee exactly 1 confirmed appointment per call_sid');
  });

  // ==========================================================================
  // F-02: Idempotent Retry Across Processes
  // ==========================================================================
  test('F-02: Same CallSid and identical payload across different processes returns idempotent 200 OK', async () => {
    const callSid = 'CA-IDEM-MULTI';
    const slotTime = 'Morning 11:00';

    await directStore.saveSession({ call_sid: callSid, clinic: CLINIC_A_ID, phone: '+919855555555', to: PHONE_CLINIC_A, verified: true });

    // Request 1 on Process 1 creates the booking
    const res1 = await fetch(`${baseUrl1}/api/voice/book`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Service-Key': TEST_INTERNAL_KEY,
        'X-Forwarded-For': nextIp(),
      },
      body: JSON.stringify({
        call_sid: callSid,
        name: 'Identical Caller',
        phone: '+919855555555',
        date: bookingDate,
        time_slot: slotTime,
        doctorId: DOCTOR_A_ID,
      }),
    });
    assert.equal(res1.status, 201);
    const createdAppt = await res1.json();

    // Request 2 on Process 2 with identical payload returns 200 OK idempotent
    const res2 = await fetch(`${baseUrl2}/api/voice/book`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Service-Key': TEST_INTERNAL_KEY,
        'X-Forwarded-For': nextIp(),
      },
      body: JSON.stringify({
        call_sid: callSid,
        name: 'Identical Caller',
        phone: '+919855555555',
        date: bookingDate,
        time_slot: slotTime,
        doctorId: DOCTOR_A_ID,
      }),
    });
    assert.equal(res2.status, 200, 'Idempotent retry across processes must return 200 OK');
    const data2 = await res2.json();
    assert.equal(data2.idempotent, true);
    assert.equal(String(data2.appointment._id), String(createdAppt._id));

    // Confirm no duplicate in MongoDB
    const count = await Appointment.countDocuments({ call_sid: callSid });
    assert.equal(count, 1, 'Total appointments for this CallSid must remain exactly 1');
  });

  // ==========================================================================
  // F-03: Strict Verified Session Enforcement
  // ==========================================================================
  test('F-03: POST /api/voice/book rejects unverified sessions (false, missing, non-boolean)', async () => {
    // 1. Session with verified: false
    await directStore.saveSession({ call_sid: 'CA-UNVER-FALSE', clinic: CLINIC_A_ID, phone: '+919866666666', to: PHONE_CLINIC_A, verified: false });
    const resFalse = await fetch(`${baseUrl1}/api/voice/book`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Service-Key': TEST_INTERNAL_KEY, 'X-Forwarded-For': nextIp() },
      body: JSON.stringify({ call_sid: 'CA-UNVER-FALSE', name: 'Test', phone: '+919866666666', date: bookingDate, time_slot: 'Morning 09:30' }),
    });
    assert.equal(resFalse.status, 403, 'verified: false must be rejected with 403 Forbidden');
    const bodyFalse = await resFalse.json();
    assert.match(bodyFalse.error, /invalid or unverified call session/i);

    // 2. Session with verified: undefined / missing
    await CallSession.collection.insertOne({ call_sid: 'CA-UNVER-UNDEF', clinic: new mongoose.Types.ObjectId(CLINIC_A_ID), phone: '+919877777777', to: PHONE_CLINIC_A });
    const resUndef = await fetch(`${baseUrl1}/api/voice/book`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Service-Key': TEST_INTERNAL_KEY, 'X-Forwarded-For': nextIp() },
      body: JSON.stringify({ call_sid: 'CA-UNVER-UNDEF', name: 'Test', phone: '+919877777777', date: bookingDate, time_slot: 'Morning 09:30' }),
    });
    assert.equal(resUndef.status, 403, 'verified: undefined must be rejected with 403 Forbidden');

    // 3. Session with non-boolean truthy value (e.g. string "true")
    await CallSession.collection.insertOne({ call_sid: 'CA-UNVER-STR', clinic: new mongoose.Types.ObjectId(CLINIC_A_ID), phone: '+919888888888', to: PHONE_CLINIC_A, verified: 'true' });
    const resStr = await fetch(`${baseUrl1}/api/voice/book`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Service-Key': TEST_INTERNAL_KEY, 'X-Forwarded-For': nextIp() },
      body: JSON.stringify({ call_sid: 'CA-UNVER-STR', name: 'Test', phone: '+919888888888', date: bookingDate, time_slot: 'Morning 09:30' }),
    });
    assert.equal(resStr.status, 403, 'verified: "true" (string) must be rejected with 403 Forbidden');

    // 4. Session with verified: true strictly succeeds
    await directStore.saveSession({ call_sid: 'CA-VER-STRICT', clinic: CLINIC_A_ID, phone: '+919899999999', to: PHONE_CLINIC_A, verified: true });
    const resValid = await fetch(`${baseUrl1}/api/voice/book`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Service-Key': TEST_INTERNAL_KEY, 'X-Forwarded-For': nextIp() },
      body: JSON.stringify({ call_sid: 'CA-VER-STRICT', name: 'Valid Verified Patient', phone: '+919899999999', date: bookingDate, time_slot: 'Morning 09:30', doctorId: DOCTOR_A_ID }),
    });
    assert.equal(resValid.status, 201, 'verified: true must succeed with 201 Created');
  });

  // ==========================================================================
  // F-04: Session Ownership Protection & Cross-Clinic Replay
  // ==========================================================================
  test('F-04: CallSid cannot be reassigned to a different clinic (cross-clinic replay returns 409)', async () => {
    const replaySid = 'CA-REPLAY-TEST-1';

    // 1. Create session for Clinic A
    const resA = await fetch(`${baseUrl1}/api/voice/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Service-Key': TEST_INTERNAL_KEY, 'X-Forwarded-For': nextIp() },
      body: JSON.stringify({ call_sid: replaySid, to: PHONE_CLINIC_A, from: '+919100000001' }),
    });
    assert.equal(resA.status, 201);
    const dataA = await resA.json();
    assert.equal(String(dataA.session.clinic), CLINIC_A_ID);

    // 2. Same clinic retry is safe and idempotent
    const resSame = await fetch(`${baseUrl2}/api/voice/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Service-Key': TEST_INTERNAL_KEY, 'X-Forwarded-For': nextIp() },
      body: JSON.stringify({ call_sid: replaySid, to: PHONE_CLINIC_A, from: '+919100000001' }),
    });
    assert.equal(resSame.status, 201);
    const dataSame = await resSame.json();
    assert.equal(String(dataSame.session.clinic), CLINIC_A_ID);

    // 3. Replay with Clinic B's phone number must return 409 Conflict
    const resB = await fetch(`${baseUrl2}/api/voice/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Service-Key': TEST_INTERNAL_KEY, 'X-Forwarded-For': nextIp() },
      body: JSON.stringify({ call_sid: replaySid, to: PHONE_CLINIC_B, from: '+919100000002' }),
    });
    assert.equal(resB.status, 409, 'Reassigning CallSid to different clinic must return 409 Conflict');
    const dataB = await resB.json();
    assert.equal(dataB.code, 'SESSION_CLINIC_CONFLICT');

    // 4. Verify original session in MongoDB remains strictly owned by Clinic A
    const sessionDoc = await CallSession.findOne({ call_sid: replaySid }).lean();
    assert.equal(String(sessionDoc.clinic), CLINIC_A_ID, 'Session clinic ownership must not be mutated');
  });

  test('F-04: Concurrent session creation for different clinics on same CallSid fails closed (one 201, one 409)', async () => {
    const concSid = 'CA-CONC-SESS-RACE';

    const reqA = fetch(`${baseUrl1}/api/voice/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Service-Key': TEST_INTERNAL_KEY, 'X-Forwarded-For': nextIp() },
      body: JSON.stringify({ call_sid: concSid, to: PHONE_CLINIC_A, from: '+919100000011' }),
    });

    const reqB = fetch(`${baseUrl2}/api/voice/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Service-Key': TEST_INTERNAL_KEY, 'X-Forwarded-For': nextIp() },
      body: JSON.stringify({ call_sid: concSid, to: PHONE_CLINIC_B, from: '+919100000022' }),
    });

    const [resA, resB] = await Promise.all([reqA, reqB]);
    const statuses = [resA.status, resB.status];

    assert.ok(statuses.includes(201), 'Exactly one clinic must win the session creation race');
    assert.ok(statuses.includes(409), 'The competing clinic must be rejected with 409 Conflict');
  });

  // ==========================================================================
  // Rollback and Orphan Record Verification
  // ==========================================================================
  test('F-01 Rollback: Failed booking releases capacity reservation with zero orphan documents', async () => {
    const slotTime = 'Evening 18:00';
    const slotKey = `${CLINIC_A_ID}:${bookingDate}:${slotTime}`;

    await directStore.saveSession({ call_sid: 'CA-ROLLBACK-VAL', clinic: CLINIC_A_ID, phone: '+919199999999', to: PHONE_CLINIC_A, verified: true });

    const beforeApptCount = await Appointment.countDocuments({});

    // Attempt booking with past date (fails validation)
    const resBad = await fetch(`${baseUrl1}/api/voice/book`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Service-Key': TEST_INTERNAL_KEY, 'X-Forwarded-For': nextIp() },
      body: JSON.stringify({
        call_sid: 'CA-ROLLBACK-VAL',
        name: 'Should Fail',
        phone: '+919199999999',
        date: '01/01/2020', // past date
        time_slot: slotTime,
      }),
    });
    assert.equal(resBad.status, 400);

    const afterApptCount = await Appointment.countDocuments({});
    assert.equal(afterApptCount, beforeApptCount, 'No orphan appointment records created');

    // Slot capacity reservation was not consumed
    const slotDoc = await SlotReservation.findById(slotKey).lean();
    assert.ok(!slotDoc || slotDoc.booked === 0, 'Slot reservation must be 0 after failed validation');
  });

  // ==========================================================================
  // Backend Restart Persistence
  // ==========================================================================
  test('Backend restart: Independent child process restart preserves MongoDB records and idempotency', async () => {
    // 1. Terminate Process 1
    childProcess1.kill('SIGTERM');

    // 2. Spawn a fresh Child Process 3 on a new ephemeral port
    const proc3 = await spawnServerProcess('PROC3');
    const childProcess3 = proc3.child;
    const baseUrl3 = proc3.baseUrl;

    try {
      // 3. Health check on restarted process
      const healthRes = await fetch(`${baseUrl3}/api/health`);
      assert.equal(healthRes.status, 200);
      const healthData = await healthRes.json();
      assert.equal(healthData.store, 'mongo');
      assert.equal(healthData.database, true);

      // 4. Verify existing appointment persists
      const existingAppt = await Appointment.findOne({ call_sid: 'CA-IDEM-MULTI' }).lean();
      assert.ok(existingAppt, 'Appointment must persist across process restart');

      // 5. Test idempotency against newly spawned process
      const retryRes = await fetch(`${baseUrl3}/api/voice/book`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Internal-Service-Key': TEST_INTERNAL_KEY, 'X-Forwarded-For': nextIp() },
        body: JSON.stringify({
          call_sid: 'CA-IDEM-MULTI',
          name: 'Identical Caller',
          phone: '+919855555555',
          date: bookingDate,
          time_slot: 'Morning 11:00',
          doctorId: DOCTOR_A_ID,
        }),
      });
      assert.equal(retryRes.status, 200, 'Idempotent retry against fresh process must return 200 OK');
      const retryData = await retryRes.json();
      assert.equal(retryData.idempotent, true);
    } finally {
      childProcess3.kill('SIGTERM');
    }
  });
});
