'use strict';
/* ==========================================================================
 * test-phase3f2-operational.js
 *
 * MediBot Phase 3F.1 Edge Cases + Phase 3F.2 Operational Security Verification
 *
 * Part A:
 * - SlotReservation edge cases (409 on full slot, concurrent full-slot requests,
 *   reservation release on failure, repeated cancellation/deletion double decrement prevention,
 *   Confirmed -> Cancelled -> Confirmed transitions, reservation count synchronization,
 *   multi-process consistency).
 * - Verified-session trust boundary (unauthenticated/forged sessions, webhook impersonation defense,
 *   rejection of caller-injected verified: true).
 *
 * Part B:
 * - F-05: Rate limiting on voice session, booking, and webhooks.
 * - F-06: Production Twilio signature validation enforcement & startup check.
 * - F-07: Internal service key minimum length & strength validation.
 * - F-08: Sensitive logging & phone masking.
 * - F-09: Webhook resilience & TwiML error fallback.
 * - Multi-proxy publicUrl() header parsing.
 * ========================================================================== */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');
const http = require('node:http');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

const { publicUrl, computeSignature } = require('./twilio-signature');

const TEST_DB_URI = process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017/medibot_test_phase3e';
const TEST_INTERNAL_KEY = 'phase3f2-operational-secret-internal-key-32c';
const TEST_JWT_SECRET = 'medibot-phase3f2-ephemeral-jwt-secret-min32chars';
const TEST_TWILIO_AUTH_TOKEN = 'test-twilio-auth-token-for-phase3f2-testing-32chars';

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

let ipCounter = 200;
function nextIp() {
  ipCounter += 1;
  return `10.88.0.${ipCounter}`;
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
      TWILIO_AUTH_TOKEN: TEST_TWILIO_AUTH_TOKEN,
      TWILIO_VALIDATE_SIGNATURE: 'true',
    });

    const runnerScript = `
      process.on('uncaughtException', err => console.error('[CHILD UNCAUGHT ' + '${label}' + ']', err.stack || err));
      process.on('unhandledRejection', err => console.error('[CHILD UNHANDLED ' + '${label}' + ']', err.stack || err));
      const app = require('./server.js');
      (async () => {
        try {
          if (app.locals.storeReadyPromise) await app.locals.storeReadyPromise;
          const server = app.listen(0, '127.0.0.1', () => {
            const port = server.address().port;
            console.log('READY:' + port);
          });
        } catch (err) {
          console.error('Child server startup failed:', err);
          process.exit(1);
        }
      })();
    `;

    const child = spawn(process.execPath, ['-e', runnerScript], {
      cwd: __dirname,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let resolved = false;
    let stdoutData = '';

    child.stdout.on('data', (chunk) => {
      stdoutData += chunk.toString();
      const match = stdoutData.match(/READY:(\d+)/);
      if (match && !resolved) {
        resolved = true;
        resolve({ child, port: parseInt(match[1], 10) });
      }
    });

    child.stderr.on('data', (chunk) => {
      console.error(`[CHILD STDERR ${label}] ${chunk}`);
    });

    child.on('exit', (code, signal) => {
      if (!resolved) {
        reject(new Error(`Child server (${label}) exited early with code ${code}. Output: ${stdoutData}`));
      } else {
        console.error(`[CHILD EXIT ${label}] code: ${code}, signal: ${signal}`);
      }
    });
  });
}

