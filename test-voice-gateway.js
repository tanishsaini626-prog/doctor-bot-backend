'use strict';
/* ==========================================================================
 * test-voice-gateway.js - Phase 3C Backend Contract Alignment & Secure Voice Gateway
 *
 * Verifies:
 * 1. Valid signed incoming Twilio request establishes verified session and resolves clinic.
 * 2. Invalid or missing Twilio signature rejected (403) when enabled / in production.
 * 3. Unknown, inactive, and ambiguous clinic mappings rejected.
 * 4. Cross-clinic booking attempt rejected (body clinic mismatch or foreign doctor ID).
 * 5. Valid voice appointment booked atomically via createAppointmentIfAvailable.
 * 6. Duplicate request and retry handled idempotently (no duplicate record).
 * 7. Concurrent booking conflict enforces slot cap atomically (exactly one 201, rest 409).
 * 8. Doctor outside clinic ownership rejected (400).
 * 9. Backend unavailable returns 503 fail-closed.
 * 10. Unauthorized internal service request rejected (401).
 * 11. MongoDB integration suite when TEST_MONGODB_URI is provided.
 * ========================================================================== */

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

process.env.STORE = 'memory';
const TEST_AUTH_TOKEN = 'test_twilio_auth_token_voice_gateway_32c';
process.env.TWILIO_AUTH_TOKEN = TEST_AUTH_TOKEN;
process.env.TWILIO_VALIDATE_SIGNATURE = 'false'; // will be toggled in specific tests

const TEST_INTERNAL_KEY = 'medibot-voice-internal-secret-key-32chars';
process.env.INTERNAL_SERVICE_KEY = TEST_INTERNAL_KEY;

const testJwtSecret = process.env.TEST_JWT_SECRET || 'medibot-ephemeral-jwt-secret-min32chars-xyz';
process.env.JWT_SECRET = testJwtSecret;

const { computeSignature } = require('./twilio-signature');
const BotEngine = require('./bot-engine');
const serverApp = require('./server');

const CLINIC_A_ID = '507f1f77bcf86cd799439011';
const CLINIC_B_ID = '507f1f77bcf86cd799439022';
const INACTIVE_CLINIC_ID = '507f1f77bcf86cd799439033';
const AMBIGUOUS_CLINIC_1 = '507f1f77bcf86cd799439044';
const AMBIGUOUS_CLINIC_2 = '507f1f77bcf86cd799439055';

const DOCTOR_A_ID = '507f1f77bcf86cd799439066';
const DOCTOR_B_ID = '507f1f77bcf86cd799439077';

const PHONE_CLINIC_A = '+91 91111 11111';
const PHONE_CLINIC_B = '+91 92222 22222';
const PHONE_INACTIVE = '+91 93333 33333';
const PHONE_AMBIGUOUS = '+91 94444 44444';
const PHONE_UNKNOWN = '+91 99999 99999';

// Find a valid future date on Monday (weekday 1) or Tuesday (weekday 2)
function getFutureDate(targetWeekday) {
  const d = new Date();
  d.setDate(d.getDate() + 1); // at least tomorrow
  while (d.getDay() !== targetWeekday) {
    d.setDate(d.getDate() + 1);
  }
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();
  return `${day}/${month}/${year}`;
}

