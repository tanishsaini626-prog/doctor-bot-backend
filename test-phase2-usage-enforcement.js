'use strict';
/**
 * test-phase2-usage-enforcement.js
 *
 * Automated test suite for MediBot Phase 2 — Usage Tracking & Subscription Enforcement.
 * Verifies:
 * 1. Timezone-aware billing month calculation (Asia/Kolkata).
 * 2. Subscription state evaluation (trial, active, past_due, canceled, expired).
 * 3. Quota calculation (shadow mode warning vs enforcement mode blocking).
 * 4. Usage tracking idempotency and non-negative clamping across stores.
 * 5. Trial timestamp persistence safety (repeated reads do not reset trial clock).
 * 6. Server-side subscription middleware (read-only preservation vs mutating protection).
 * 7. End-to-end voice and dashboard booking usage increments.
 * 8. Status callback call usage and duration tracking with idempotency and simulator bypass.
 * 9. Multi-tenant usage isolation.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const mongoose = require('mongoose');

const {
  SubscriptionPlan,
  ClinicUsage,
  Clinic,
  DEFAULT_PLANS,
} = require('./models');

const {
  getBillingMonth,
  evaluateSubscription,
  checkQuota,
  isQuotaEnforced,
  resolvePlan,
  createSubscriptionMiddleware,
} = require('./subscription');

const { createMemoryStore } = require('./store-memory');
const { createFileStore } = require('./store-file');

// ============================================================================
// 1. Timezone-aware Billing Month Calculation (Asia/Kolkata)
// ============================================================================
test('1. getBillingMonth calculates accurate YYYY-MM in Asia/Kolkata', () => {
  // Test IST boundary: UTC 2026-05-31 23:00 is 2026-06-01 04:30 IST
  const boundaryDate = new Date('2026-05-31T23:00:00.000Z');
  const month = getBillingMonth(boundaryDate);
  assert.equal(month, '2026-06', 'Boundary UTC time must resolve to June in Asia/Kolkata');

  // Test current date calculation
  const currentMonth = getBillingMonth();
  assert.match(currentMonth, /^\d{4}-\d{2}$/, 'Should format as YYYY-MM');
});

// ============================================================================
// 2. Subscription State Evaluation
// ============================================================================
test('2. evaluateSubscription handles all subscription states correctly', () => {
  const now = new Date();
  const future = new Date(now.getTime() + 7 * 24 * 3600 * 1000);
  const past = new Date(now.getTime() - 24 * 3600 * 1000);

  // 2a. Active trial
  const trialActive = evaluateSubscription({
    status: 'trial',
    trial_ends_at: future,
  });
  assert.equal(trialActive.valid, true);
  assert.equal(trialActive.canBook, true);
  assert.equal(trialActive.canMutate, true);
  assert.equal(trialActive.status, 'trial');

  // 2b. Expired trial
  const trialExpired = evaluateSubscription({
    status: 'trial',
    trial_ends_at: past,
  });
  assert.equal(trialExpired.valid, false);
  assert.equal(trialExpired.canBook, false);
  assert.equal(trialExpired.canMutate, false);
  assert.equal(trialExpired.status, 'expired');
  assert.equal(trialExpired.trial_ended, true);

  // 2c. Active paid subscription
  const paidActive = evaluateSubscription({
    status: 'active',
    current_period_end: future,
  });
  assert.equal(paidActive.valid, true);
  assert.equal(paidActive.canBook, true);
  assert.equal(paidActive.canMutate, true);
  assert.equal(paidActive.status, 'active');

  // 2d. Active paid lapsed into past_due
  const paidLapsed = evaluateSubscription({
    status: 'active',
    current_period_end: past,
  });
  assert.equal(paidLapsed.valid, false);
  assert.equal(paidLapsed.canBook, false);
  assert.equal(paidLapsed.canMutate, false);
  assert.equal(paidLapsed.status, 'past_due');
  assert.equal(paidLapsed.period_ended, true);

  // 2e. Explicit past_due
  const pastDue = evaluateSubscription({
    status: 'past_due',
  });
  assert.equal(pastDue.valid, false);
  assert.equal(pastDue.canBook, false);
  assert.equal(pastDue.canMutate, false);

  // 2f. Canceled but active until period end
  const cancelGrace = evaluateSubscription({
    status: 'canceled',
    cancel_at_period_end: true,
    current_period_end: future,
  });
  assert.equal(cancelGrace.valid, true);
  assert.equal(cancelGrace.canBook, true);
  assert.equal(cancelGrace.canMutate, true);
  assert.equal(cancelGrace.status, 'canceled');

  // 2g. Canceled immediately or past period end
  const cancelTerminated = evaluateSubscription({
    status: 'canceled',
    cancel_at_period_end: false,
    current_period_end: future,
  });
  assert.equal(cancelTerminated.valid, false);
  assert.equal(cancelTerminated.canBook, false);
  assert.equal(cancelTerminated.canMutate, false);
});

// ============================================================================
// 3. Quota Evaluation & Shadow Mode vs Enforcement Mode
// ============================================================================
test('3. checkQuota behaves differently in shadow mode vs enforcement mode', async () => {
  const store = createMemoryStore();
  const clinicId = 'clinic_quota_test';

  // Starter plan: included_bookings = 150, included_call_minutes = 350, max_doctors = 2
  // Simulate 150 existing bookings for current month
  const m = getBillingMonth();
  await store.recordClinicUsage(clinicId, m, { booking_count: 150 });

  // 3a. In shadow mode (default): would exceed, but allowed = true with warning
  delete process.env.ENFORCE_SUBSCRIPTION_QUOTAS;
  assert.equal(isQuotaEnforced(), false, 'Default mode should be shadow mode');

  const shadowResult = await checkQuota({
    store,
    clinicId,
    planId: 'starter_1499',
    metric: 'bookings',
    billingMonth: m,
    count: 1,
  });
  assert.equal(shadowResult.allowed, true, 'Shadow mode must not block operations');
  assert.ok(shadowResult.shadowWarning, 'Shadow mode must provide shadow warning');
  assert.equal(shadowResult.limit, 150);
  assert.equal(shadowResult.currentUsage, 150);

  // 3b. In enforcement mode: would exceed, allowed = false
  process.env.ENFORCE_SUBSCRIPTION_QUOTAS = 'true';
  try {
    assert.equal(isQuotaEnforced(), true, 'Quota enforcement should be active');
    const enforcedResult = await checkQuota({
      store,
      clinicId,
      planId: 'starter_1499',
      metric: 'bookings',
      billingMonth: m,
      count: 1,
    });
    assert.equal(enforcedResult.allowed, false, 'Enforcement mode must block exceeding operations');
    assert.equal(enforcedResult.limit, 150);
    assert.equal(enforcedResult.currentUsage, 150);
  } finally {
    delete process.env.ENFORCE_SUBSCRIPTION_QUOTAS;
  }
});

// ============================================================================
// 4. Non-negative Usage Clamping and Non-regression in Stores
// ============================================================================
test('4. recordClinicUsage clamps negative inputs and prevents negative drift', async () => {
  const store = createMemoryStore();
  const clinicId = 'clinic_clamp_test';
  const m = getBillingMonth();

  // Initial increment
  await store.recordClinicUsage(clinicId, m, { call_count: 5, call_minutes: 10 });
  let usage = await store.getClinicUsage(clinicId, m);
  assert.equal(usage.call_count, 5);
  assert.equal(usage.call_minutes, 10);

  // Negative increment attempt should be clamped to 0
  await store.recordClinicUsage(clinicId, m, { call_count: -10, call_minutes: -5, booking_count: -1 });
  usage = await store.getClinicUsage(clinicId, m);
  assert.equal(usage.call_count, 5, 'Negative increments must not reduce call_count');
  assert.equal(usage.call_minutes, 10, 'Negative increments must not reduce call_minutes');
  assert.equal(usage.booking_count, 0, 'Negative increments must not make booking_count negative');
});

// ============================================================================
// 5. Legacy Clinic Trial Expiry Persistence (Requirement D)
// ============================================================================
test('5. Legacy clinic trial timestamp is persisted on first read and not reset on repeated reads', async () => {
  const store = createMemoryStore();
  const clinicId = 'legacy_clinic_001';

  // Seed a clinic without subscription
  const clinic = await store.saveClinic({
    name: 'Legacy Practice',
    phone: '+919876500001',
  }, { clinic: clinicId, create: true });
  assert.ok(clinic);

  // Simulate legacy database record that had null subscription
  const rawClinic = store.clinics.get(clinicId);
  rawClinic.subscription = null;
  store.clinics.set(clinicId, rawClinic);

  // First read should assign a default trial subscription and persist it
  const read1 = await store.getClinic(clinicId);
  assert.ok(read1.subscription, 'First read must assign default subscription');
  assert.equal(read1.subscription.status, 'trial');
  const trialEnd1 = new Date(read1.subscription.trial_ends_at).getTime();
  assert.ok(trialEnd1 > Date.now(), 'Trial end should be in the future');

  // Small sleep to ensure clock advances
  await new Promise(r => setTimeout(r, 10));

  // Second read must return EXACT SAME trial_ends_at timestamp, NOT a new Date() + 14 days
  const read2 = await store.getClinic(clinicId);
  const trialEnd2 = new Date(read2.subscription.trial_ends_at).getTime();
  assert.equal(trialEnd2, trialEnd1, 'Subsequent reads must not advance or reset trial_ends_at timestamp');

  // Third read through memory snapshot/hydrate must also preserve the exact timestamp
  const snap = store.__snapshot();
  const storeRestored = createMemoryStore();
  storeRestored.__hydrate(snap);
  const read3 = await storeRestored.getClinic(clinicId);
  const trialEnd3 = new Date(read3.subscription.trial_ends_at).getTime();
  assert.equal(trialEnd3, trialEnd1, 'Restored store must preserve exact persisted trial timestamp');
});

// ============================================================================
// 6. Subscription Middleware & Read-only Preservation
// ============================================================================
test('6. requireActiveSubscription preserves read-only access and blocks mutations when inactive', async () => {
  const store = createMemoryStore();
  const activeClinic = await store.saveClinic({ name: 'Active Clinic', phone: '+919876500010' }, { clinic: 'active_c', create: true });
  const expiredClinic = await store.saveClinic({ name: 'Expired Clinic', phone: '+919876500011' }, { clinic: 'expired_c', create: true });

  // Make expired clinic explicitly expired
  await store.saveClinic({
    subscription: {
      status: 'expired',
      plan_id: 'starter_1499',
      trial_ends_at: new Date(Date.now() - 10000),
    },
  }, { clinic: 'expired_c' });

  const middleware = createSubscriptionMiddleware(store);

  // Test 6a: Active clinic can mutate
  let calledNext = false;
  const mockReqActive = {
    user: { clinic: 'active_c', role: 'clinic_owner' },
  };
  const mockRes = {
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };

  await middleware(mockReqActive, mockRes, () => { calledNext = true; });
  assert.equal(calledNext, true, 'Active clinic must pass middleware');
  assert.equal(mockReqActive.clinicSubscription.canMutate, true);

  // Test 6b: Expired clinic is blocked from mutations
  calledNext = false;
  const mockReqExpired = {
    user: { clinic: 'expired_c', role: 'clinic_owner' },
  };
  let blockedStatus = null;
  let blockedBody = null;
  const mockResBlocked = {
    status(code) { blockedStatus = code; return this; },
    json(payload) { blockedBody = payload; return this; },
  };

  await middleware(mockReqExpired, mockResBlocked, () => { calledNext = true; });
  assert.equal(calledNext, false, 'Expired clinic must be blocked from mutations');
  assert.equal(blockedStatus, 402, 'Expired clinic should receive 402 Payment Required');
  assert.equal(blockedBody.code, 'SUBSCRIPTION_INACTIVE');

  // Test 6c: Platform admin always bypasses subscription restrictions
  calledNext = false;
  const mockReqPlatformAdmin = {
    user: { clinic: 'expired_c', role: 'platform_admin' },
  };
  await middleware(mockReqPlatformAdmin, mockRes, () => { calledNext = true; });
  assert.equal(calledNext, true, 'Platform admin must bypass subscription gating');
});

// ============================================================================
// 7. Multi-tenant Usage Isolation
// ============================================================================
test('7. Multi-tenant usage isolation between independent clinics', async () => {
  const store = createMemoryStore();
  const m = getBillingMonth();

  const clinicA = 'clinic_tenant_alpha';
  const clinicB = 'clinic_tenant_beta';

  await store.recordClinicUsage(clinicA, m, { booking_count: 10, call_count: 25, call_minutes: 50 });
  await store.recordClinicUsage(clinicB, m, { booking_count: 3, call_count: 5, call_minutes: 12 });

  const usageA = await store.getClinicUsage(clinicA, m);
  const usageB = await store.getClinicUsage(clinicB, m);

  assert.equal(usageA.booking_count, 10);
  assert.equal(usageA.call_count, 25);
  assert.equal(usageA.call_minutes, 50);

  assert.equal(usageB.booking_count, 3);
  assert.equal(usageB.call_count, 5);
  assert.equal(usageB.call_minutes, 12);

  // Verifying isolation: updating clinic A does not alter clinic B
  await store.recordClinicUsage(clinicA, m, { booking_count: 5 });
  const updatedA = await store.getClinicUsage(clinicA, m);
  const untouchedB = await store.getClinicUsage(clinicB, m);

  assert.equal(updatedA.booking_count, 15);
  assert.equal(untouchedB.booking_count, 3, 'Clinic B usage must remain unaffected');
});

// ============================================================================
// 8. File Store Persistence for Usage Tracking
// ============================================================================
test('8. File store persists and reloads subscription usage accurately', async () => {
  const tmpFile = path.join(os.tmpdir(), `medibot-file-usage-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  const m = getBillingMonth();
  const clinicId = 'clinic_file_test';

  try {
    const fileStore1 = createFileStore(tmpFile);

    await fileStore1.recordClinicUsage(clinicId, m, {
      booking_count: 8,
      call_count: 14,
      call_minutes: 42,
      whatsapp_count: 7,
    });
    fileStore1.flush();

    const usage1 = await fileStore1.getClinicUsage(clinicId, m);
    assert.equal(usage1.booking_count, 8);
    assert.equal(usage1.call_minutes, 42);

    // Close and reload from disk via a new file store instance
    const fileStore2 = createFileStore(tmpFile);

    const usage2 = await fileStore2.getClinicUsage(clinicId, m);
    assert.ok(usage2, 'Reloaded file store must have usage doc');
    assert.equal(usage2.booking_count, 8);
    assert.equal(usage2.call_count, 14);
    assert.equal(usage2.call_minutes, 42);
    assert.equal(usage2.whatsapp_count, 7);
  } finally {
    try {
      if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    } catch (_) {}
  }
});

// ============================================================================
// 9. End-to-End HTTP Integration: Call Usage Tracking & Webhook Idempotency
// ============================================================================
test('9. HTTP Status callback tracks completed calls & duration with idempotency and simulator bypass', async () => {
  process.env.STORE = 'memory';
  process.env.PORT = '0';
  process.env.TWILIO_VALIDATE_SIGNATURE = 'false';
  process.env.JWT_SECRET = 'test-secret-at-least-32-chars-long-for-usage-e2e';

  const app = require('./server');
  if (app.locals && app.locals.storeReadyPromise) {
    await app.locals.storeReadyPromise;
  }
  const store = app.locals.store;

  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const clinicId = 'clinic_call_e2e';
    await store.saveClinic({ name: 'Call Tracking Practice', phone: '+919876599001' }, { clinic: clinicId, create: true });

    // Seed verified session
    const callSid = 'CA_TEST_CALL_001';
    await store.saveSession({
      call_sid: callSid,
      clinic: clinicId,
      phone: '+919999988888',
      to: '+919876599001',
      verified: true,
      status: 'Incomplete',
      source: 'voice-gateway',
      call_usage_recorded: false,
      createdAt: new Date(),
    });

    const m = getBillingMonth();

    // 9a: Twilio status callback for completed call (125 seconds = 3 minutes)
    const res1 = await fetch(`${baseUrl}/webhook/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        CallSid: callSid,
        CallStatus: 'completed',
        CallDuration: '125',
      }),
    });
    assert.equal(res1.status, 200);

    let usage = await store.getClinicUsage(clinicId, m);
    assert.ok(usage);
    assert.equal(usage.call_count, 1);
    assert.equal(usage.call_minutes, 3, '125 seconds must ceil to 3 minutes');

    // 9b: Idempotent duplicate status callback for the same CallSid
    const res2 = await fetch(`${baseUrl}/webhook/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        CallSid: callSid,
        CallStatus: 'completed',
        CallDuration: '125',
      }),
    });
    assert.equal(res2.status, 200);

    usage = await store.getClinicUsage(clinicId, m);
    assert.equal(usage.call_count, 1, 'Duplicate callback must not increment call_count');
    assert.equal(usage.call_minutes, 3, 'Duplicate callback must not increment call_minutes');

    // 9c: Browser simulator call must NOT be counted towards billable usage
    const simCallSid = 'CA_SIM_CALL_002';
    await store.saveSession({
      call_sid: simCallSid,
      clinic: clinicId,
      phone: '+919999988888',
      to: '+919876599001',
      verified: true,
      status: 'Incomplete',
      source: 'browser-simulator',
      call_usage_recorded: false,
      createdAt: new Date(),
    });

    const resSim = await fetch(`${baseUrl}/webhook/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        CallSid: simCallSid,
        CallStatus: 'completed',
        CallDuration: '60',
      }),
    });
    assert.equal(resSim.status, 200);

    usage = await store.getClinicUsage(clinicId, m);
    assert.equal(usage.call_count, 1, 'Simulator call must not increment billable call_count');
    assert.equal(usage.call_minutes, 3, 'Simulator call must not increment billable call_minutes');
  } finally {
    server.close();
  }
});

// ============================================================================
// 10. End-to-End HTTP Integration: Subscription Gating & Quota Limits
// ============================================================================
test('10. HTTP Dashboard mutations enforce subscription status, quota limits, and track usage', async () => {
  const jwt = require('jsonwebtoken');
  const app = require('./server');
  if (app.locals && app.locals.storeReadyPromise) {
    await app.locals.storeReadyPromise;
  }
  const store = app.locals.store;

  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const activeClinicId = 'clinic_e2e_active';
    const expiredClinicId = 'clinic_e2e_expired';
    const m = getBillingMonth();

    // Setup active clinic
    await store.saveClinic({
      name: 'Active Care Clinic',
      phone: '+919876511001',
      subscription: {
        status: 'active',
        plan_id: 'starter_1499',
        current_period_end: new Date(Date.now() + 30 * 24 * 3600 * 1000),
      },
    }, { clinic: activeClinicId, create: true });

    // Setup expired clinic
    await store.saveClinic({
      name: 'Expired Care Clinic',
      phone: '+919876511002',
      subscription: {
        status: 'expired',
        plan_id: 'starter_1499',
        trial_ends_at: new Date(Date.now() - 3600 * 1000),
      },
    }, { clinic: expiredClinicId, create: true });

    const tokenActive = jwt.sign(
      { sub: 'usr_act', email: 'owner@active.com', role: 'clinic_owner', clinic: activeClinicId },
      process.env.JWT_SECRET
    );
    const tokenExpired = jwt.sign(
      { sub: 'usr_exp', email: 'owner@expired.com', role: 'clinic_owner', clinic: expiredClinicId },
      process.env.JWT_SECRET
    );

    // 10a: Active clinic can create appointment; usage is incremented
    const resBook = await fetch(`${baseUrl}/api/appointments`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokenActive}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'Anita Sharma',
        phone: '+919988771122',
        date: '28/12/2026',
        time_slot: 'Morning 10:00',
        reason: 'General Checkup',
      }),
    });
    assert.equal(resBook.status, 201);
    const bookData = await resBook.json();
    assert.equal(bookData.name, 'Anita Sharma');

    const activeUsage = await store.getClinicUsage(activeClinicId, m);
    assert.equal(activeUsage.booking_count, 1, 'Manual booking must increment booking_count');

    // 10b: Expired clinic can read appointments, patients, calls, analytics
    const resGetAppts = await fetch(`${baseUrl}/api/appointments`, {
      headers: { Authorization: `Bearer ${tokenExpired}` },
    });
    assert.equal(resGetAppts.status, 200, 'Expired clinic must preserve read-only access to appointments');

    const resGetCalls = await fetch(`${baseUrl}/api/calls`, {
      headers: { Authorization: `Bearer ${tokenExpired}` },
    });
    assert.equal(resGetCalls.status, 200, 'Expired clinic must preserve read-only access to calls');

    const resGetPatients = await fetch(`${baseUrl}/api/patients`, {
      headers: { Authorization: `Bearer ${tokenExpired}` },
    });
    assert.equal(resGetPatients.status, 200, 'Expired clinic must preserve read-only access to patients');

    const resGetAnalytics = await fetch(`${baseUrl}/api/analytics`, {
      headers: { Authorization: `Bearer ${tokenExpired}` },
    });
    assert.equal(resGetAnalytics.status, 200, 'Expired clinic must preserve read-only access to analytics');

    // 10c: Expired clinic is blocked from creating appointment (402 Payment Required)
    const resBlockedBook = await fetch(`${baseUrl}/api/appointments`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokenExpired}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'Block Patient',
        phone: '+919988771133',
        date: '28/12/2026',
        time_slot: 'Morning 10:00',
      }),
    });
    assert.equal(resBlockedBook.status, 402, 'Expired clinic must be blocked with 402 Payment Required');
    const blockedBody = await resBlockedBook.json();
    assert.equal(blockedBody.code, 'SUBSCRIPTION_INACTIVE');

    // 10d: Expired clinic is blocked from mutating clinic settings
    const resBlockedClinic = await fetch(`${baseUrl}/api/clinic`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${tokenExpired}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ greeting_text: 'New greeting' }),
    });
    assert.equal(resBlockedClinic.status, 402);

    // 10e: Expired clinic is blocked from adding doctors
    const resBlockedDoc = await fetch(`${baseUrl}/api/doctors`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokenExpired}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'Dr. New Doc' }),
    });
    assert.equal(resBlockedDoc.status, 402);

    // 10f: GET /api/subscription and GET /api/usage endpoints
    const resSub = await fetch(`${baseUrl}/api/subscription`, {
      headers: { Authorization: `Bearer ${tokenActive}` },
    });
    assert.equal(resSub.status, 200);
    const subJson = await resSub.json();
    assert.equal(subJson.clinicId, activeClinicId);
    assert.equal(subJson.subscription.status, 'active');
    assert.equal(subJson.evaluation.valid, true);
    assert.equal(subJson.limits.included_bookings, 150);
    assert.equal(subJson.usage.booking_count, 1);

    const resUsage = await fetch(`${baseUrl}/api/usage`, {
      headers: { Authorization: `Bearer ${tokenActive}` },
    });
    assert.equal(resUsage.status, 200);
    const usageJson = await resUsage.json();
    assert.equal(usageJson.billingMonth, m);
    assert.equal(usageJson.usage.booking_count, 1);

    // 10g: Doctor quota check on active clinic (Starter plan allows max 2 doctors)
    await store.createDoctor({ name: 'Dr. First', active: true }, { clinic: activeClinicId });
    await store.createDoctor({ name: 'Dr. Second', active: true }, { clinic: activeClinicId });

    // In shadow mode (default), adding 3rd doctor succeeds with warning header
    delete process.env.ENFORCE_SUBSCRIPTION_QUOTAS;
    const resDocShadow = await fetch(`${baseUrl}/api/doctors`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokenActive}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'Dr. Third Shadow' }),
    });
    assert.equal(resDocShadow.status, 201);
    assert.ok(resDocShadow.headers.get('x-quota-warning'), 'Shadow mode must set X-Quota-Warning header');

    // In enforcement mode, adding beyond limit returns 409 QUOTA_EXCEEDED
    process.env.ENFORCE_SUBSCRIPTION_QUOTAS = 'true';
    try {
      const resDocEnforce = await fetch(`${baseUrl}/api/doctors`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tokenActive}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: 'Dr. Fourth Blocked' }),
      });
      assert.equal(resDocEnforce.status, 409);
      const docErrJson = await resDocEnforce.json();
      assert.equal(docErrJson.code, 'QUOTA_EXCEEDED');
      assert.equal(docErrJson.metric, 'max_doctors');
    } finally {
      delete process.env.ENFORCE_SUBSCRIPTION_QUOTAS;
    }
  } finally {
    server.close();
  }
});