describe('MediBot Phase 3F.1 Edge Cases + Phase 3F.2 Operational Security', () => {
  let directStore = null;
  let Appointment = null;
  let SlotReservation = null;
  let CallSession = null;
  let Clinic = null;
  let Doctor = null;
  let tokenClinicA = null;

  const bookingDate = getFutureDate(1); // Monday

  before(async () => {
    await mongoose.connect(TEST_DB_URI, { serverSelectionTimeoutMS: 5000 });
    const storeMongo = require('./store-mongo');
    Appointment = storeMongo.Appointment;
    SlotReservation = storeMongo.SlotReservation;
    CallSession = storeMongo.CallSession;
    Clinic = storeMongo.Clinic;
    Doctor = storeMongo.Doctor;
    directStore = storeMongo.createMongoStore({ maxPerSlot: 1 });
    await storeMongo.ensureIndexes();

    // Reset collections
    await Promise.all([
      Appointment.deleteMany({}),
      SlotReservation.deleteMany({}),
      CallSession.deleteMany({}),
      Clinic.deleteMany({}),
      Doctor.deleteMany({}),
    ]);

    // Seed clinics
    await Clinic.create([
      { _id: new mongoose.Types.ObjectId(CLINIC_A_ID), name: 'Alpha Health Center', phone: PHONE_CLINIC_A, active: true },
      { _id: new mongoose.Types.ObjectId(CLINIC_B_ID), name: 'Beta Medicare', phone: PHONE_CLINIC_B, active: true },
    ]);

    // Seed doctors
    await Doctor.create([
      { _id: new mongoose.Types.ObjectId(DOCTOR_A_ID), name: 'Dr. Alpha', clinic: new mongoose.Types.ObjectId(CLINIC_A_ID), active: true, days: ['Monday', 'Tuesday', 'Wednesday'], hours: { start: '09:00', end: '17:00' } },
      { _id: new mongoose.Types.ObjectId(DOCTOR_B_ID), name: 'Dr. Beta', clinic: new mongoose.Types.ObjectId(CLINIC_B_ID), active: true, days: ['Wednesday', 'Thursday', 'Friday'], hours: { start: '09:00', end: '17:00' } },
    ]);

    tokenClinicA = jwt.sign({ sub: 'user_a', clinic: CLINIC_A_ID, role: 'clinic_owner' }, TEST_JWT_SECRET, { expiresIn: '1h' });

    // Spawn 2 independent Node processes
    const p1 = await spawnServerProcess('Instance 1');
    childProcess1 = p1.child;
    baseUrl1 = `http://127.0.0.1:${p1.port}`;

    const p2 = await spawnServerProcess('Instance 2');
    childProcess2 = p2.child;
    baseUrl2 = `http://127.0.0.1:${p2.port}`;
  });

  after(async () => {
    if (childProcess1) childProcess1.kill();
    if (childProcess2) childProcess2.kill();
    await mongoose.disconnect();
  });

  // ==========================================================================
  // PART A: SlotReservation Edge Cases
  // ==========================================================================

  test('Part A.1: When slot reaches MAX_PER_SLOT, subsequent booking returns 409 Conflict, not 500', async () => {
    const slotTime = 'Morning 09:00';
    const callSid1 = `CA-EDGE-1A-${Date.now()}`;
    const callSid2 = `CA-EDGE-1B-${Date.now()}`;

    await directStore.saveSession({ call_sid: callSid1, clinic: CLINIC_A_ID, phone: '+919811111111', to: PHONE_CLINIC_A, verified: true });
    await directStore.saveSession({ call_sid: callSid2, clinic: CLINIC_A_ID, phone: '+919822222222', to: PHONE_CLINIC_A, verified: true });

    // First booking succeeds (201 Created)
    const res1 = await fetch(`${baseUrl1}/api/voice/book`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Service-Key': TEST_INTERNAL_KEY, 'X-Forwarded-For': nextIp() },
      body: JSON.stringify({ call_sid: callSid1, name: 'Patient 1', phone: '+919811111111', date: bookingDate, time_slot: slotTime, doctorId: DOCTOR_A_ID }),
    });
    assert.equal(res1.status, 201);

    // Second booking on full slot returns 409 Conflict with slot_full message, NOT 500
    const res2 = await fetch(`${baseUrl2}/api/voice/book`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Service-Key': TEST_INTERNAL_KEY, 'X-Forwarded-For': nextIp() },
      body: JSON.stringify({ call_sid: callSid2, name: 'Patient 2', phone: '+919822222222', date: bookingDate, time_slot: slotTime, doctorId: DOCTOR_A_ID }),
    });
    assert.equal(res2.status, 409, 'Full slot must return 409 Conflict, never 500');
    const body2 = await res2.json();
    assert.match(body2.error, /full/i);

    // Also verify dashboard POST /api/appointments returns 409 when slot is full
    const resDash = await fetch(`${baseUrl1}/api/appointments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenClinicA}`, 'X-Forwarded-For': nextIp() },
      body: JSON.stringify({ name: 'Patient Dashboard', phone: '+919833333333', date: bookingDate, time_slot: slotTime, doctorId: DOCTOR_A_ID }),
    });
    assert.equal(resDash.status, 409, 'Dashboard booking on full slot must return 409 Conflict');
    const bodyDash = await resDash.json();
    assert.match(bodyDash.error, /full/i);
  });

  test('Part A.2: Concurrent reservation attempts on already full slot are all rejected with zero count drift', async () => {
    const slotTime = 'Morning 09:00'; // already full from previous test
    const promises = [];

    for (let i = 0; i < 4; i++) {
      const callSid = `CA-EDGE-2-${i}-${Date.now()}`;
      await directStore.saveSession({ call_sid: callSid, clinic: CLINIC_A_ID, phone: `+91983333333${i}`, to: PHONE_CLINIC_A, verified: true });
      const targetUrl = i % 2 === 0 ? baseUrl1 : baseUrl2;
      promises.push(
        fetch(`${targetUrl}/api/voice/book`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Internal-Service-Key': TEST_INTERNAL_KEY, 'X-Forwarded-For': nextIp() },
          body: JSON.stringify({ call_sid: callSid, name: `Concurrent Caller ${i}`, phone: `+91983333333${i}`, date: bookingDate, time_slot: slotTime, doctorId: DOCTOR_A_ID }),
        })
      );
    }

    const responses = await Promise.all(promises);
    for (const r of responses) {
      assert.equal(r.status, 409, 'Every attempt on full slot must return 409');
    }

    // Direct database assertion: booked count must remain exactly 1 (never drifted above MAX_PER_SLOT)
    const slotDoc = await SlotReservation.findById(`${CLINIC_A_ID}:${bookingDate}:${slotTime}`).lean();
    assert.equal(slotDoc.booked, 1, 'Booked counter must remain strictly 1');
  });

  test('Part A.3: Reservation released atomically on failed appointment creation (capacity rollback)', async () => {
    const slotTime = 'Morning 09:30';
    const slotKey = `${CLINIC_A_ID}:${bookingDate}:${slotTime}`;
    const callSidFail = `CA-EDGE-FAIL-${Date.now()}`;
    const callSidSuccess = `CA-EDGE-SUCC-${Date.now()}`;

    await directStore.saveSession({ call_sid: callSidFail, clinic: CLINIC_A_ID, phone: '+919844444444', to: PHONE_CLINIC_A, verified: true });
    await directStore.saveSession({ call_sid: callSidSuccess, clinic: CLINIC_A_ID, phone: '+919855555555', to: PHONE_CLINIC_A, verified: true });

    // Request with invalid doctor ID fails (400)
    const resFail = await fetch(`${baseUrl1}/api/voice/book`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Service-Key': TEST_INTERNAL_KEY, 'X-Forwarded-For': nextIp() },
      body: JSON.stringify({ call_sid: callSidFail, name: 'Fail Patient', phone: '+919844444444', date: bookingDate, time_slot: slotTime, doctorId: 'invalid-doctor-id-format' }),
    });
    assert.equal(resFail.status, 400);

    // Verify reservation was released (booked count 0 or non-existent)
    const slotAfterFail = await SlotReservation.findById(slotKey).lean();
    assert.ok(!slotAfterFail || slotAfterFail.booked === 0, 'Reservation must be 0 after failed creation');

    // Subsequent valid booking immediately succeeds into that slot
    const resSuccess = await fetch(`${baseUrl2}/api/voice/book`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Service-Key': TEST_INTERNAL_KEY, 'X-Forwarded-For': nextIp() },
      body: JSON.stringify({ call_sid: callSidSuccess, name: 'Success Patient', phone: '+919855555555', date: bookingDate, time_slot: slotTime, doctorId: DOCTOR_A_ID }),
    });
    assert.equal(resSuccess.status, 201, 'Slot must be available after rollback');
  });

  test('Part A.4: Repeated cancellation and deletion prevent double decrement', async () => {
    const slotTime = 'Morning 10:00';
    const slotKey = `${CLINIC_A_ID}:${bookingDate}:${slotTime}`;
    const callSid = `CA-EDGE-CANCEL-${Date.now()}`;

    await directStore.saveSession({ call_sid: callSid, clinic: CLINIC_A_ID, phone: '+919866666666', to: PHONE_CLINIC_A, verified: true });

    const createRes = await fetch(`${baseUrl1}/api/voice/book`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Service-Key': TEST_INTERNAL_KEY, 'X-Forwarded-For': nextIp() },
      body: JSON.stringify({ call_sid: callSid, name: 'Cancel Patient', phone: '+919866666666', date: bookingDate, time_slot: slotTime, doctorId: DOCTOR_A_ID }),
    });
    assert.equal(createRes.status, 201);
    const appt = await createRes.json();
    const apptId = appt._id;

    let slot = await SlotReservation.findById(slotKey).lean();
    assert.equal(slot.booked, 1, 'Booked counter should be 1');

    // 1. Cancel once -> booked drops to 0
    const cancel1 = await directStore.updateAppointmentStatus(apptId, 'Cancelled', { clinic: CLINIC_A_ID });
    assert.equal(cancel1.status, 'Cancelled');
    slot = await SlotReservation.findById(slotKey).lean();
    assert.equal(slot.booked, 0, 'Booked counter should be 0 after first cancellation');

    // 2. Cancel a second time -> idempotent no-op, booked remains 0 (does not drop to -1)
    const cancel2 = await directStore.updateAppointmentStatus(apptId, 'Cancelled', { clinic: CLINIC_A_ID });
    assert.equal(cancel2.status, 'Cancelled');
    slot = await SlotReservation.findById(slotKey).lean();
    assert.equal(slot.booked, 0, 'Booked counter must NEVER drop below 0 on repeated cancellation');

    // 3. Delete already cancelled appointment -> booked remains 0 (does not decrement)
    const del1 = await directStore.deleteAppointment(apptId, { clinic: CLINIC_A_ID });
    assert.equal(del1, true);
    slot = await SlotReservation.findById(slotKey).lean();
    assert.equal(slot.booked, 0, 'Booked counter remains 0 after deleting cancelled appointment');

    // 4. Delete already deleted appointment -> returns false, booked remains 0
    const del2 = await directStore.deleteAppointment(apptId, { clinic: CLINIC_A_ID });
    assert.equal(del2, false);
    slot = await SlotReservation.findById(slotKey).lean();
    assert.equal(slot.booked, 0, 'Booked counter remains 0 on duplicate delete');
  });

  test('Part A.5: Status transitions: Cancelled -> Confirmed strictly enforces slot capacity', async () => {
    const slotTime = 'Morning 10:30';
    const callSidA = `CA-EDGE-TRANS-A-${Date.now()}`;
    const callSidB = `CA-EDGE-TRANS-B-${Date.now()}`;

    // Book Appointment A
    await directStore.saveSession({ call_sid: callSidA, clinic: CLINIC_A_ID, phone: '+919877777771', to: PHONE_CLINIC_A, verified: true });
    const resA = await fetch(`${baseUrl1}/api/voice/book`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Service-Key': TEST_INTERNAL_KEY, 'X-Forwarded-For': nextIp() },
      body: JSON.stringify({ call_sid: callSidA, name: 'Patient A', phone: '+919877777771', date: bookingDate, time_slot: slotTime, doctorId: DOCTOR_A_ID }),
    });
    assert.equal(resA.status, 201);
    const apptA = await resA.json();

    // Cancel Appointment A -> frees the slot
    const cancelRes = await fetch(`${baseUrl1}/api/appointments/${apptA._id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenClinicA}`, 'X-Forwarded-For': nextIp() },
      body: JSON.stringify({ status: 'Cancelled' }),
    });
    assert.equal(cancelRes.status, 200);

    // Book Appointment B into the now-freed slot
    await directStore.saveSession({ call_sid: callSidB, clinic: CLINIC_A_ID, phone: '+919877777772', to: PHONE_CLINIC_A, verified: true });
    const resB = await fetch(`${baseUrl2}/api/voice/book`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Service-Key': TEST_INTERNAL_KEY, 'X-Forwarded-For': nextIp() },
      body: JSON.stringify({ call_sid: callSidB, name: 'Patient B', phone: '+919877777772', date: bookingDate, time_slot: slotTime, doctorId: DOCTOR_A_ID }),
    });
    assert.equal(resB.status, 201, 'Appointment B succeeds into freed slot');

    // Attempt to re-confirm Appointment A while slot is now full with Appointment B
    const reconfirmRes = await fetch(`${baseUrl2}/api/appointments/${apptA._id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenClinicA}`, 'X-Forwarded-For': nextIp() },
      body: JSON.stringify({ status: 'Confirmed' }),
    });
    assert.equal(reconfirmRes.status, 409, 'Re-confirming full slot must return 409 Conflict');
    const reconfirmBody = await reconfirmRes.json();
    assert.match(reconfirmBody.error, /full/i);

    // Verify Appointment A remained Cancelled in MongoDB
    const apptADoc = await Appointment.findById(apptA._id).lean();
    assert.equal(apptADoc.status, 'Cancelled', 'Appointment A must remain Cancelled');
  });

  test('Part A.6: Direct audit: SlotReservation counts strictly match actual Confirmed appointments', async () => {
    const allSlots = await SlotReservation.find({}).lean();
    for (const slot of allSlots) {
      const actualConfirmed = await Appointment.countDocuments({
        clinic: slot.clinic,
        date: slot.date,
        time_slot: slot.time_slot,
        status: 'Confirmed',
      });
      assert.equal(slot.booked, actualConfirmed, `Slot ${slot._id} booked count (${slot.booked}) must match actual Confirmed count (${actualConfirmed})`);
    }
  });

  // ==========================================================================
  // PART A: Trust Boundary & Verified Session Tests
  // ==========================================================================

  test('Part A.7: Trust boundary: POST /api/voice/session rejects unauthenticated requests (401)', async () => {
    const resNoAuth = await fetch(`${baseUrl1}/api/voice/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': nextIp() },
      body: JSON.stringify({ call_sid: 'CA-UNTRUSTED-1', to: PHONE_CLINIC_A }),
    });
    assert.equal(resNoAuth.status, 401, 'Missing key must return 401');

    const resBadAuth = await fetch(`${baseUrl1}/api/voice/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Service-Key': 'forged-internal-key', 'X-Forwarded-For': nextIp() },
      body: JSON.stringify({ call_sid: 'CA-UNTRUSTED-2', to: PHONE_CLINIC_A }),
    });
    assert.equal(resBadAuth.status, 401, 'Invalid key must return 401');
  });

  test('Part A.8: Trust boundary: Twilio webhook cannot be bypassed using internal service key', async () => {
    const callSid = `CA-FORGED-TWILIO-${Date.now()}`;
    const to = PHONE_CLINIC_A;
    const url = `${baseUrl1}/webhook/doctor-bot?CallSid=${callSid}&To=${encodeURIComponent(to)}`;

    // Providing X-Internal-Service-Key to Twilio webhook endpoint must NOT bypass signature check
    const resBypass = await fetch(url, {
      method: 'GET',
      headers: {
        'X-Internal-Service-Key': TEST_INTERNAL_KEY,
        'X-Forwarded-For': nextIp(),
      },
    });
    assert.equal(resBypass.status, 403, 'Twilio webhook must reject requests lacking X-Twilio-Signature even if internal key is sent');
  });

  test('Part A.9: Trust boundary: Client cannot inject verified: true in request body', async () => {
    // Attempting to book with unverified session by injecting verified: true in booking body
    const unverifiedSid = `CA-INJECT-${Date.now()}`;
    await CallSession.collection.insertOne({
      call_sid: unverifiedSid,
      clinic: new mongoose.Types.ObjectId(CLINIC_A_ID),
      to: PHONE_CLINIC_A,
      verified: false,
    });

    const resInject = await fetch(`${baseUrl1}/api/voice/book`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Service-Key': TEST_INTERNAL_KEY, 'X-Forwarded-For': nextIp() },
      body: JSON.stringify({
        call_sid: unverifiedSid,
        verified: true, // injected
        name: 'Injected Patient',
        phone: '+919877777779',
        date: bookingDate,
        time_slot: 'Evening 16:00',
      }),
    });
    assert.equal(resInject.status, 403, 'Injected verified field must be ignored; session in DB governs');
  });

  // ==========================================================================
  // PART B: F-05 Rate Limiting
  // ==========================================================================

  test('Part B.1: F-05 Rate Limiting: POST /api/voice/book enforces rate limits on high volume', async () => {
    const fixedIp = '10.99.1.55';
    const promises = [];

    // Rapid-fire 35 requests from same IP (limit is 30/min)
    for (let i = 0; i < 35; i++) {
      promises.push(
        fetch(`${baseUrl1}/api/voice/book`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Internal-Service-Key': TEST_INTERNAL_KEY,
            'X-Forwarded-For': fixedIp,
          },
          body: JSON.stringify({ call_sid: `CA-RL-${i}`, name: 'Spam', phone: '+919999900000', date: bookingDate, time_slot: 'Morning 11:00' }),
        })
      );
    }

    const responses = await Promise.all(promises);
    const statuses = responses.map(r => r.status);
    assert.ok(statuses.includes(429), `Rapid requests must trigger HTTP 429 Rate Limit (got: ${statuses.filter(s => s === 429).length} 429s)`);
  });

  // ==========================================================================
  // PART B: F-06 Twilio Signature Protection & Production Guards
  // ==========================================================================

  test('Part B.2: F-06 Twilio signature protection: Production rejects TWILIO_VALIDATE_SIGNATURE=false at startup', () => {
    const res = spawnSync(process.execPath, [path.join(__dirname, 'server.js')], {
      env: Object.assign({}, process.env, {
        NODE_ENV: 'production',
        PORT: '0',
        STORE: 'mongo',
        MONGODB_URI: TEST_DB_URI,
        JWT_SECRET: 'test-production-secret-at-least-32-chars-long-012345',
        TWILIO_VALIDATE_SIGNATURE: 'false', // forbidden in production
        TWILIO_AUTH_TOKEN: 'test-auth-token-min-32-chars-long-12345',
        INTERNAL_SERVICE_KEY: 'test-internal-service-key-min-32-chars',
      }),
      encoding: 'utf8',
      timeout: 10000,
    });

    assert.equal(res.status, 1, 'Production with TWILIO_VALIDATE_SIGNATURE=false must exit with code 1');
    assert.match(res.stderr, /TWILIO_VALIDATE_SIGNATURE=false is not permitted in production/i);
  });

  test('Part B.3: F-06 Twilio signature protection: Production rejects missing TWILIO_AUTH_TOKEN at startup', () => {
    const res = spawnSync(process.execPath, [path.join(__dirname, 'server.js')], {
      env: Object.assign({}, process.env, {
        NODE_ENV: 'production',
        PORT: '0',
        STORE: 'mongo',
        MONGODB_URI: TEST_DB_URI,
        JWT_SECRET: 'test-production-secret-at-least-32-chars-long-012345',
        TWILIO_VALIDATE_SIGNATURE: 'true',
        TWILIO_AUTH_TOKEN: '', // missing
        INTERNAL_SERVICE_KEY: 'test-internal-service-key-min-32-chars',
      }),
      encoding: 'utf8',
      timeout: 10000,
    });

    assert.equal(res.status, 1, 'Production with missing TWILIO_AUTH_TOKEN must exit with code 1');
    assert.match(res.stderr, /TWILIO_AUTH_TOKEN is required in production/i);
  });

  test('Part B.4: F-06 twilio-signature.js: Hard-enforces validation in production even if disabled flag is passed', () => {
    const { requireTwilioSignature } = require('./twilio-signature');
    const oldEnv = process.env.NODE_ENV;
    const oldSig = process.env.TWILIO_VALIDATE_SIGNATURE;
    const oldToken = process.env.TWILIO_AUTH_TOKEN;

    try {
      process.env.NODE_ENV = 'production';
      process.env.TWILIO_VALIDATE_SIGNATURE = 'false';
      process.env.TWILIO_AUTH_TOKEN = 'test-token-min-32-chars-long-12345';

      const mw = requireTwilioSignature();
      let nextCalled = false;
      const req = {
        get: (header) => (header.toLowerCase() === 'x-twilio-signature' ? null : null),
        protocol: 'https',
        originalUrl: '/webhook/doctor-bot',
      };
      const res = {
        status: (code) => {
          assert.equal(code, 403, 'Must return 403 on missing signature');
          return res;
        },
        type: () => res,
        send: () => {},
      };

      mw(req, res, () => { nextCalled = true; });
      assert.equal(nextCalled, false, 'Middleware must NOT call next() in production when signature is missing');
    } finally {
      process.env.NODE_ENV = oldEnv;
      process.env.TWILIO_VALIDATE_SIGNATURE = oldSig;
      process.env.TWILIO_AUTH_TOKEN = oldToken;
    }
  });

  // ==========================================================================
  // PART B: F-07 Internal Service Key Strength
  // ==========================================================================

  test('Part B.5: F-07 Internal service key: Production rejects short or default key at startup', () => {
    // 1. Short key (< 32 chars)
    const resShort = spawnSync(process.execPath, [path.join(__dirname, 'server.js')], {
      env: Object.assign({}, process.env, {
        NODE_ENV: 'production',
        PORT: '0',
        STORE: 'mongo',
        MONGODB_URI: TEST_DB_URI,
        JWT_SECRET: 'test-production-secret-at-least-32-chars-long-012345',
        TWILIO_VALIDATE_SIGNATURE: 'true',
        TWILIO_AUTH_TOKEN: 'test-auth-token-min-32-chars-long-12345',
        INTERNAL_SERVICE_KEY: 'too-short-key',
      }),
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.equal(resShort.status, 1);
    assert.match(resShort.stderr, /must be at least 32 characters in production/i);

    // 2. Default/weak placeholder key
    const resWeak = spawnSync(process.execPath, [path.join(__dirname, 'server.js')], {
      env: Object.assign({}, process.env, {
        NODE_ENV: 'production',
        PORT: '0',
        STORE: 'mongo',
        MONGODB_URI: TEST_DB_URI,
        JWT_SECRET: 'test-production-secret-at-least-32-chars-long-012345',
        TWILIO_VALIDATE_SIGNATURE: 'true',
        TWILIO_AUTH_TOKEN: 'test-auth-token-min-32-chars-long-12345',
        INTERNAL_SERVICE_KEY: 'dev-voice-internal-key', // default weak placeholder
      }),
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.equal(resWeak.status, 1);
    assert.match(resWeak.stderr, /must be at least 32 characters in production/i);
  });

  // ==========================================================================
  // PART B: F-08 Sensitive Logging & Masking
  // ==========================================================================

  test('Part B.6: F-08 Sensitive logging: maskPhone masks middle digits and preserves security', () => {
    const { maskPhone } = require('./phone');
    assert.ok(typeof maskPhone === 'function', 'maskPhone helper must be available');

    assert.equal(maskPhone('+919876543210'), '+919*******10');
    assert.equal(maskPhone('+91 91111 11111'), '+91 *********11');
    assert.equal(maskPhone('9876543210'), '9876****10');
    assert.equal(maskPhone('123'), '***');
    assert.equal(maskPhone(null), '(none)');
  });

  // ==========================================================================
  // PART B: F-09 Webhook Resilience & TwiML Fallbacks
  // ==========================================================================

  test('Part B.7: F-09 Webhook resilience: Invalid / unknown clinic returns safe valid TwiML hangup', async () => {
    const callSid = `CA-UNK-${Date.now()}`;
    const to = '+91 99999 99999';
    const pathWithQuery = `/webhook/doctor-bot?CallSid=${encodeURIComponent(callSid)}&To=${encodeURIComponent(to)}`;
    const fullUrl = `${baseUrl2}${pathWithQuery}`;
    const signature = computeSignature(TEST_TWILIO_AUTH_TOKEN, fullUrl, {});

    const res = await new Promise((resolve, reject) => {
      const req = http.get(fullUrl, {
        headers: {
          'X-Twilio-Signature': signature,
          'X-Forwarded-For': nextIp(),
        },
      }, (resp) => {
        let text = '';
        resp.on('data', chunk => { text += chunk; });
        resp.on('end', () => resolve({
          status: resp.statusCode,
          contentType: resp.headers['content-type'],
          text: () => Promise.resolve(text),
        }));
      });
      req.on('error', reject);
    });

    assert.equal(res.status, 200);
    assert.match(res.contentType, /(application|text)\/xml/);
    const twiml = await res.text();
    assert.match(twiml, /<Response>/);
    assert.match(twiml, /<Say.*>.*<\/Say>/);
    assert.match(twiml, /<Hangup\/>/);
  });

  // ==========================================================================
  // PART B: Multi-Proxy publicUrl() Header Parsing
  // ==========================================================================

  test('Part B.8: Multi-proxy publicUrl() parses multi-hop X-Forwarded-Proto and X-Forwarded-Host', () => {
    const req = {
      get: (header) => {
        const h = header.toLowerCase();
        if (h === 'x-forwarded-proto') return 'https, http, http';
        if (h === 'x-forwarded-host') return 'clinic.example.com, internal-alb.us-east-1.aws';
        if (h === 'host') return 'internal-alb.us-east-1.aws';
        return null;
      },
      originalUrl: '/webhook/doctor-bot?CallSid=CA123&To=%2B919111111111',
    };

    const parsedUrl = publicUrl(req);
    assert.equal(parsedUrl, 'https://clinic.example.com/webhook/doctor-bot?CallSid=CA123&To=%2B919111111111');
    assert.ok(!parsedUrl.includes(','), 'Parsed publicUrl must never contain comma-separated proxy lists');
  });
});