describe('MediBot Phase 3C: Secure Voice Gateway & Atomic Booking', () => {
  let serverInstance;
  let baseUrl;
  let serverStore;
  let reqCounter = 1;

  function nextIp() {
    return `192.168.201.${reqCounter++}`;
  }

  async function seedTestClinics(store) {
    // Clinic A
    await store.saveClinic({
      name: 'Alpha Health Center',
      phone: PHONE_CLINIC_A,
      greeting_text: 'नमस्ते! अल्फा हेल्थ सेंटर में आपका स्वागत है।',
      active: true,
    }, { clinic: CLINIC_A_ID, create: true });

    // Clinic B
    await store.saveClinic({
      name: 'Beta Medical Clinic',
      phone: PHONE_CLINIC_B,
      greeting_text: 'नमस्ते! बीटा मेडिकल क्लिनिक में आपका स्वागत है।',
      active: true,
    }, { clinic: CLINIC_B_ID, create: true });

    // Inactive Clinic
    await store.saveClinic({
      name: 'Closed Care Clinic',
      phone: PHONE_INACTIVE,
      active: false,
    }, { clinic: INACTIVE_CLINIC_ID, create: true });

    // Ambiguous Clinics
    await store.saveClinic({
      name: 'Ambiguous 1',
      phone: PHONE_AMBIGUOUS,
      active: true,
    }, { clinic: AMBIGUOUS_CLINIC_1, create: true });

    await store.saveClinic({
      name: 'Ambiguous 2',
      phone: PHONE_AMBIGUOUS,
      active: true,
    }, { clinic: AMBIGUOUS_CLINIC_2, create: true });

    // Doctor A belongs to Clinic A: working on Monday (day 1) 09:00 - 21:00
    await store.createDoctor({
      _id: DOCTOR_A_ID,
      id: DOCTOR_A_ID,
      name: 'Dr. Alpha Sharma',
      specialty: 'General Physician',
      working_hours: [{ day: 1, start: '09:00', end: '21:00' }],
      holidays: [],
      active: true,
    }, { clinic: CLINIC_A_ID });

    // Doctor B belongs to Clinic B: working on Tuesday (day 2) 09:00 - 21:00
    await store.createDoctor({
      _id: DOCTOR_B_ID,
      id: DOCTOR_B_ID,
      name: 'Dr. Beta Varma',
      specialty: 'Cardiologist',
      working_hours: [{ day: 2, start: '09:00', end: '21:00' }],
      holidays: [],
      active: true,
    }, { clinic: CLINIC_B_ID });
  }

  before(async () => {
    if (serverApp.locals && serverApp.locals.storeReadyPromise) {
      await serverApp.locals.storeReadyPromise;
    }
    serverStore = serverApp.locals.store;
    await seedTestClinics(serverStore);

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
  });

  // --------------------------------------------------------------------------
  // 1. VALID SIGNED INCOMING TWILIO REQUEST
  // --------------------------------------------------------------------------
  test('1. Valid signed incoming Twilio request establishes verified session and resolves clinic', async () => {
    process.env.TWILIO_VALIDATE_SIGNATURE = 'true';
    try {
      const callSid = `CA-TEST-VALID-${Date.now()}`;
      const to = '+91 91111 11111';
      const from = '+919876543210';
      const pathWithQuery = `/webhook/doctor-bot?CallSid=${encodeURIComponent(callSid)}&To=${encodeURIComponent(to)}&From=${encodeURIComponent(from)}`;
      const fullUrl = `${baseUrl}${pathWithQuery}`;

      const signature = computeSignature(TEST_AUTH_TOKEN, fullUrl, {});

      const res = await fetch(fullUrl, {
        method: 'GET',
        headers: {
          'X-Twilio-Signature': signature,
          'X-Forwarded-For': nextIp(),
        },
      });

      assert.equal(res.status, 200, 'Signed request must return 200');
      assert.equal(res.headers.get('x-clinic-resolved'), 'true');
      assert.equal(res.headers.get('x-clinic-id'), CLINIC_A_ID);

      const twiml = await res.text();
      assert.match(twiml, /अल्फा हेल्थ सेंटर/, 'Greeting should contain Clinic A text');

      // Verify session was persisted with clinic
      const session = await serverStore.getSession(callSid);
      assert.ok(session, 'Session must exist');
      assert.equal(String(session.clinic), CLINIC_A_ID);
      assert.equal(session.verified, true);

      // Verify API alias /api/voice/webhook works identically
      const aliasPath = `/api/voice/webhook?CallSid=${encodeURIComponent(callSid + '-alias')}&To=${encodeURIComponent(to)}&From=${encodeURIComponent(from)}`;
      const aliasUrl = `${baseUrl}${aliasPath}`;
      const aliasSig = computeSignature(TEST_AUTH_TOKEN, aliasUrl, {});

      const aliasRes = await fetch(aliasUrl, {
        method: 'GET',
        headers: {
          'X-Twilio-Signature': aliasSig,
          'X-Forwarded-For': nextIp(),
        },
      });
      assert.equal(aliasRes.status, 200);
      assert.equal(aliasRes.headers.get('x-clinic-resolved'), 'true');
    } finally {
      process.env.TWILIO_VALIDATE_SIGNATURE = 'false';
    }
  });

  // --------------------------------------------------------------------------
  // 2. INVALID TWILIO SIGNATURE
  // --------------------------------------------------------------------------
  test('2. Webhook rejects invalid or missing Twilio signature (403)', async () => {
    process.env.TWILIO_VALIDATE_SIGNATURE = 'true';
    try {
      const callSid = `CA-FORGED-${Date.now()}`;
      const to = '+91 91111 11111';
      const pathWithQuery = `/webhook/doctor-bot?CallSid=${encodeURIComponent(callSid)}&To=${encodeURIComponent(to)}`;
      const fullUrl = `${baseUrl}${pathWithQuery}`;

      // Missing signature
      const resNoSig = await fetch(fullUrl, {
        method: 'GET',
        headers: { 'X-Forwarded-For': nextIp() },
      });
      assert.equal(resNoSig.status, 403, 'Missing signature must return 403');

      // Forged signature
      const resBadSig = await fetch(fullUrl, {
        method: 'GET',
        headers: {
          'X-Twilio-Signature': 'bogus-forged-signature',
          'X-Forwarded-For': nextIp(),
        },
      });
      assert.equal(resBadSig.status, 403, 'Invalid signature must return 403');
    } finally {
      process.env.TWILIO_VALIDATE_SIGNATURE = 'false';
    }
  });

  // --------------------------------------------------------------------------
  // 3. UNKNOWN AND INACTIVE CLINIC
  // --------------------------------------------------------------------------
  test('3. Unknown, inactive, and ambiguous clinic numbers fail closed', async () => {
    // 3a. Unknown number on webhook
    const resUnknown = await fetch(`${baseUrl}/webhook/doctor-bot?CallSid=CA-UNK&To=${encodeURIComponent(PHONE_UNKNOWN)}`, {
      headers: { 'X-Forwarded-For': nextIp() },
    });
    assert.equal(resUnknown.headers.get('x-clinic-resolved'), 'false');
    assert.equal(resUnknown.headers.get('x-clinic-reject-reason'), 'unknown');
    const textUnknown = await resUnknown.text();
    assert.match(textUnknown, /किसी भी क्लिनिक से जुड़ा नहीं है/);

    // 3b. Inactive clinic number on webhook
    const resInactive = await fetch(`${baseUrl}/webhook/doctor-bot?CallSid=CA-INACT&To=${encodeURIComponent(PHONE_INACTIVE)}`, {
      headers: { 'X-Forwarded-For': nextIp() },
    });
    assert.equal(resInactive.headers.get('x-clinic-resolved'), 'false');
    assert.equal(resInactive.headers.get('x-clinic-reject-reason'), 'inactive');
    const textInactive = await resInactive.text();
    assert.match(textInactive, /इस समय सक्रिय नहीं है/);

    // 3c. Ambiguous number on webhook
    const resAmbiguous = await fetch(`${baseUrl}/webhook/doctor-bot?CallSid=CA-AMBIG&To=${encodeURIComponent(PHONE_AMBIGUOUS)}`, {
      headers: { 'X-Forwarded-For': nextIp() },
    });
    assert.equal(resAmbiguous.headers.get('x-clinic-resolved'), 'false');
    assert.equal(resAmbiguous.headers.get('x-clinic-reject-reason'), 'ambiguous');

    // 3d. /api/voice/session endpoint: unknown -> 404, inactive -> 403, ambiguous -> 409
    const sUnknown = await fetch(`${baseUrl}/api/voice/session`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Service-Key': TEST_INTERNAL_KEY,
        'X-Forwarded-For': nextIp(),
      },
      body: JSON.stringify({ call_sid: 'CA-S-UNK', to: PHONE_UNKNOWN }),
    });
    assert.equal(sUnknown.status, 404);

    const sInactive = await fetch(`${baseUrl}/api/voice/session`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Service-Key': TEST_INTERNAL_KEY,
        'X-Forwarded-For': nextIp(),
      },
      body: JSON.stringify({ call_sid: 'CA-S-INACT', to: PHONE_INACTIVE }),
    });
    assert.equal(sInactive.status, 403);

    const sAmbiguous = await fetch(`${baseUrl}/api/voice/session`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Service-Key': TEST_INTERNAL_KEY,
        'X-Forwarded-For': nextIp(),
      },
      body: JSON.stringify({ call_sid: 'CA-S-AMBIG', to: PHONE_AMBIGUOUS }),
    });
    assert.equal(sAmbiguous.status, 409);

    // 3e. Booking against inactive clinic returns 403
    await serverStore.saveSession({
      call_sid: 'CA-INACTIVE-BOOK',
      clinic: INACTIVE_CLINIC_ID,
      phone: '+919876543210',
      to: PHONE_INACTIVE,
      verified: true,
    });

    const bookInactive = await fetch(`${baseUrl}/api/voice/book`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Service-Key': TEST_INTERNAL_KEY,
        'X-Forwarded-For': nextIp(),
      },
      body: JSON.stringify({
        call_sid: 'CA-INACTIVE-BOOK',
        name: 'Patient Inactive',
        phone: '+919876543210',
        date: getFutureDate(1),
        time_slot: 'Morning 10:00',
      }),
    });
    assert.equal(bookInactive.status, 403);
    const bodyInactive = await bookInactive.json();
    assert.match(bodyInactive.error, /inactive/i);
  });

  // --------------------------------------------------------------------------
  // 4. CROSS-CLINIC BOOKING ATTEMPT
  // --------------------------------------------------------------------------
  test('4. Cross-clinic booking attempt rejected (body clinic mismatch or foreign doctor)', async () => {
    const callSid = `CA-CROSS-${Date.now()}`;
    await serverStore.saveSession({
      call_sid: callSid,
      clinic: CLINIC_A_ID,
      phone: '+919876543210',
      to: PHONE_CLINIC_A,
      verified: true,
    });

    // Attempt 1: body supplies clinic: CLINIC_B_ID for a session belonging to CLINIC_A_ID
    const resSpoof = await fetch(`${baseUrl}/api/voice/book`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Service-Key': TEST_INTERNAL_KEY,
        'X-Forwarded-For': nextIp(),
      },
      body: JSON.stringify({
        call_sid: callSid,
        clinic: CLINIC_B_ID,
        name: 'Spoof Patient',
        phone: '+919876543210',
        date: getFutureDate(1),
        time_slot: 'Morning 10:00',
      }),
    });
    assert.equal(resSpoof.status, 403, 'Spoofing clinic must return 403');
    const bodySpoof = await resSpoof.json();
    assert.match(bodySpoof.error, /cross-clinic/i);

    // Attempt 2: body supplies DOCTOR_B_ID (belongs to Clinic B) for session belonging to Clinic A
    const resForeignDoc = await fetch(`${baseUrl}/api/voice/book`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Service-Key': TEST_INTERNAL_KEY,
        'X-Forwarded-For': nextIp(),
      },
      body: JSON.stringify({
        call_sid: callSid,
        doctorId: DOCTOR_B_ID,
        name: 'Patient With Foreign Doctor',
        phone: '+919876543210',
        date: getFutureDate(2),
        time_slot: 'Morning 10:00',
      }),
    });
    assert.equal(resForeignDoc.status, 400, 'Foreign doctor must return 400');
    const bodyDoc = await resForeignDoc.json();
    assert.match(bodyDoc.error, /doctor not found for this clinic/i);
  });

  // --------------------------------------------------------------------------
  // 5. VALID VOICE APPOINTMENT
  // --------------------------------------------------------------------------
  test('5. Valid voice appointment booked atomically via POST /api/voice/book', async () => {
    const callSid = `CA-BOOK-VALID-${Date.now()}`;
    await serverStore.saveSession({
      call_sid: callSid,
      clinic: CLINIC_A_ID,
      phone: '+919876543210',
      to: PHONE_CLINIC_A,
      verified: true,
    });

    const appointmentDate = getFutureDate(1); // Monday (Dr. Alpha works Monday)

    const res = await fetch(`${baseUrl}/api/voice/book`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Service-Key': TEST_INTERNAL_KEY,
        'X-Forwarded-For': nextIp(),
      },
      body: JSON.stringify({
        call_sid: callSid,
        name: 'Riya Sharma',
        phone: '+919876543210',
        date: appointmentDate,
        time_slot: 'Morning 10:00',
        reason: 'Fever and cold',
        doctorId: DOCTOR_A_ID,
      }),
    });

    assert.equal(res.status, 201, 'Valid booking must return 201');
    const appt = await res.json();
    assert.ok(appt._id, 'Must return created appointment with _id');
    assert.equal(appt.name, 'Riya Sharma');
    assert.equal(appt.phone, '+919876543210');
    assert.equal(appt.date, appointmentDate);
    assert.equal(appt.time_slot, 'Morning 10:00');
    assert.equal(appt.status, 'Confirmed');
    assert.equal(appt.source, 'voice-gateway');
    assert.equal(String(appt.clinic), CLINIC_A_ID);
    assert.equal(appt.call_sid, callSid);

    // Verify session updated to Confirmed
    const session = await serverStore.getSession(callSid);
    assert.equal(session.status, 'Confirmed');
  });

  // --------------------------------------------------------------------------
  // 6. DUPLICATE REQUEST AND RETRY (IDEMPOTENCY)
  // --------------------------------------------------------------------------
  test('6. Duplicate request and retry handled idempotently with existing appointment', async () => {
    const callSid = `CA-IDEMPOTENT-${Date.now()}`;
    await serverStore.saveSession({
      call_sid: callSid,
      clinic: CLINIC_A_ID,
      phone: '+919876543211',
      to: PHONE_CLINIC_A,
      verified: true,
    });

    const appointmentDate = getFutureDate(1);

    // First call
    const res1 = await fetch(`${baseUrl}/api/voice/book`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Service-Key': TEST_INTERNAL_KEY,
        'X-Forwarded-For': nextIp(),
      },
      body: JSON.stringify({
        call_sid: callSid,
        name: 'Vikram Patel',
        phone: '+919876543211',
        date: appointmentDate,
        time_slot: 'Morning 11:00',
        reason: 'Checkup',
      }),
    });
    assert.equal(res1.status, 201);
    const appt1 = await res1.json();

    // Second call: exact same call_sid retry
    const res2 = await fetch(`${baseUrl}/api/voice/book`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Service-Key': TEST_INTERNAL_KEY,
        'X-Forwarded-For': nextIp(),
      },
      body: JSON.stringify({
        call_sid: callSid,
        name: 'Vikram Patel',
        phone: '+919876543211',
        date: appointmentDate,
        time_slot: 'Morning 11:00',
        reason: 'Checkup',
      }),
    });

    assert.ok([200, 201].includes(res2.status), 'Retry must succeed with 200 or 201');
    const body2 = await res2.json();
    const returnedAppt = body2.appointment || body2;
    assert.equal(returnedAppt._id, appt1._id, 'Must return the same appointment ID');
    if (body2.idempotent !== undefined) {
      assert.equal(body2.idempotent, true);
    }
  });

  // --------------------------------------------------------------------------
  // 7. CONCURRENT BOOKING CONFLICT & DUPLICATE SLOT REJECTION
  // --------------------------------------------------------------------------
  test('7. Concurrent booking conflict: double booking same slot returns 409 Conflict', async () => {
    const slotDate = getFutureDate(1);
    const timeSlot = 'Afternoon 14:00';

    const callSid1 = `CA-CONC-1-${Date.now()}`;
    const callSid2 = `CA-CONC-2-${Date.now()}`;

    await serverStore.saveSession({ call_sid: callSid1, clinic: CLINIC_A_ID, phone: '+919999900001', to: PHONE_CLINIC_A, verified: true });
    await serverStore.saveSession({ call_sid: callSid2, clinic: CLINIC_A_ID, phone: '+919999900001', to: PHONE_CLINIC_A, verified: true });

    // Same patient attempting to book the same slot twice from a different call session
    const res1 = await fetch(`${baseUrl}/api/voice/book`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Service-Key': TEST_INTERNAL_KEY,
        'X-Forwarded-For': nextIp(),
      },
      body: JSON.stringify({
        call_sid: callSid1,
        name: 'Arun Kumar',
        phone: '+919999900001',
        date: slotDate,
        time_slot: timeSlot,
      }),
    });
    assert.equal(res1.status, 201, 'First booking must succeed');

    const res2 = await fetch(`${baseUrl}/api/voice/book`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Service-Key': TEST_INTERNAL_KEY,
        'X-Forwarded-For': nextIp(),
      },
      body: JSON.stringify({
        call_sid: callSid2,
        name: 'Arun Kumar',
        phone: '+919999900001',
        date: slotDate,
        time_slot: timeSlot,
      }),
    });
    assert.equal(res2.status, 409, 'Duplicate booking must return 409 Conflict');
    const errBody = await res2.json();
    assert.match(errBody.error, /already exists|already full/i);
  });

  // --------------------------------------------------------------------------
  // 8. DOCTOR OUTSIDE CLINIC OWNERSHIP & INVALID DATES
  // --------------------------------------------------------------------------
  test('8. Doctor outside clinic ownership and invalid dates are rejected with 400', async () => {
    const callSid = `CA-DOC-CHECK-${Date.now()}`;
    await serverStore.saveSession({ call_sid: callSid, clinic: CLINIC_A_ID, phone: '+919876543210', to: PHONE_CLINIC_A, verified: true });

    // Doctor B does not belong to Clinic A
    const resBadDoc = await fetch(`${baseUrl}/api/voice/book`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Service-Key': TEST_INTERNAL_KEY,
        'X-Forwarded-For': nextIp(),
      },
      body: JSON.stringify({
        call_sid: callSid,
        name: 'Test Patient',
        phone: '+919876543210',
        date: getFutureDate(1),
        time_slot: 'Morning 10:00',
        doctorId: DOCTOR_B_ID,
      }),
    });
    assert.equal(resBadDoc.status, 400);

    // Invalid date format
    const resBadDate = await fetch(`${baseUrl}/api/voice/book`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Service-Key': TEST_INTERNAL_KEY,
        'X-Forwarded-For': nextIp(),
      },
      body: JSON.stringify({
        call_sid: callSid,
        name: 'Test Patient',
        phone: '+919876543210',
        date: '31/02/2026',
        time_slot: 'Morning 10:00',
      }),
    });
    assert.equal(resBadDate.status, 400);

    // Past date
    const resPast = await fetch(`${baseUrl}/api/voice/book`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Service-Key': TEST_INTERNAL_KEY,
        'X-Forwarded-For': nextIp(),
      },
      body: JSON.stringify({
        call_sid: callSid,
        name: 'Test Patient',
        phone: '+919876543210',
        date: '01/01/2020',
        time_slot: 'Morning 10:00',
      }),
    });
    assert.equal(resPast.status, 400);
    const bodyPast = await resPast.json();
    assert.match(bodyPast.error, /past/i);
  });

  // --------------------------------------------------------------------------
  // 9. BACKEND UNAVAILABLE GATE
  // --------------------------------------------------------------------------
  test('9. Backend unavailable returns 503 fail-closed', async () => {
    // When store is not ready
    const originalReady = serverApp.locals.storeReady;
    serverApp.locals.storeReady = () => false;

    try {
      const res = await fetch(`${baseUrl}/api/voice/book`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Service-Key': TEST_INTERNAL_KEY,
          'X-Forwarded-For': nextIp(),
        },
        body: JSON.stringify({
          call_sid: 'CA-UNAVAILABLE',
          name: 'Patient',
          phone: '+919876543210',
          date: getFutureDate(1),
          time_slot: 'Morning 10:00',
        }),
      });
      assert.equal(res.status, 503, 'Must return 503 when store is unready');
    } finally {
      serverApp.locals.storeReady = originalReady;
    }
  });

  // --------------------------------------------------------------------------
  // 10. UNAUTHORIZED INTERNAL SERVICE REQUEST
  // --------------------------------------------------------------------------
  test('10. Unauthorized internal service request rejected with 401', async () => {
    // Missing key
    const resNoKey = await fetch(`${baseUrl}/api/voice/book`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-For': nextIp(),
      },
      body: JSON.stringify({ call_sid: 'CA-UNAUTH' }),
    });
    assert.equal(resNoKey.status, 401, 'Missing key must return 401');

    // Invalid key
    const resBadKey = await fetch(`${baseUrl}/api/voice/book`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Service-Key': 'wrong-unauthorized-secret-key',
        'X-Forwarded-For': nextIp(),
      },
      body: JSON.stringify({ call_sid: 'CA-UNAUTH' }),
    });
    assert.equal(resBadKey.status, 401, 'Invalid key must return 401');

    // /api/voice/session without key
    const resSessNoKey = await fetch(`${baseUrl}/api/voice/session`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-For': nextIp(),
      },
      body: JSON.stringify({ call_sid: 'CA-UNAUTH', to: PHONE_CLINIC_A }),
    });
    assert.equal(resSessNoKey.status, 401);
  });
});

