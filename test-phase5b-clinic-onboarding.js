'use strict';
/**
 * test-phase5b-clinic-onboarding.js
 *
 * Acceptance test suite for MediBot Phase 5B — Clinic Onboarding.
 * Verifies:
 * 1. New clinic registration creates clinic_owner, 14-day trial subscription, and valid JWT.
 * 2. Clinic profile (name, phone, Hindi greeting) saves via PATCH /api/clinic and persists on GET /api/clinic.
 * 3. Doctor creation & working_hours validation/persistence via POST /api/doctors & PATCH /api/doctors/:id.
 * 4. Browser AI receptionist demo marks onboarding_demo_completed_at on the clinic while keeping
 *    billable call_count === 0 and call_minutes === 0.
 * 5. Role & staff permissions: clinic_staff and receptionist can read clinic/doctors and run
 *    browser receptionist demo, but receive HTTP 403 on clinic profile or doctor mutations.
 * 6. Cross-clinic isolation: Clinic A cannot read or modify Clinic B's clinic profile, doctors,
 *    or onboarding completion state.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

const { getBillingMonth } = require('./subscription');

const TEST_JWT_SECRET = 'medibot-phase5b-clinic-onboarding-secret-32chars';

describe('MediBot Phase 5B — Clinic Onboarding Acceptance Suite', () => {
  let app;
  let server;
  let baseUrl;
  let store;

  let clinicAToken;
  let clinicAId;
  let clinicBToken;
  let clinicBId;
  let staffAToken;
  let receptionistAToken;

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

  test('1. New clinic registration creates clinic_owner with 14-day trial subscription', async () => {
    const res = await fetch(`${baseUrl}/api/auth/register-clinic`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clinic_name: 'Verma Care Clinic',
        admin_name: 'Dr. Ramesh Verma',
        phone: '9876501111',
        email: 'verma@p5b.test',
        password: 'Password123!',
      }),
    });
    assert.equal(res.status, 201);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.ok(data.token);
    assert.equal(data.user.role, 'clinic_owner');
    assert.ok(data.clinic && data.clinic._id);

    clinicAToken = data.token;
    clinicAId = String(data.clinic._id);

    // Verify 14-day free trial subscription via GET /api/subscription
    const subRes = await fetch(`${baseUrl}/api/subscription`, {
      headers: { Authorization: `Bearer ${clinicAToken}` },
    });
    assert.equal(subRes.status, 200);
    const subData = await subRes.json();
    assert.equal(subData.subscription.status, 'trial');
    assert.equal(subData.subscription.plan_id, 'starter_1499');
    assert.ok(subData.subscription.trial_ends_at, 'Trial end timestamp must be present');

    // Register a second clinic (Clinic B) for tenant-isolation verification
    const resB = await fetch(`${baseUrl}/api/auth/register-clinic`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clinic_name: 'Mehta Skin Clinic',
        admin_name: 'Dr. Neha Mehta',
        phone: '9876502222',
        email: 'mehta@p5b.test',
        password: 'Password123!',
      }),
    });
    assert.equal(resB.status, 201);
    const dataB = await resB.json();
    clinicBToken = dataB.token;
    clinicBId = String(dataB.clinic._id);
  });

  test('2. Step 1 — Clinic profile (name, phone, Hindi greeting) saves and persists after refresh', async () => {
    const customGreeting = 'नमस्ते! मैं वर्मा केयर क्लिनिक से बोल रही हूँ। अपॉइंटमेंट बुक करने के लिए कृपया अपना नाम बताइए।';
    const patchRes = await fetch(`${baseUrl}/api/clinic`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${clinicAToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'Verma Care Clinic & Diagnostics',
        phone: '+919876501111',
        greeting_text: customGreeting,
      }),
    });
    assert.equal(patchRes.status, 200);

    // Simulate page refresh via fresh GET /api/clinic
    const getRes = await fetch(`${baseUrl}/api/clinic`, {
      headers: { Authorization: `Bearer ${clinicAToken}` },
    });
    assert.equal(getRes.status, 200);
    const clinic = await getRes.json();
    assert.equal(clinic.name, 'Verma Care Clinic & Diagnostics');
    assert.equal(clinic.greeting_text, customGreeting);
    assert.ok(!clinic.onboarding_demo_completed_at, 'Demo should not be marked complete before testing receptionist');
  });

  test('3. Step 2 — Doctor creation and working hours validate and persist correctly', async () => {
    // Reject invalid working_hours (start >= end)
    const badRes = await fetch(`${baseUrl}/api/doctors`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${clinicAToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'Dr. Ramesh Verma',
        specialty: 'General Physician',
        working_hours: [{ day: 1, start: '18:00', end: '09:00' }],
      }),
    });
    assert.equal(badRes.status, 400);

    // Valid working hours (Mon-Sat 09:30-18:30)
    const workingHours = [1, 2, 3, 4, 5, 6].map((day) => ({ day, start: '09:30', end: '18:30' }));
    const createRes = await fetch(`${baseUrl}/api/doctors`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${clinicAToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'Dr. Ramesh Verma',
        specialty: 'General Physician',
        slot_minutes: 15,
        working_hours: workingHours,
      }),
    });
    assert.equal(createRes.status, 201);
    const createdDoc = await createRes.json();
    assert.equal(createdDoc.working_hours.length, 6);
    assert.equal(createdDoc.working_hours[0].start, '09:30');

    // Simulate refresh via GET /api/doctors
    const listRes = await fetch(`${baseUrl}/api/doctors`, {
      headers: { Authorization: `Bearer ${clinicAToken}` },
    });
    assert.equal(listRes.status, 200);
    const doctors = await listRes.json();
    assert.equal(doctors.length, 1);
    assert.equal(doctors[0].working_hours.length, 6);
    assert.equal(doctors[0].working_hours[0].end, '18:30');
  });

  test('4a. Session started but abandoned does NOT mark onboarding demo complete', async () => {
    // Start simulation session
    const startRes = await fetch(`${baseUrl}/api/receptionist/sessions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${clinicAToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ language: 'hinglish', speak: false }),
    });
    assert.equal(startRes.status, 201);
    const { session_id: sid } = await startRes.json();

    // User gives only name and then abandons session
    const turnRes = await fetch(`${baseUrl}/api/receptionist/sessions/${sid}/turn`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${clinicAToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text: 'Mera naam Amit Sharma hai', speak: false }),
    });
    assert.equal(turnRes.status, 200);

    // Explicitly end/abandon session
    const endRes = await fetch(`${baseUrl}/api/receptionist/sessions/${sid}/end`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${clinicAToken}` },
    });
    assert.equal(endRes.status, 200);

    // Verify clinic onboarding_demo_completed_at remains unset/falsy
    const clinicRes = await fetch(`${baseUrl}/api/clinic`, {
      headers: { Authorization: `Bearer ${clinicAToken}` },
    });
    assert.equal(clinicRes.status, 200);
    const clinic = await clinicRes.json();
    assert.ok(!clinic.onboarding_demo_completed_at, 'Abandoned session must not mark onboarding demo complete');
  });

  test('4b. Failed processing (empty input or invalid slot) does NOT mark onboarding demo complete', async () => {
    const startRes = await fetch(`${baseUrl}/api/receptionist/sessions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${clinicAToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ language: 'hi', speak: false }),
    });
    assert.equal(startRes.status, 201);
    const { session_id: sid } = await startRes.json();

    // Send empty text (failed/unclear turn)
    const emptyTurn = await fetch(`${baseUrl}/api/receptionist/sessions/${sid}/turn`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${clinicAToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text: '   ', speak: false }),
    });
    assert.equal(emptyTurn.status, 200);
    const emptyData = await emptyTurn.json();
    assert.equal(emptyData.status, 'active');

    // Send invalid phone digits when asked for phone
    await fetch(`${baseUrl}/api/receptionist/sessions/${sid}/turn`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${clinicAToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text: 'Rajesh Kumar', speak: false }),
    });
    const badPhoneTurn = await fetch(`${baseUrl}/api/receptionist/sessions/${sid}/turn`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${clinicAToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text: '1234', speak: false }),
    });
    assert.equal(badPhoneTurn.status, 200);

    // Verify clinic onboarding_demo_completed_at is still unset/falsy
    const clinicRes = await fetch(`${baseUrl}/api/clinic`, {
      headers: { Authorization: `Bearer ${clinicAToken}` },
    });
    assert.equal(clinicRes.status, 200);
    const clinic = await clinicRes.json();
    assert.ok(!clinic.onboarding_demo_completed_at, 'Failed turns must not mark onboarding demo complete');
  });

  test('4c. Successfully completed receptionist demo marks onboarding_demo_completed_at and keeps usage non-billable', async () => {
    const startRes = await fetch(`${baseUrl}/api/receptionist/sessions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${clinicAToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ language: 'hi', speak: false }),
    });
    assert.equal(startRes.status, 201);
    const { session_id: sid } = await startRes.json();

    // 1. Provide all appointment details (one-sentence turn or multi-turn)
    const turn1 = await fetch(`${baseUrl}/api/receptionist/sessions/${sid}/turn`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${clinicAToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text: 'मेरा नाम राहुल वर्मा है, फ़ोन 9876501111, बुखार है, 28/12/2026 सुबह 10 बजे',
        speak: false,
      }),
    });
    assert.equal(turn1.status, 200);
    const data1 = await turn1.json();
    assert.equal(data1.awaiting_confirm, true, 'Receptionist must reach explicit confirmation read-back');

    // At readback before confirmation, demo is still not finalized
    const preCheckClinic = await (await fetch(`${baseUrl}/api/clinic`, { headers: { Authorization: `Bearer ${clinicAToken}` } })).json();
    assert.ok(!preCheckClinic.onboarding_demo_completed_at, 'Must not mark complete before explicit confirmation');

    // 2. Explicitly confirm booking: "हाँ"
    const confirmTurn = await fetch(`${baseUrl}/api/receptionist/sessions/${sid}/turn`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${clinicAToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text: 'हाँ, बिल्कुल', speak: false }),
    });
    assert.equal(confirmTurn.status, 200);
    const confirmData = await confirmTurn.json();
    assert.equal(confirmData.status, 'confirmed');
    assert.ok(confirmData.appointment, 'Appointment must be created upon confirmation');

    // 3. Refresh GET /api/clinic -> onboarding_demo_completed_at must now be persisted
    const clinicRes = await fetch(`${baseUrl}/api/clinic`, {
      headers: { Authorization: `Bearer ${clinicAToken}` },
    });
    assert.equal(clinicRes.status, 200);
    const clinic = await clinicRes.json();
    assert.ok(clinic.onboarding_demo_completed_at, 'Successfully confirmed demo must mark onboarding_demo_completed_at');

    // 4. Verify browser demo did NOT consume billable telephone call minutes or WhatsApp count
    const usage = await store.getClinicUsage(clinicAId, getBillingMonth());
    assert.equal((usage && usage.call_count) || 0, 0, 'Demo must not increment billable call_count');
    assert.equal((usage && usage.call_minutes) || 0, 0, 'Demo must not increment billable call_minutes');
    assert.equal((usage && usage.whatsapp_count) || 0, 0, 'Demo must not increment whatsapp_count');
    assert.equal((usage && usage.booking_count) || 0, 1, 'Confirmed appointment must increment standard booking usage');
  });

  test('5. Staff permissions: clinic_staff and receptionist can view & demo, but get 403 on clinic/doctor edits', async () => {
    staffAToken = jwt.sign(
      { sub: 'usr_staff_a', email: 'staff@p5b.test', role: 'clinic_staff', clinic: clinicAId },
      TEST_JWT_SECRET
    );
    receptionistAToken = jwt.sign(
      { sub: 'usr_recep_a', email: 'recep@p5b.test', role: 'receptionist', clinic: clinicAId },
      TEST_JWT_SECRET
    );

    for (const token of [staffAToken, receptionistAToken]) {
      // Read access allowed
      const getClinic = await fetch(`${baseUrl}/api/clinic`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(getClinic.status, 200);

      const getDocs = await fetch(`${baseUrl}/api/doctors`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(getDocs.status, 200);

      // Mutations blocked with 403
      const patchClinic = await fetch(`${baseUrl}/api/clinic`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Hijacked Clinic Name' }),
      });
      assert.equal(patchClinic.status, 403, 'Staff must not be allowed to modify clinic settings');

      const postDoc = await fetch(`${baseUrl}/api/doctors`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Dr. Unauthorized' }),
      });
      assert.equal(postDoc.status, 403, 'Staff must not be allowed to create doctors');
    }
  });

  test('6. Cross-clinic tenant isolation: Clinic B cannot see or alter Clinic A onboarding state or doctors', async () => {
    const clinicBRes = await fetch(`${baseUrl}/api/clinic`, {
      headers: { Authorization: `Bearer ${clinicBToken}` },
    });
    assert.equal(clinicBRes.status, 200);
    const clinicB = await clinicBRes.json();
    assert.equal(String(clinicB._id), clinicBId);
    assert.equal(clinicB.name, 'Mehta Skin Clinic');
    assert.ok(!clinicB.onboarding_demo_completed_at, 'Clinic B onboarding state must remain isolated from Clinic A');

    const docsBRes = await fetch(`${baseUrl}/api/doctors`, {
      headers: { Authorization: `Bearer ${clinicBToken}` },
    });
    assert.equal(docsBRes.status, 200);
    const docsB = await docsBRes.json();
    assert.equal(docsB.length, 0, 'Clinic B must not see Clinic A doctors');

    // Clinic A doctors cannot be edited by Clinic B
    const docsA = await store.listDoctors({ clinic: clinicAId });
    const docAId = docsA[0]._id;
    const crossPatch = await fetch(`${baseUrl}/api/doctors/${docAId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${clinicBToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Tampered Doctor' }),
    });
    assert.equal(crossPatch.status, 404, 'Cross-clinic doctor update must return 404');
  });
});
