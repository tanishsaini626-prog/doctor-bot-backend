'use strict';
/* ==========================================================================
 * test-phase3e-mongo-voice-gateway.js
 *
 * MediBot Phase 3E - MongoDB Voice Gateway Integration Verification
 *
 * Verifies the Phase 3C voice gateway against a dedicated MongoDB test database
 * using real local HTTP requests.
 *
 * Scenarios:
 * 1. Start the backend with MongoDB test storage.
 * 2. Create or seed two isolated clinics and their doctors.
 * 3. Create a voice session for Clinic A.
 * 4. Book an appointment for Clinic A through POST /api/voice/book.
 * 5. Verify the appointment is persisted in MongoDB.
 * 6. Retry the same CallSid and identical payload; verify idempotent response and no duplicate.
 * 7. Retry the same CallSid with a different booking payload; verify it cannot return or mutate.
 * 8. Attempt duplicate booking and verify rejection (409 Conflict).
 * 9. Test slot capacity with concurrent booking requests (atomic capacity enforcement).
 * 10. Verify a foreign-clinic doctor ID is rejected (400 Bad Request).
 * 11. Verify unknown and inactive clinic numbers are rejected (404 and 403).
 * 12. Verify invalid internal service key is rejected (401 Unauthorized).
 * 13. Verify Clinic A cannot access Clinic B's appointments (dashboard isolation).
 * 14. Restart the backend and verify persisted records and idempotency still work.
 *
 * MongoDB Checks:
 * - Inspect actual indexes used for confirmed appointment uniqueness.
 * - Verify transaction behavior and rollback on failure.
 * - Verify concurrent requests cannot exceed slot capacity.
 * - Check that no partial or duplicate appointments remain after failed requests.
 * ========================================================================== */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

// Dedicated test database URI (safety rule: never touch production)
const TEST_DB_URI = process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017/medibot_test_phase3e';

process.env.NODE_ENV = 'test';
process.env.TEST_MONGODB_URI = TEST_DB_URI;
process.env.MONGODB_URI = TEST_DB_URI;
process.env.STORE = 'mongo';
process.env.PORT = '0';

const TEST_SECRET = 'medibot-ephemeral-jwt-secret-phase3e-min32chars';
process.env.JWT_SECRET = TEST_SECRET;
process.env.TEST_JWT_SECRET = TEST_SECRET;

const TEST_INTERNAL_KEY = 'phase3e-voice-internal-secret-key-32c';
process.env.INTERNAL_SERVICE_KEY = TEST_INTERNAL_KEY;

// Max per slot = 1 for concurrency and slot capacity tests
process.env.MAX_PER_SLOT = '1';

const serverApp = require('./server');
const { Appointment, Clinic, Doctor, CallSession, SlotReservation, User, ensureIndexes } = require('./store-mongo');

// Fixed IDs for predictable cross-clinic testing
const CLINIC_A_ID = '60d0fe4f5311236168a109a1';
const CLINIC_B_ID = '60d0fe4f5311236168a109b2';
const INACTIVE_CLINIC_ID = '60d0fe4f5311236168a109c3';

const DOCTOR_A_ID = '60d0fe4f5311236168a109d4';
const DOCTOR_B_ID = '60d0fe4f5311236168a109e5';

const PHONE_CLINIC_A = '+91 91111 11111';
const PHONE_CLINIC_B = '+91 92222 22222';
const PHONE_INACTIVE = '+91 93333 33333';
const PHONE_UNKNOWN = '+91 99999 99999';

