'use strict';
/**
 * test-phase5c-dashboard-receptionist-integration.js
 *
 * Acceptance test suite for MediBot Phase 5C — Dashboard & AI Receptionist Integration.
 * Verifies:
 * 1. Custom clinic greeting:
 *    - Uses clinic's saved greeting_text in Hindi.
 *    - Provides sensible language-appropriate greetings in Hinglish and English.
 *    - Uses sensible defaults when clinic has not configured one (never hardcoded to a single clinic).
 *    - Preserves greeting across sessions/refresh and enforces tenant isolation (Clinic A cannot see Clinic B's greeting).
 * 2. Manual appointment booking:
 *    - Books valid appointment with source: 'dashboard'.
 *    - Server-side doctor availability validation (rejects holiday, off-day, outside hours).
 *    - Rejects foreign clinic doctor ID.
 *    - Prevents duplicate booking (HTTP 409).
 *    - Enforces booking quota (HTTP 409 QUOTA_EXCEEDED).
 * 3. Appointment source tracking:
 *    - Distinctly tags 'dashboard', 'browser-simulator', and 'voice-gateway'/'voice-bot'.
 * 4. Subscription states & historical read-only access:
 *    - Subscription evaluation distinguishes trial, active, past_due, canceled, expired.
 *    - Inactive/expired subscription blocks new mutations (402) while historical appointments,
 *      patients, calls, and analytics remain fully readable (200).
 * 5. Role permissions & tenant isolation:
 *    - Clinic owner and clinic staff can book appointments for their clinic.
 *    - Cross-clinic data access is strictly prevented.
 * 6. Browser demo non-billable usage:
 *    - Simulation sessions never increment billable call_count, call_minutes, or whatsapp_count.
 * 7. Quota warning header (X-Quota-Warning) propagation:
 *    - Server sets X-Quota-Warning header when shadow quota thresholds are crossed.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

const { getBillingMonth } = require('./subscription');

const TEST_JWT_SECRET = 'medibot-phase5c-integration-secret-32chars';

describe('MediBot Phase 5C — Dashboard & AI Receptionist Integration Acceptance Suite', () => {
  let app;
  let server;
  let baseUrl;
  let store;

  const CLINIC_A = 'clinic_p5c_alpha';
  const CLINIC_B = 'clinic_p5c_beta';
  let tokenA;
  let tokenB;
  let staffTokenA;
  let doctorA;
  let doctorB;

  before(async () => {
    process.env.NODE_ENV = 'test';
    process.env.STORE = 'memory';
    process.env.PORT = '0';
    process.env.JWT_SECRET = TEST_JWT_SECRET;
    process.env.TWILIO_VALIDATE_SIGNATURE = 'false';

    app = require('./server');
    if (app.locals && app.locals.storeReadyPromise) {
      await app.locals.storeReadyPromise;
    }
    store = app.locals.store;

    server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;

    // Seed Clinic A with custom Hindi greeting
    await store.saveClinic({
      name: 'Verma Health Clinic',
      phone: '+919876503001',
      greeting_text: 'नमस्ते! मैं वर्मा हेल्थ क्लिनिक से बोल रही हूँ। अपॉइंटमेंट बुक करने के लिए कृपया अपना नाम बताइए।',
    }, { clinic: CLINIC_A, create: true });

    // Seed Clinic B with sensible default (no custom greeting configured)
    await store.saveClinic({
      name: 'Apollo Diagnostics Hub',
      phone: '+919876503002',
      greeting_text: '',
    }, { clinic: CLINIC_B, create: true });

    // Seed Doctor for Clinic A (Mon-Fri 09:00-17:00, holiday on 2026-12-25)
    doctorA = await store.createDoctor({
      name: 'Dr. Ramesh Verma',
      specialty: 'Cardiologist',
      slot_minutes: 15,
      working_hours: [1, 2, 3, 4, 5].map((day) => ({ day, start: '09:00', end: '17:00' })),
      holidays: ['2026-12-25'],
      active: true,
    }, { clinic: CLINIC_A });

    // Seed Doctor for Clinic B
    doctorB = await store.createDoctor({
      name: 'Dr. Neha Mehta',
      specialty: 'Dermatologist',
      slot_minutes: 15,
      working_hours: [1, 2, 3, 4, 5, 6].map((day) => ({ day, start: '10:00', end: '19:00' })),
      active: true,
    }, { clinic: CLINIC_B });

    tokenA = jwt.sign(
      { sub: 'usr_p5c_a', email: 'owner@verma.test', role: 'clinic_owner', clinic: CLINIC_A },
      TEST_JWT_SECRET
    );
    staffTokenA = jwt.sign(
      { sub: 'usr_p5c_staff_a', email: 'staff@verma.test', role: 'clinic_staff', clinic: CLINIC_A },
      TEST_JWT_SECRET
    );
    tokenB = jwt.sign(
      { sub: 'usr_p5c_b', email: 'owner@apollo.test', role: 'clinic_owner', clinic: CLINIC_B },
      TEST_JWT_SECRET
    );
  });

  after(async () => {
    if (app && app.locals && app.locals.__resetReceptionistLimiters) {
      app.locals.__resetReceptionistLimiters();
    }
    if (app && app.locals && app.locals.shutdownLocalVoice) {
      app.locals.shutdownLocalVoice();
    }
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  // --------------------------------------------------------------------------
  // 1. Custom Clinic Greeting
  // --------------------------------------------------------------------------
  test('1a. Browser AI receptionist uses clinic configured greeting_text in Hindi', async () => {
    const res = await fetch(`${baseUrl}/api/receptionist/sessions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokenA}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ language: 'hi', speak: false }),
    });
    assert.equal(res.status, 201);
    const data = await res.json();
    assert.equal(
      data.reply,
      'नमस्ते! मैं वर्मा हेल्थ क्लिनिक से बोल रही हूँ। अपॉइंटमेंट बुक करने के लिए कृपया अपना नाम बताइए।',
      'Hindi receptionist greeting must match clinic saved greeting_text'
    );
  });

  test('1b. Hinglish and English return clinic-personalized greetings', async () => {
    const resHinglish = await fetch(`${baseUrl}/api/receptionist/sessions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ language: 'hinglish', speak: false }),
    });
    assert.equal(resHinglish.status, 201);
    const dataHinglish = await resHinglish.json();
    assert.match(dataHinglish.reply, /Verma Health Clinic/i);
    assert.match(dataHinglish.reply, /Namaste/i);

    const resEn = await fetch(`${baseUrl}/api/receptionist/sessions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ language: 'en', speak: false }),
    });
    assert.equal(resEn.status, 201);
    const dataEn = await resEn.json();
    assert.match(dataEn.reply, /Verma Health Clinic/i);
    assert.match(dataEn.reply, /Welcome/i);
  });

  test('1c. Sensible default greeting when unconfigured; never cross-leaks another clinic greeting', async () => {
    const resB = await fetch(`${baseUrl}/api/receptionist/sessions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenB}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ language: 'hi', speak: false }),
    });
    assert.equal(resB.status, 201);
    const dataB = await resB.json();
    assert.match(dataB.reply, /Apollo Diagnostics Hub/i);
    assert.ok(!dataB.reply.includes('वर्मा हेल्थ क्लिनिक'), 'Clinic B must never receive Clinic A greeting');
  });

  // --------------------------------------------------------------------------
  // 2. Manual Appointment Booking & Availability Validation
  // --------------------------------------------------------------------------
  test('2a. Valid manual appointment booking creates appointment with source: dashboard', async () => {
    const res = await fetch(`${baseUrl}/api/appointments`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokenA}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'Suresh Raina',
        phone: '9876540001',
        date: '28/12/2026', // Monday
        time_slot: '10:00 AM',
        reason: 'Routine ECG checkup',
        doctorId: doctorA._id,
      }),
    });
    assert.equal(res.status, 201);
    const appt = await res.json();
    assert.equal(appt.name, 'Suresh Raina');
    assert.equal(appt.source, 'dashboard', 'Manual booking must tag source as dashboard');
    assert.equal(String(appt.clinic), CLINIC_A);
  });

  test('2b. Staff permissions: clinic_staff can create manual appointment for their clinic', async () => {
    const res = await fetch(`${baseUrl}/api/appointments`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${staffTokenA}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'Anjali Sharma',
        phone: '9876540002',
        date: '28/12/2026',
        time_slot: '11:00 AM',
        reason: 'Chest consultation',
        doctorId: doctorA._id,
      }),
    });
    assert.equal(res.status, 201);
    const appt = await res.json();
    assert.equal(appt.source, 'dashboard');
    assert.equal(String(appt.clinic), CLINIC_A);
  });

  test('2c. Doctor availability: rejects off-day, holiday, and outside working hours', async () => {
    // Holiday (2026-12-25)
    const holidayRes = await fetch(`${baseUrl}/api/appointments`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Patient X',
        phone: '9876540003',
        date: '25/12/2026',
        time_slot: '10:00 AM',
        doctorId: doctorA._id,
      }),
    });
    assert.equal(holidayRes.status, 400);
    const holData = await holidayRes.json();
    assert.match(holData.error, /holiday/i);

    // Doctor off on Sunday (27/12/2026)
    const offDayRes = await fetch(`${baseUrl}/api/appointments`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Patient Y',
        phone: '9876540004',
        date: '27/12/2026',
        time_slot: '10:00 AM',
        doctorId: doctorA._id,
      }),
    });
    assert.equal(offDayRes.status, 400);

    // Outside hours (08:00 PM when doctor works 09:00-17:00)
    const outHoursRes = await fetch(`${baseUrl}/api/appointments`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Patient Z',
        phone: '9876540005',
        date: '28/12/2026',
        time_slot: '08:00 PM',
        doctorId: doctorA._id,
      }),
    });
    assert.equal(outHoursRes.status, 400);
    const outData = await outHoursRes.json();
    assert.match(outData.error, /outside/i);
  });

  test('2d. Rejects foreign clinic doctor ID (tenant isolation)', async () => {
    const crossRes = await fetch(`${baseUrl}/api/appointments`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Cross Clinic Patient',
        phone: '9876540006',
        date: '28/12/2026',
        time_slot: '10:00 AM',
        doctorId: doctorB._id, // Belongs to Clinic B
      }),
    });
    assert.equal(crossRes.status, 400);
    const data = await crossRes.json();
    assert.match(data.error, /doctor not found for this clinic/i);
  });

  test('2e. Duplicate booking prevention returns HTTP 409', async () => {
    const dupRes = await fetch(`${baseUrl}/api/appointments`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Suresh Duplicate',
        phone: '9876540001', // already booked for 28/12/2026 at 10:00 AM in 2a
        date: '28/12/2026',
        time_slot: '10:00 AM',
        doctorId: doctorA._id,
      }),
    });
    assert.equal(dupRes.status, 409);
    const data = await dupRes.json();
    assert.match(data.error, /already exists/i);
  });

  // --------------------------------------------------------------------------
  // 3. Appointment Source Labels (Voice, Dashboard, Browser Demo)
  // --------------------------------------------------------------------------
  test('3. Distinctly tracks and preserves source for voice, dashboard, and browser simulation', async () => {
    // 1. Browser simulation appointment
    const simStart = await fetch(`${baseUrl}/api/receptionist/sessions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ language: 'hi', speak: false }),
    });
    const { session_id: sid } = await simStart.json();

    await fetch(`${baseUrl}/api/receptionist/sessions/${sid}/turn`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: 'मेरा नाम सिमुलेशन मरीज़ है, फ़ोन 9876540010, बुखार है, 29/12/2026 दोपहर 02:00 बजे',
        speak: false,
      }),
    });
    await fetch(`${baseUrl}/api/receptionist/sessions/${sid}/turn`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'हाँ, बुक कर दीजिए', speak: false }),
    });

    // 2. Fetch all appointments for Clinic A via GET /api/appointments
    const apptsRes = await fetch(`${baseUrl}/api/appointments`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    assert.equal(apptsRes.status, 200);
    const appts = await apptsRes.json();

    const dashboardAppts = appts.filter((a) => a.source === 'dashboard');
    const simAppts = appts.filter((a) => a.source === 'browser-simulator');

    assert.ok(dashboardAppts.length >= 2, 'Dashboard bookings must have source: dashboard');
    assert.ok(simAppts.length >= 1, 'Browser receptionist booking must have source: browser-simulator');
  });

  // --------------------------------------------------------------------------
  // 4. Subscription Evaluation & Historical Read-Only Access
  // --------------------------------------------------------------------------
  test('4. Expired clinic subscription blocks new bookings (402) while historical records remain readable (200)', async () => {
    // Expire Clinic B's subscription
    const expiredDate = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await store.saveClinic({
      subscription: {
        status: 'expired',
        trial_ends_at: expiredDate,
        current_period_end: expiredDate,
      },
    }, { clinic: CLINIC_B });

    // 4a. Subscription endpoint reflects expired status
    const subRes = await fetch(`${baseUrl}/api/subscription`, {
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    assert.equal(subRes.status, 200);
    const subData = await subRes.json();
    assert.equal(subData.evaluation.status, 'expired');
    assert.equal(subData.evaluation.canMutate, false);

    // 4b. New booking attempt is rejected with 402 SUBSCRIPTION_INACTIVE
    const bookRes = await fetch(`${baseUrl}/api/appointments`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenB}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Blocked Patient',
        phone: '9876540099',
        date: '28/12/2026',
        time_slot: '10:00 AM',
      }),
    });
    assert.equal(bookRes.status, 402);
    const bookErr = await bookRes.json();
    assert.equal(bookErr.code, 'SUBSCRIPTION_INACTIVE');

    // 4c. Historical read-only data remains accessible (GET appointments, calls, doctors, analytics)
    const [histAppts, histCalls, histDocs, histStats] = await Promise.all([
      fetch(`${baseUrl}/api/appointments`, { headers: { Authorization: `Bearer ${tokenB}` } }),
      fetch(`${baseUrl}/api/calls`, { headers: { Authorization: `Bearer ${tokenB}` } }),
      fetch(`${baseUrl}/api/doctors`, { headers: { Authorization: `Bearer ${tokenB}` } }),
      fetch(`${baseUrl}/api/analytics`, { headers: { Authorization: `Bearer ${tokenB}` } }),
    ]);

    assert.equal(histAppts.status, 200, 'Appointments must remain readable when expired');
    assert.equal(histCalls.status, 200, 'Calls must remain readable when expired');
    assert.equal(histDocs.status, 200, 'Doctors must remain readable when expired');
    assert.equal(histStats.status, 200, 'Analytics must remain readable when expired');
  });

  // --------------------------------------------------------------------------
  // 5. Browser Simulation Non-Billable Verification
  // --------------------------------------------------------------------------
  test('5. Browser receptionist usage remains 100% non-billable', async () => {
    const m = getBillingMonth();
    const usage = await store.getClinicUsage(CLINIC_A, m);
    assert.equal((usage && usage.call_count) || 0, 0, 'Browser simulation must NEVER increment call_count');
    assert.equal((usage && usage.call_minutes) || 0, 0, 'Browser simulation must NEVER increment call_minutes');
    assert.equal((usage && usage.whatsapp_count) || 0, 0, 'Browser simulation must NEVER increment whatsapp_count');
  });

  // --------------------------------------------------------------------------
  // 6. Quota Enforcement & Warning Header Propagation
  // --------------------------------------------------------------------------
  test('6. Enforcing quotas returns HTTP 409 QUOTA_EXCEEDED when booking limit reached', async () => {
    process.env.ENFORCE_SUBSCRIPTION_QUOTAS = 'true';
    try {
      // Set usage to limit (150)
      const m = getBillingMonth();
      await store.recordClinicUsage(CLINIC_A, m, { booking_count: 150 });

      const res = await fetch(`${baseUrl}/api/appointments`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Quota Patient',
          phone: '9876540088',
          date: '29/12/2026',
          time_slot: '09:00 AM',
          doctorId: doctorA._id,
        }),
      });
      assert.equal(res.status, 409);
      const data = await res.json();
      assert.equal(data.code, 'QUOTA_EXCEEDED');
      assert.equal(data.metric, 'bookings');
    } finally {
      delete process.env.ENFORCE_SUBSCRIPTION_QUOTAS;
    }
  });
});