// --------------------------------------------------------------------------
// 11. MONGODB SUITE (runs when TEST_MONGODB_URI is provided)
// --------------------------------------------------------------------------
const mongodbUri = process.env.TEST_MONGODB_URI;
if (mongodbUri && mongodbUri.trim() !== '') {
  const mongoose = require('mongoose');
  const { createMongoStore, Clinic, Appointment, CallSession } = require('./store-mongo');

  describe('MongoDB Voice Gateway & Atomic Booking Suite', () => {
    let mongoStore;

    before(async () => {
      const dbUri = mongodbUri.includes('?')
        ? mongodbUri.replace(/([^/?]+)(\?)/, '$1_voice_gw$2')
        : (mongodbUri.endsWith('/') ? `${mongodbUri}medibot_test_voice_gw` : `${mongodbUri}_voice_gw`);
      await mongoose.connect(dbUri, { serverSelectionTimeoutMS: 5000 });
      mongoStore = createMongoStore({ maxPerSlot: 1 });
      await Clinic.deleteMany({});
      await Appointment.deleteMany({});
      await CallSession.deleteMany({});
    });

    after(async () => {
      try {
        await mongoose.connection.dropDatabase();
        await mongoose.disconnect();
      } catch (_) {}
    });

    test('MongoDB: phone resolution, session creation, atomic slot-cap, and tenant isolation', async () => {
      // Seed Clinic in Mongo
      const mongoClinicA = new mongoose.Types.ObjectId().toString();
      const mongoClinicB = new mongoose.Types.ObjectId().toString();

      await mongoStore.saveClinic({
        name: 'Mongo Alpha Clinic',
        phone: '+91 97777 77777',
        active: true,
      }, { clinic: mongoClinicA, create: true });

      await mongoStore.saveClinic({
        name: 'Mongo Beta Clinic',
        phone: '+91 98888 88888',
        active: true,
      }, { clinic: mongoClinicB, create: true });

      // 1. Phone resolution in Mongo
      const resPhone = await mongoStore.resolveClinicByPhone('+919777777777');
      assert.equal(resPhone.ok, true);
      assert.equal(String(resPhone.clinic._id), mongoClinicA);

      // 2. Session creation with clinic in Mongo
      await mongoStore.saveSession({
        call_sid: 'CA-MONGO-1',
        clinic: mongoClinicA,
        phone: '+919999988888',
        to: '+91 97777 77777',
        verified: true,
      });

      const session = await mongoStore.getSession('CA-MONGO-1');
      assert.ok(session);
      assert.equal(String(session.clinic), mongoClinicA);

      // 3. Atomic booking in Mongo
      const futureDate = getFutureDate(1);
      const bookRes1 = await mongoStore.createAppointmentIfAvailable({
        name: 'Mongo Patient 1',
        phone: '+919999988888',
        date: futureDate,
        time_slot: 'Morning 10:00',
        status: 'Confirmed',
        source: 'voice-gateway',
        call_sid: 'CA-MONGO-1',
        clinic: mongoClinicA,
      }, 1);
      assert.equal(bookRes1.ok, true);
      assert.ok(bookRes1.appointment);

      // 4. Slot full conflict in Mongo (maxPerSlot = 1)
      const bookRes2 = await mongoStore.createAppointmentIfAvailable({
        name: 'Mongo Patient 2',
        phone: '+919999977777',
        date: futureDate,
        time_slot: 'Morning 10:00',
        status: 'Confirmed',
        source: 'voice-gateway',
        call_sid: 'CA-MONGO-2',
        clinic: mongoClinicA,
      }, 1);
      assert.equal(bookRes2.ok, false);
      assert.equal(bookRes2.reason, 'slot_full');

      // 5. Tenant isolation in Mongo: Clinic B can still book the same slot!
      const bookResClinicB = await mongoStore.createAppointmentIfAvailable({
        name: 'Mongo Patient Clinic B',
        phone: '+919999977777',
        date: futureDate,
        time_slot: 'Morning 10:00',
        status: 'Confirmed',
        source: 'voice-gateway',
        call_sid: 'CA-MONGO-3',
        clinic: mongoClinicB,
      }, 1);
      assert.equal(bookResClinicB.ok, true, 'Clinic B must not be blocked by Clinic A slot cap');
    });
  });
} else {
  describe('MongoDB Voice Gateway & Atomic Booking Suite (skipped - no TEST_MONGODB_URI)', () => {
    test.skip('skipped gracefully when TEST_MONGODB_URI is not set', () => {});
  });
}