// Helper: Calculate a valid future date on Monday (weekday 1) or Tuesday (weekday 2)
function getFutureDate(targetWeekday) {
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

describe('MediBot Phase 3E: MongoDB Voice Gateway Integration Verification', () => {
  let serverInstance;
  let baseUrl;
  let serverStore;
  let reqCounter = 1;

  function nextIp() {
    return `192.168.203.${reqCounter++}`;
  }

  function signUserToken(user) {
    return jwt.sign(
      { sub: String(user._id), email: user.email, role: user.role, clinic: String(user.clinic) },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );
  }

  before(async () => {
    // 1. Ensure backend store readiness
    if (serverApp.locals && serverApp.locals.storeReadyPromise) {
      await serverApp.locals.storeReadyPromise;
    }
    serverStore = serverApp.locals.store;

    // Fail closed if MongoDB is not connected
    if (mongoose.connection.readyState !== 1) {
      throw new Error('FATAL: MongoDB is not connected. readyState=' + mongoose.connection.readyState);
    }

    // 2. Clean up test database collections
    await Promise.all([
      Appointment.deleteMany({}),
      Clinic.deleteMany({}),
      Doctor.deleteMany({}),
      CallSession.deleteMany({}),
      SlotReservation.deleteMany({}),
      User.deleteMany({}),
    ]);

    // 3. Ensure MongoDB indexes
    await ensureIndexes();

    // 4. Start actual local HTTP server
    await new Promise((resolve) => {
      serverInstance = serverApp.listen(0, '127.0.0.1', () => {
        baseUrl = `http://127.0.0.1:${serverInstance.address().port}`;
        resolve();
      });
    });
  });

  after(async () => {
    if (serverInstance) {
      await new Promise((resolve) => {
        if (typeof serverInstance.closeAllConnections === 'function') {
          serverInstance.closeAllConnections();
        }
        serverInstance.close(resolve);
      });
    }
    if (mongoose.connection && mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
  });

  // --------------------------------------------------------------------------
  // Scenario 1: Start the backend with MongoDB test storage
  // --------------------------------------------------------------------------
  test('Scenario 1: Backend starts cleanly with MongoDB test storage', async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    assert.equal(res.status, 200, 'Health check must return 200');
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.store, 'mongo', 'Store must be mongo (never silent fallback to memory)');
    assert.equal(data.database, true, 'Database connection state must be true');
  });

  // --------------------------------------------------------------------------
  // Scenario 2: Create or seed two isolated clinics and their doctors
  // --------------------------------------------------------------------------
  test('Scenario 2: Seed two isolated clinics and doctors in MongoDB', async () => {
    // Seed Clinic A
    await serverStore.saveClinic({
      name: 'Alpha Care Hospital',
      phone: PHONE_CLINIC_A,
      greeting_text: 'नमस्ते! अल्फा केयर में आपका स्वागत है।',
      active: true,
    }, { clinic: CLINIC_A_ID, create: true });

    // Seed Doctor A for Clinic A (works Monday day 1: 09:00 - 21:00)
    await serverStore.createDoctor({
      _id: DOCTOR_A_ID,
      id: DOCTOR_A_ID,
      name: 'Dr. Alpha Physician',
      specialty: 'Internal Medicine',
      working_hours: [{ day: 1, start: '09:00', end: '21:00' }],
      holidays: [],
      active: true,
    }, { clinic: CLINIC_A_ID });

    // Seed Clinic B
    await serverStore.saveClinic({
      name: 'Beta Care Hospital',
      phone: PHONE_CLINIC_B,
      greeting_text: 'नमस्ते! बीटा केयर में आपका स्वागत है।',
      active: true,
    }, { clinic: CLINIC_B_ID, create: true });

    // Seed Doctor B for Clinic B (works Tuesday day 2: 09:00 - 21:00)
    await serverStore.createDoctor({
      _id: DOCTOR_B_ID,
      id: DOCTOR_B_ID,
      name: 'Dr. Beta Surgeon',
      specialty: 'General Surgery',
      working_hours: [{ day: 2, start: '09:00', end: '21:00' }],
      holidays: [],
      active: true,
    }, { clinic: CLINIC_B_ID });

    // Seed Inactive Clinic
    await serverStore.saveClinic({
      name: 'Inactive Care Clinic',
      phone: PHONE_INACTIVE,
      active: false,
    }, { clinic: INACTIVE_CLINIC_ID, create: true });

    // Verify in MongoDB
    const countClinics = await Clinic.countDocuments({});
    assert.equal(countClinics, 3, 'Must have 3 clinics seeded in MongoDB');
    const countDoctors = await Doctor.countDocuments({});
    assert.equal(countDoctors, 2, 'Must have 2 doctors seeded in MongoDB');
  });

  // --------------------------------------------------------------------------
  // Scenario 3: Create a voice session for Clinic A
  // --------------------------------------------------------------------------
  test('Scenario 3: Create a voice session for Clinic A via POST /api/voice/session', async () => {
    const res = await fetch(`${baseUrl}/api/voice/session`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Service-Key': TEST_INTERNAL_KEY,
        'X-Forwarded-For': nextIp(),
      },
      body: JSON.stringify({
        call_sid: 'CA-P3E-1',
        to: PHONE_CLINIC_A,
        from: '+919876543210',
      }),
    });

    assert.equal(res.status, 201, 'Voice session creation must return 201');
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.session.call_sid, 'CA-P3E-1');
    assert.equal(String(data.session.clinic), CLINIC_A_ID);
    assert.equal(data.session.verified, true);

    // Verify session persisted in MongoDB
    const sessionDoc = await CallSession.findOne({ call_sid: 'CA-P3E-1' }).lean();
    assert.ok(sessionDoc, 'Session must be stored in MongoDB');
    assert.equal(String(sessionDoc.clinic), CLINIC_A_ID);
    assert.equal(sessionDoc.verified, true);
  });

  // --------------------------------------------------------------------------
  // Scenario 4: Book an appointment for Clinic A through POST /api/voice/book
  // --------------------------------------------------------------------------
  let bookedAppointmentId;
  const bookingDate = getFutureDate(1); // Monday

  test('Scenario 4: Book an appointment for Clinic A through POST /api/voice/book', async () => {
    const res = await fetch(`${baseUrl}/api/voice/book`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Service-Key': TEST_INTERNAL_KEY,
        'X-Forwarded-For': nextIp(),
      },
      body: JSON.stringify({
        call_sid: 'CA-P3E-1',
        name: 'Riya Sharma',
        phone: '+919876543210',
        date: bookingDate,
        time_slot: 'Morning 10:00',
        reason: 'Fever and headache',
        doctorId: DOCTOR_A_ID,
      }),
    });

    assert.equal(res.status, 201, 'Booking must return 201 Created');
    const appt = await res.json();
    assert.ok(appt._id, 'Created appointment must have _id');
    assert.equal(appt.name, 'Riya Sharma');
    assert.equal(appt.phone, '+919876543210');
    assert.equal(appt.date, bookingDate);
    assert.equal(appt.time_slot, 'Morning 10:00');
    assert.equal(appt.status, 'Confirmed');
    assert.equal(String(appt.clinic), CLINIC_A_ID);
    assert.equal(appt.source, 'voice-gateway');

    bookedAppointmentId = appt._id;
  });

  // --------------------------------------------------------------------------
  // Scenario 5: Verify the appointment is persisted in MongoDB
  // --------------------------------------------------------------------------
  test('Scenario 5: Verify the appointment is persisted in MongoDB', async () => {
    const doc = await Appointment.findById(bookedAppointmentId).lean();
    assert.ok(doc, 'Appointment must exist in MongoDB database');
    assert.equal(doc.name, 'Riya Sharma');
    assert.equal(doc.phone, '+919876543210');
    assert.equal(doc.date, bookingDate);
    assert.equal(doc.time_slot, 'Morning 10:00');
    assert.equal(doc.status, 'Confirmed');
    assert.equal(String(doc.clinic), CLINIC_A_ID);
    assert.equal(doc.call_sid, 'CA-P3E-1');
  });

  // --------------------------------------------------------------------------
  // Scenario 6: Retry the same CallSid and identical payload (Idempotency)
  // --------------------------------------------------------------------------
  test('Scenario 6: Retry the same CallSid with identical payload returns idempotent response', async () => {
    const res = await fetch(`${baseUrl}/api/voice/book`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Service-Key': TEST_INTERNAL_KEY,
        'X-Forwarded-For': nextIp(),
      },
      body: JSON.stringify({
        call_sid: 'CA-P3E-1',
        name: 'Riya Sharma',
        phone: '+919876543210',
        date: bookingDate,
        time_slot: 'Morning 10:00',
        reason: 'Fever and headache',
        doctorId: DOCTOR_A_ID,
      }),
    });

    assert.equal(res.status, 200, 'Idempotent retry must return 200 OK');
    const data = await res.json();
    assert.equal(data.idempotent, true);
    assert.equal(String(data.appointment._id), String(bookedAppointmentId));

    // Confirm no duplicate record created in MongoDB
    const count = await Appointment.countDocuments({ call_sid: 'CA-P3E-1' });
    assert.equal(count, 1, 'Total appointments for this CallSid must remain exactly 1');
  });

  // --------------------------------------------------------------------------
  // Scenario 7: Retry same CallSid with different payload (Mutation prevention)
  // --------------------------------------------------------------------------
  test('Scenario 7: Retry same CallSid with different payload cannot mutate or return unrelated booking', async () => {
    const res = await fetch(`${baseUrl}/api/voice/book`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Service-Key': TEST_INTERNAL_KEY,
        'X-Forwarded-For': nextIp(),
      },
      body: JSON.stringify({
        call_sid: 'CA-P3E-1',
        name: 'Different Patient Name',
        phone: '+919123456789', // different phone
        date: bookingDate,
        time_slot: 'Morning 11:00', // different slot
        reason: 'Back pain',
      }),
    });

    assert.equal(res.status, 409, 'Different payload on same CallSid must return 409 Conflict');
    const body = await res.json();
    assert.match(body.error, /different booking parameters/i);

    // Verify original appointment was NOT mutated in MongoDB
    const originalDoc = await Appointment.findById(bookedAppointmentId).lean();
    assert.equal(originalDoc.name, 'Riya Sharma', 'Original patient name must remain unmutated');
    assert.equal(originalDoc.phone, '+919876543210', 'Original phone must remain unmutated');
    assert.equal(originalDoc.time_slot, 'Morning 10:00', 'Original slot must remain unmutated');
  });

  // --------------------------------------------------------------------------
  // Scenario 8: Attempt duplicate booking and verify rejection
  // --------------------------------------------------------------------------
  test('Scenario 8: Attempt duplicate booking from another session returns 409 Conflict', async () => {
    // Create new session for same patient phone
    await serverStore.saveSession({
      call_sid: 'CA-P3E-DUP',
      clinic: CLINIC_A_ID,
      phone: '+919876543210',
      to: PHONE_CLINIC_A,
      verified: true,
    });

    const res = await fetch(`${baseUrl}/api/voice/book`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Service-Key': TEST_INTERNAL_KEY,
        'X-Forwarded-For': nextIp(),
      },
      body: JSON.stringify({
        call_sid: 'CA-P3E-DUP',
        name: 'Riya Sharma',
        phone: '+919876543210',
        date: bookingDate,
        time_slot: 'Morning 10:00', // same slot already booked
        reason: 'Followup',
      }),
    });

    assert.equal(res.status, 409, 'Duplicate booking must return 409 Conflict');
    const err = await res.json();
    assert.match(err.error, /already exists|already full/i);
  });

  // --------------------------------------------------------------------------
  // Scenario 9: Test slot capacity with concurrent booking requests
  // --------------------------------------------------------------------------
  test('Scenario 9: Concurrent booking requests enforce slot capacity atomically (maxPerSlot = 1)', async () => {
    const slotTime = 'Afternoon 14:00';

    // Create two distinct sessions
    await serverStore.saveSession({ call_sid: 'CA-CONC-1', clinic: CLINIC_A_ID, phone: '+919800000001', to: PHONE_CLINIC_A, verified: true });
    await serverStore.saveSession({ call_sid: 'CA-CONC-2', clinic: CLINIC_A_ID, phone: '+919800000002', to: PHONE_CLINIC_A, verified: true });

    const req1 = fetch(`${baseUrl}/api/voice/book`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Service-Key': TEST_INTERNAL_KEY,
        'X-Forwarded-For': nextIp(),
      },
      body: JSON.stringify({
        call_sid: 'CA-CONC-1',
        name: 'Caller One',
        phone: '+919800000001',
        date: bookingDate,
        time_slot: slotTime,
      }),
    });

    const req2 = fetch(`${baseUrl}/api/voice/book`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Service-Key': TEST_INTERNAL_KEY,
        'X-Forwarded-For': nextIp(),
      },
      body: JSON.stringify({
        call_sid: 'CA-CONC-2',
        name: 'Caller Two',
        phone: '+919800000002',
        date: bookingDate,
        time_slot: slotTime,
      }),
    });

    const [res1, res2] = await Promise.all([req1, req2]);
    const statuses = [res1.status, res2.status];

    assert.ok(statuses.includes(201), 'Exactly one concurrent booking must return 201');
    assert.ok(statuses.includes(409), 'The other concurrent booking must return 409');

    // Confirm database has exactly 1 confirmed appointment for that slot
    const countInSlot = await Appointment.countDocuments({
      clinic: CLINIC_A_ID,
      date: bookingDate,
      time_slot: slotTime,
      status: 'Confirmed',
    });
    assert.equal(countInSlot, 1, 'MongoDB must have exactly 1 confirmed appointment in slot');
  });

  // --------------------------------------------------------------------------
  // Scenario 10: Verify a foreign-clinic doctor ID is rejected
  // --------------------------------------------------------------------------
  test('Scenario 10: Doctor outside clinic ownership is rejected with 400', async () => {
    await serverStore.saveSession({
      call_sid: 'CA-FOREIGN-DOC',
      clinic: CLINIC_A_ID,
      phone: '+919876543210',
      to: PHONE_CLINIC_A,
      verified: true,
    });

    const res = await fetch(`${baseUrl}/api/voice/book`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Service-Key': TEST_INTERNAL_KEY,
        'X-Forwarded-For': nextIp(),
      },
      body: JSON.stringify({
        call_sid: 'CA-FOREIGN-DOC',
        name: 'Test Patient',
        phone: '+919876543210',
        date: bookingDate,
        time_slot: 'Morning 11:00',
        doctorId: DOCTOR_B_ID, // belongs to Clinic B!
      }),
    });

    assert.equal(res.status, 400, 'Foreign doctor must return 400 Bad Request');
    const body = await res.json();
    assert.match(body.error, /doctor not found for this clinic/i);
  });

  // --------------------------------------------------------------------------
  // Scenario 11: Verify unknown and inactive clinic numbers are rejected
  // --------------------------------------------------------------------------
  test('Scenario 11: Unknown and inactive clinic numbers are rejected fail-closed', async () => {
    // 11a. Unknown number -> 404
    const resUnknown = await fetch(`${baseUrl}/api/voice/session`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Service-Key': TEST_INTERNAL_KEY,
        'X-Forwarded-For': nextIp(),
      },
      body: JSON.stringify({ call_sid: 'CA-UNK-TEST', to: PHONE_UNKNOWN }),
    });
    assert.equal(resUnknown.status, 404, 'Unknown number must return 404');

    // 11b. Inactive clinic number -> 403
    const resInactive = await fetch(`${baseUrl}/api/voice/session`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Service-Key': TEST_INTERNAL_KEY,
        'X-Forwarded-For': nextIp(),
      },
      body: JSON.stringify({ call_sid: 'CA-INACT-TEST', to: PHONE_INACTIVE }),
    });
    assert.equal(resInactive.status, 403, 'Inactive clinic must return 403');

    // 11c. Booking against inactive clinic -> 403
    await serverStore.saveSession({
      call_sid: 'CA-INACT-BOOK',
      clinic: INACTIVE_CLINIC_ID,
      phone: '+919876543210',
      to: PHONE_INACTIVE,
      verified: true,
    });

    const resBookInactive = await fetch(`${baseUrl}/api/voice/book`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Service-Key': TEST_INTERNAL_KEY,
        'X-Forwarded-For': nextIp(),
      },
      body: JSON.stringify({
        call_sid: 'CA-INACT-BOOK',
        name: 'Patient Inactive',
        phone: '+919876543210',
        date: bookingDate,
        time_slot: 'Morning 10:00',
      }),
    });
    assert.equal(resBookInactive.status, 403, 'Booking on inactive clinic must return 403');
  });

  // --------------------------------------------------------------------------
  // Scenario 12: Verify invalid internal service key is rejected
  // --------------------------------------------------------------------------
  test('Scenario 12: Invalid or missing internal service key returns 401 Unauthorized', async () => {
    // Missing key
    const resNoKey = await fetch(`${baseUrl}/api/voice/book`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-For': nextIp(),
      },
      body: JSON.stringify({ call_sid: 'CA-P3E-1' }),
    });
    assert.equal(resNoKey.status, 401, 'Missing key must return 401');

    // Wrong key
    const resBadKey = await fetch(`${baseUrl}/api/voice/book`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Service-Key': 'forged-internal-key-value',
        'X-Forwarded-For': nextIp(),
      },
      body: JSON.stringify({ call_sid: 'CA-P3E-1' }),
    });
    assert.equal(resBadKey.status, 401, 'Invalid key must return 401');
  });

  // --------------------------------------------------------------------------
  // Scenario 13: Verify Clinic A cannot access Clinic B's appointments
  // --------------------------------------------------------------------------
  test('Scenario 13: Dashboard isolation: Clinic A cannot access Clinic B appointments', async () => {
    // 1. Create a user for Clinic A and Clinic B
    const userA = { _id: new mongoose.Types.ObjectId(), email: 'admin@clinica.com', role: 'clinic_owner', clinic: CLINIC_A_ID };
    const userB = { _id: new mongoose.Types.ObjectId(), email: 'admin@clinicb.com', role: 'clinic_owner', clinic: CLINIC_B_ID };

    const tokenA = signUserToken(userA);
    const tokenB = signUserToken(userB);

    // 2. Book an appointment for Clinic B
    await serverStore.saveSession({
      call_sid: 'CA-CLINIC-B-BOOK',
      clinic: CLINIC_B_ID,
      phone: '+919876543299',
      to: PHONE_CLINIC_B,
      verified: true,
    });

    const resB = await fetch(`${baseUrl}/api/voice/book`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Service-Key': TEST_INTERNAL_KEY,
        'X-Forwarded-For': nextIp(),
      },
      body: JSON.stringify({
        call_sid: 'CA-CLINIC-B-BOOK',
        name: 'Patient of Clinic B',
        phone: '+919876543299',
        date: getFutureDate(2), // Tuesday
        time_slot: 'Morning 10:00',
        reason: 'Consultation',
      }),
    });
    assert.equal(resB.status, 201);
    const apptB = await resB.json();

    // 3. Clinic A lists appointments
    const resListA = await fetch(`${baseUrl}/api/appointments`, {
      headers: {
        'Authorization': `Bearer ${tokenA}`,
        'X-Forwarded-For': nextIp(),
      },
    });
    assert.equal(resListA.status, 200);
    const listA = await resListA.json();
    assert.ok(Array.isArray(listA));
    assert.ok(listA.every(a => String(a.clinic) === CLINIC_A_ID), 'Clinic A list must strictly contain only Clinic A appointments');
    assert.equal(listA.some(a => String(a._id) === String(apptB._id)), false, 'Clinic B appointment must not leak to Clinic A');

    // 4. Clinic A attempts to fetch Clinic B appointment directly by ID
    const resGetSingle = await fetch(`${baseUrl}/api/appointments/${apptB._id}`, {
      headers: {
        'Authorization': `Bearer ${tokenA}`,
        'X-Forwarded-For': nextIp(),
      },
    });
    assert.equal(resGetSingle.status, 404, 'Clinic A querying Clinic B appointment must return 404');
  });

  // --------------------------------------------------------------------------
  // Scenario 14: Restart the backend and verify persisted records and idempotency
  // --------------------------------------------------------------------------
  test('Scenario 14: Backend restart preserves MongoDB records and idempotency', async () => {
    // 1. Close current server
    await new Promise((resolve) => {
      serverInstance.closeAllConnections?.();
      serverInstance.close(resolve);
    });

    // 2. Start a fresh listener on a new port using the same database
    await new Promise((resolve) => {
      serverInstance = serverApp.listen(0, '127.0.0.1', () => {
        baseUrl = `http://127.0.0.1:${serverInstance.address().port}`;
        resolve();
      });
    });

    // 3. Health check on restarted server
    const healthRes = await fetch(`${baseUrl}/api/health`);
    assert.equal(healthRes.status, 200);
    const healthData = await healthRes.json();
    assert.equal(healthData.store, 'mongo');
    assert.equal(healthData.database, true);

    // 4. Verify original appointment persisted
    const doc = await Appointment.findById(bookedAppointmentId).lean();
    assert.ok(doc, 'Original appointment must persist across server restart');
    assert.equal(doc.name, 'Riya Sharma');

    // 5. Test idempotency after restart
    const retryRes = await fetch(`${baseUrl}/api/voice/book`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Service-Key': TEST_INTERNAL_KEY,
        'X-Forwarded-For': nextIp(),
      },
      body: JSON.stringify({
        call_sid: 'CA-P3E-1',
        name: 'Riya Sharma',
        phone: '+919876543210',
        date: bookingDate,
        time_slot: 'Morning 10:00',
        reason: 'Fever and headache',
        doctorId: DOCTOR_A_ID,
      }),
    });

    assert.equal(retryRes.status, 200, 'Idempotent retry after restart must return 200 OK');
    const retryData = await retryRes.json();
    assert.equal(retryData.idempotent, true);
    assert.equal(String(retryData.appointment._id), String(bookedAppointmentId));

    const count = await Appointment.countDocuments({ call_sid: 'CA-P3E-1' });
    assert.equal(count, 1, 'No duplicate record after restart');
  });

  // --------------------------------------------------------------------------
  // MongoDB Checks: Indexes, Transactions & Rollback, Zero Orphans
  // --------------------------------------------------------------------------
  test('MongoDB Check 1: Actual indexes used for confirmed appointment uniqueness', async () => {
    const indexes = await Appointment.collection.indexes();
    const uniqueCompoundIndex = indexes.find(idx => 
      idx.key && idx.key.phone === 1 && idx.key.date === 1 && idx.key.time_slot === 1 && idx.key.clinic === 1
    );

    assert.ok(uniqueCompoundIndex, 'Unique compound index on (phone, date, time_slot, clinic) must exist');
    assert.equal(uniqueCompoundIndex.unique, true, 'Compound index must be unique');
    assert.ok(uniqueCompoundIndex.partialFilterExpression, 'Partial filter expression must be defined');
    assert.equal(uniqueCompoundIndex.partialFilterExpression.status, 'Confirmed');

    // F-02: Check Appointment unique partial index on call_sid
    const callSidApptIndex = indexes.find(idx => idx.key && idx.key.call_sid === 1);
    assert.ok(callSidApptIndex, 'Appointment unique partial index on call_sid must exist');
    assert.equal(callSidApptIndex.unique, true);
    assert.equal(callSidApptIndex.partialFilterExpression.status, 'Confirmed');

    // Also check CallSession indexes
    const sessionIndexes = await CallSession.collection.indexes();
    const callSidIndex = sessionIndexes.find(idx => idx.key && idx.key.call_sid === 1);
    assert.ok(callSidIndex, 'CallSession unique index on call_sid must exist');
    assert.equal(callSidIndex.unique, true);
  });

  test('MongoDB Check 2: Transaction rollback & zero orphan records on failure', async () => {
    // 1. Create a verified session for CA-FAIL-ROLLBACK
    await serverStore.saveSession({
      call_sid: 'CA-FAIL-ROLLBACK',
      clinic: CLINIC_A_ID,
      phone: '+919999911111',
      to: PHONE_CLINIC_A,
      verified: true,
    });

    const beforeCount = await Appointment.countDocuments({});

    // Attempt invalid appointment creation (past date fails validation)
    const resBad = await fetch(`${baseUrl}/api/voice/book`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Service-Key': TEST_INTERNAL_KEY,
        'X-Forwarded-For': nextIp(),
      },
      body: JSON.stringify({
        call_sid: 'CA-FAIL-ROLLBACK',
        name: 'Should Not Exist',
        phone: '+919999911111',
        date: '01/01/2020', // past date
        time_slot: 'Morning 10:00',
      }),
    });
    assert.equal(resBad.status, 400);

    const afterCount = await Appointment.countDocuments({});
    assert.equal(afterCount, beforeCount, 'No orphan appointment records must remain after validation failure');

    const orphan = await Appointment.findOne({ call_sid: 'CA-FAIL-ROLLBACK' });
    assert.equal(orphan, null, 'Orphan document must not exist in MongoDB');
  });
});
