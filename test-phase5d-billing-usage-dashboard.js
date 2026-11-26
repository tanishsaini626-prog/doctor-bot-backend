'use strict';
/**
 * test-phase5d-billing-usage-dashboard.js
 *
 * Acceptance test suite for MediBot Phase 5D:
 * 1. Centralized plan configuration (Starter ₹1,499 / Growth ₹2,499).
 * 2. Authenticated clinic subscription & usage evaluation (GET /api/billing/subscription).
 * 3. Tenant-isolated billing history & honest empty state (GET /api/billing/invoices).
 * 4. Simulated upgrade request (POST /api/billing/simulate-upgrade) with role enforcement.
 * 5. Simulation safety invariant: simulated requests never mutate actual subscription or bypass quotas.
 * 6. Client security: reject client-supplied payment flags and prevent unauthorized staff changes.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

const TEST_JWT_SECRET = 'medibot-phase5d-test-secret-at-least-32-chars-long';

describe('MediBot Phase 5D — Billing & Usage Dashboard Acceptance Suite', () => {
  let app;
  let server;
  let baseUrl;
  let store;

  const CLINIC_A = 'clinic_p5d_alpha';
  const CLINIC_B = 'clinic_p5d_beta';
  let ownerTokenA;
  let staffTokenA;
  let ownerTokenB;

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

    // Seed Clinic A
    await store.saveClinic({
      name: 'Phase 5D Clinic A',
      phone: '+919876505001',
      subscription: {
        status: 'trial',
        plan_id: 'starter_1499',
        trial_ends_at: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString(),
        current_period_start: new Date().toISOString(),
        current_period_end: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString(),
      },
    }, { clinic: CLINIC_A, create: true });

    // Seed Clinic B
    await store.saveClinic({
      name: 'Phase 5D Clinic B',
      phone: '+919876505002',
      subscription: {
        status: 'active',
        plan_id: 'starter_1499',
        trial_ends_at: null,
        current_period_start: new Date().toISOString(),
        current_period_end: new Date(Date.now() + 25 * 24 * 60 * 60 * 1000).toISOString(),
      },
    }, { clinic: CLINIC_B, create: true });

    // Create tokens
    ownerTokenA = jwt.sign({
      sub: 'owner-a-id',
      email: 'ownerA@p5d.clinic',
      role: 'clinic_owner',
      clinic: CLINIC_A,
    }, TEST_JWT_SECRET, { expiresIn: '1h' });

    staffTokenA = jwt.sign({
      sub: 'staff-a-id',
      email: 'staffA@p5d.clinic',
      role: 'clinic_staff',
      clinic: CLINIC_A,
    }, TEST_JWT_SECRET, { expiresIn: '1h' });

    ownerTokenB = jwt.sign({
      sub: 'owner-b-id',
      email: 'ownerB@p5d.clinic',
      role: 'clinic_owner',
      clinic: CLINIC_B,
    }, TEST_JWT_SECRET, { expiresIn: '1h' });
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('1. Centralized plan configuration: lists active Starter (₹1,499) and Growth (₹2,499) plans', async () => {
    const res = await fetch(`${baseUrl}/api/billing/plans`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data.plans));
    assert.ok(data.plans.length >= 2);

    const starter = data.plans.find((p) => p.plan_id === 'starter_1499');
    assert.ok(starter);
    assert.equal(starter.price_inr, 1499);
    assert.equal(starter.included_bookings, 150);
    assert.equal(starter.included_call_minutes, 350);
    assert.equal(starter.max_doctors, 2);

    const growth = data.plans.find((p) => p.plan_id === 'growth_2499');
    assert.ok(growth);
    assert.equal(growth.price_inr, 2499);
    assert.equal(growth.included_bookings, 350);
    assert.equal(growth.included_call_minutes, 750);
    assert.equal(growth.max_doctors, 5);

    assert.equal(data.currency, 'INR');
    assert.equal(data.is_test_mode, true);
  });

  test('2. Authenticated clinic subscription & usage evaluation (GET /api/billing/subscription)', async () => {
    const res = await fetch(`${baseUrl}/api/billing/subscription`, {
      headers: { Authorization: `Bearer ${ownerTokenA}` },
    });
    assert.equal(res.status, 200);
    const data = await res.json();

    assert.equal(String(data.clinicId), CLINIC_A);
    assert.equal(data.clinicName, 'Phase 5D Clinic A');
    assert.ok(data.subscription);
    assert.equal(data.evaluation.status, 'trial');
    assert.equal(data.evaluation.canBook, true);

    // Limits & usage structure
    assert.ok(data.limits);
    assert.equal(data.limits.included_bookings, 150);
    assert.equal(data.limits.included_call_minutes, 350);
    assert.equal(data.limits.max_doctors, 2);

    assert.ok(data.usage);
    assert.equal(typeof data.usage.booking_count, 'number');
    assert.equal(typeof data.usage.call_minutes, 'number');
    assert.equal(typeof data.usage.doctor_count, 'number');
    assert.equal(typeof data.usage.whatsapp_count, 'number');
  });

  test('3. Tenant isolation: Clinic A cannot access or view Clinic B billing details', async () => {
    // Unassigned clinic token is rejected with 403
    const unassignedToken = jwt.sign({
      sub: 'no-clinic-user',
      email: 'no-clinic@test.local',
      role: 'clinic_owner',
      clinic: null,
    }, TEST_JWT_SECRET, { expiresIn: '1h' });

    const resUnassigned = await fetch(`${baseUrl}/api/billing/subscription`, {
      headers: { Authorization: `Bearer ${unassignedToken}` },
    });
    assert.equal(resUnassigned.status, 403);

    // Clinic B gets Clinic B data only
    const resB = await fetch(`${baseUrl}/api/billing/subscription`, {
      headers: { Authorization: `Bearer ${ownerTokenB}` },
    });
    assert.equal(resB.status, 200);
    const dataB = await resB.json();
    assert.equal(String(dataB.clinicId), CLINIC_B);
    assert.equal(dataB.clinicName, 'Phase 5D Clinic B');
  });

  test('4. Billing invoices: returns honest empty state for new clinics without fake payments', async () => {
    const res = await fetch(`${baseUrl}/api/billing/invoices`, {
      headers: { Authorization: `Bearer ${ownerTokenA}` },
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(String(data.clinicId), CLINIC_A);
    assert.ok(Array.isArray(data.invoices));
    assert.equal(data.invoices.length, 0); // Honest empty state
  });

  test('5. Simulated upgrade request: clinic owner can simulate plan change to growth_2499', async () => {
    const res = await fetch(`${baseUrl}/api/billing/simulate-upgrade`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ownerTokenA}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ plan_id: 'growth_2499' }),
    });
    assert.equal(res.status, 200);
    const data = await res.json();

    assert.equal(data.ok, true);
    assert.equal(data.simulated, true);
    assert.equal(data.targetPlan.plan_id, 'growth_2499');
    assert.equal(data.targetPlan.price_inr, 2499);
    assert.equal(data.targetPlan.included_bookings, 350);
    assert.equal(data.targetPlan.included_call_minutes, 750);
    assert.equal(data.proposedPriceInr, 2499);
    assert.match(data.message, /simulated/i);

    // CRITICAL INVARIANT: Simulation must NOT mutate actual subscription in store!
    const subAfter = await store.getClinic(CLINIC_A);
    assert.equal(subAfter.subscription.plan_id, 'starter_1499'); // unchanged
  });

  test('6. Role enforcement: clinic_staff cannot initiate simulated upgrade (HTTP 403)', async () => {
    const res = await fetch(`${baseUrl}/api/billing/simulate-upgrade`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${staffTokenA}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ plan_id: 'growth_2499' }),
    });
    assert.equal(res.status, 403);
    const data = await res.json();
    assert.equal(data.code, 'BILLING_UNAUTHORIZED_ROLE');
  });

  test('7. Validation & Safety: invalid plan ID returns 404, missing plan_id returns 400', async () => {
    // Missing plan_id
    const resMissing = await fetch(`${baseUrl}/api/billing/simulate-upgrade`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ownerTokenA}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    assert.equal(resMissing.status, 400);

    // Non-existent plan_id
    const resInvalid = await fetch(`${baseUrl}/api/billing/simulate-upgrade`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ownerTokenA}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ plan_id: 'enterprise_99999' }),
    });
    assert.equal(resInvalid.status, 404);
  });

  test('8. Client payment flag rejection: /api/billing/checkout blocks self-activation flags', async () => {
    const res = await fetch(`${baseUrl}/api/billing/checkout`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ownerTokenA}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        plan_id: 'growth_2499',
        payment_success: true,
      }),
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.equal(data.code, 'FORBIDDEN_CLIENT_PAYMENT_FLAG');
  });
});
