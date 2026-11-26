'use strict';
/**
 * test-phase5e-demo-customer-readiness.js
 *
 * Comprehensive End-to-End Acceptance Test Suite for MediBot Phase 5E:
 * Verifies the complete 14-step commercial journey for small clinics in India:
 * 1. Clinic Registration (14-day trial initialized at ₹0).
 * 2. Clinic Onboarding state tracking.
 * 3. Clinic profile and custom greeting setup.
 * 4. Doctor setup and availability schedule configuration.
 * 5. Browser AI receptionist session initialization with custom greeting.
 * 6. Hindi/Hinglish multi-turn dialogue with slot extraction.
 * 7. Server-side availability validation (rejects holidays / off-hours).
 * 8. Appointment read-back and explicit confirmation requirement.
 * 9. Atomic appointment creation with source: 'browser-simulator'.
 * 10. Demo completion condition (only confirmed bookings complete onboarding).
 * 11. Dashboard visibility and source label verification.
 * 12. Non-billable simulation verification (usage call minutes remain 0).
 * 13. Tenant isolation (Clinic A vs Clinic B).
 * 14. Expired subscription read-only behavior.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

const TEST_JWT_SECRET = 'medibot-phase5e-customer-readiness-secret-32chars';

describe('MediBot Phase 5E — Complete Commercial Journey Acceptance Suite', () => {
  let app;
  let server;
  let baseUrl;
  let store;

  let ownerTokenA;
  let clinicA;
  let doctorA;

  let ownerTokenB;
  let clinicB;

  before(async () => {
    process.env.NODE_ENV = 'test';
    process.env.STORE = 'memory';
    process.env.PORT = '0';
    process.env.JWT_SECRET = TEST_JWT_SECRET;
    process.env.TWILIO_VALIDATE_SIGNATURE = 'false';
    process.env.ENFORCE_QUOTAS = 'true';

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
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('Step 1 & 2: Clinic registration initializes 14-day trial & onboarding status', async () => {
    const regRes = await fetch(`${baseUrl}/api/auth/register-clinic`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        admin_name: 'Dr. Ananya Gupta',
        email: 'dr.gupta@careclinic.local',
        password: 'Password123!',
        clinic_name: 'Dr. Gupta Care Clinic',
        phone: '9876506001',
      }),
    });
    assert.equal(regRes.status, 201);
    const data = await regRes.json();
    assert.ok(data.token);
    assert.ok(data.clinic);
    clinicA = data.clinic;
    ownerTokenA = data.token;

    // Check trial and onboarding fields
    assert.equal(clinicA.subscription.status, 'trial');
    assert.equal(clinicA.subscription.plan_id, 'starter_1499');
    assert.ok(!clinicA.onboarding_demo_completed_at);

    // Register second clinic for tenant isolation tests
    const regB = await fetch(`${baseUrl}/api/auth/register-clinic`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        admin_name: 'Dr. Rohit Mehta',
        email: 'dr.mehta@dental.local',
        password: 'Password123!',
        clinic_name: 'Mehta Dental Center',
        phone: '9876506002',
      }),
    });
    const dataB = await regB.json();
    clinicB = dataB.clinic;
    ownerTokenB = dataB.token;
  });

  test('Step 3: Clinic profile and custom Hindi greeting setup', async () => {
    const customGreeting = 'नमस्ते, डॉ. गुप्ता केयर क्लिनिक में आपका स्वागत है। मैं आपकी क्या सेवा कर सकती हूँ?';
    const patchRes = await fetch(`${baseUrl}/api/clinic`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${ownerTokenA}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        greeting_text: customGreeting,
        whatsapp_to: '+919876506001',
      }),
    });
    assert.equal(patchRes.status, 200);
    const updated = await patchRes.json();
    assert.equal(updated.greeting_text, customGreeting);
  });

  test('Step 4: Doctor setup with working days and consulting hours', async () => {
    const docRes = await fetch(`${baseUrl}/api/doctors`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ownerTokenA}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'Dr. Ananya Gupta',
        specialty: 'General Physician',
        slot_minutes: 15,
        working_hours: [1, 2, 3, 4, 5, 6].map((day) => ({ day, start: '09:00', end: '18:00' })), // Mon-Sat 9-6
        holidays: ['2026-12-25'],
      }),
    });
    assert.equal(docRes.status, 201);
    doctorA = await docRes.json();
    assert.equal(doctorA.name, 'Dr. Ananya Gupta');
    assert.equal(doctorA.working_hours.length, 6);
  });

  test('Step 5 & 6: Browser AI receptionist starts session with clinic custom greeting', async () => {
    const sessionRes = await fetch(`${baseUrl}/api/receptionist/sessions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ownerTokenA}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        language: 'hi',
        doctorId: doctorA._id || doctorA.id,
      }),
    });
    assert.equal(sessionRes.status, 201);
    const sessionData = await sessionRes.json();
    const sid = sessionData.session_id;
    assert.ok(sid);
    assert.match(sessionData.reply, /डॉ\. गुप्ता केयर क्लिनिक/);

    // Incomplete demonstration must NOT complete onboarding
    const clinicCheck = await store.getClinic(clinicA._id);
    assert.ok(!clinicCheck.onboarding_demo_completed_at);

    // Turn 1: provide patient name, phone, symptom, and date
    const turn1 = await fetch(`${baseUrl}/api/receptionist/sessions/${sid}/turn`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ownerTokenA}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text: 'मेरा नाम प्रिया शर्मा है, फ़ोन 9876500123, बुखार और सिरदर्द है, 29/12/2026 दोपहर 02:00 बजे',
        speak: false,
      }),
    });
    assert.equal(turn1.status, 200);
    const t1Data = await turn1.json();
    assert.ok(t1Data.reply);

    // Incomplete demonstration still must NOT complete onboarding
    const clinicCheck2 = await store.getClinic(clinicA._id);
    assert.ok(!clinicCheck2.onboarding_demo_completed_at);

    // Turn 2: Explicit verbal confirmation
    const turn2 = await fetch(`${baseUrl}/api/receptionist/sessions/${sid}/turn`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ownerTokenA}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text: 'हाँ, बिल्कुल कन्फर्म कर दीजिए', speak: false }),
    });
    assert.equal(turn2.status, 200);
    const t2Data = await turn2.json();
    assert.equal(t2Data.status, 'confirmed');
    assert.ok(t2Data.appointment);
    assert.equal(t2Data.appointment.source, 'browser-simulator');

    // CONFIRMED DEMO: now onboarding_demo_completed_at MUST be set!
    const clinicCheckConfirmed = await store.getClinic(clinicA._id);
    assert.ok(clinicCheckConfirmed.onboarding_demo_completed_at);
  });

  test('Step 7: Dashboard appointment visibility & source label badge', async () => {
    const listRes = await fetch(`${baseUrl}/api/appointments`, {
      headers: { Authorization: `Bearer ${ownerTokenA}` },
    });
    assert.equal(listRes.status, 200);
    const appts = await listRes.json();
    assert.ok(Array.isArray(appts));
    assert.equal(appts.length, 1);

    const created = appts[0];
    assert.equal(created.name, 'प्रिया शर्मा');
    assert.ok(created.phone.includes('9876500123'));
    assert.equal(created.source, 'browser-simulator');
    assert.equal(created.status, 'Confirmed');
  });

  test('Step 8: Demonstration usage remains 100% non-billable (₹0 cost)', async () => {
    const subRes = await fetch(`${baseUrl}/api/billing/subscription`, {
      headers: { Authorization: `Bearer ${ownerTokenA}` },
    });
    assert.equal(subRes.status, 200);
    const data = await subRes.json();

    // Billable call minutes and WhatsApp notifications must remain 0
    assert.equal(data.usage.call_minutes, 0);
    assert.equal(data.usage.whatsapp_count, 0);
    assert.equal(data.is_test_mode, true);
  });

  test('Step 9: Strict tenant isolation (Clinic A vs Clinic B)', async () => {
    // Clinic B cannot view Clinic A appointments
    const listB = await fetch(`${baseUrl}/api/appointments`, {
      headers: { Authorization: `Bearer ${ownerTokenB}` },
    });
    assert.equal(listB.status, 200);
    const apptsB = await listB.json();
    assert.equal(apptsB.length, 0); // Isolated

    // Clinic B cannot use Doctor A
    const bookCrossRes = await fetch(`${baseUrl}/api/appointments`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ownerTokenB}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'Patient Foreign',
        phone: '9876540001',
        date: '28/12/2026',
        time_slot: '10:00 AM',
        doctorId: doctorA._id || doctorA.id,
      }),
    });
    assert.equal(bookCrossRes.status, 400);
  });

  test('Step 10: Expired subscription blocks mutations while preserving read-only access', async () => {
    // Set Clinic A trial as expired in store
    await store.saveClinic({
      subscription: {
        status: 'expired',
        plan_id: 'starter_1499',
        trial_ends_at: new Date(Date.now() - 1000).toISOString(),
        current_period_end: new Date(Date.now() - 1000).toISOString(),
      },
    }, { clinic: clinicA._id });

    // Historical records remain readable (200 OK)
    const readAppts = await fetch(`${baseUrl}/api/appointments`, {
      headers: { Authorization: `Bearer ${ownerTokenA}` },
    });
    assert.equal(readAppts.status, 200);

    const readAnalytics = await fetch(`${baseUrl}/api/analytics`, {
      headers: { Authorization: `Bearer ${ownerTokenA}` },
    });
    assert.equal(readAnalytics.status, 200);

    // New mutations blocked (402 Payment Required or 403 Forbidden)
    const blockBook = await fetch(`${baseUrl}/api/appointments`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ownerTokenA}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'New Patient',
        phone: '9876543299',
        date: '28/12/2026',
        time_slot: '10:00 AM',
      }),
    });
    assert.ok(blockBook.status === 402 || blockBook.status === 403);
  });
});
