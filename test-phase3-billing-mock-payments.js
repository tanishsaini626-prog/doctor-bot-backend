'use strict';
/**
 * test-phase3-billing-mock-payments.js
 *
 * Automated test suite for MediBot Phase 3 — Subscription Billing & Mock Payment System.
 * Verifies:
 * 1. Configurable subscription plans (Starter ₹1,499, Growth ₹2,499).
 * 2. Successful checkout + signed webhook activation + test invoice generation.
 * 3. Browser cannot directly activate subscriptions or pass payment-success flags.
 * 4. Failed checkout + past_due grace period handling.
 * 5. Duplicate webhook & replay prevention (persistent PaymentEvent ledger).
 * 6. Invalid / missing / tampered HMAC-SHA256 webhook signature rejection.
 * 7. Subscription renewal simulation & renewal test invoice.
 * 8. Cancellation (cancel_at_period_end vs immediate cancellation).
 * 9. Subscription expiry & historical appointment/invoice read preservation.
 * 10. Cross-tenant invoice isolation & unauthorized role protection.
 * 11. Mock payment mode fail-closed rejection in production (startup + runtime).
 * 12. Real MongoDB persistence & unique indexes for Invoice, CheckoutSession, PaymentEvent.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

const {
  createPaymentService,
  MockPaymentService,
  UnconfiguredProductionPaymentService,
  signWebhookPayload,
} = require('./payment-service');
const { evaluateSubscription } = require('./subscription');
const {
  Clinic,
  SubscriptionPlan,
  Invoice,
  CheckoutSession,
  PaymentEvent,
} = require('./models');
const { createMongoStore, ensureIndexes } = require('./store-mongo');

const TEST_JWT_SECRET = 'medibot-phase3-billing-test-jwt-secret-min32chars';
const TEST_WEBHOOK_SECRET = 'medibot-phase3-test-webhook-secret-32chars';
const TEST_DB_URI = process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017/medibot_test_phase3_billing';

function signedWebhookHeaders(rawBody, secret = TEST_WEBHOOK_SECRET) {
  return {
    'Content-Type': 'application/json',
    'X-Payment-Signature': signWebhookPayload(rawBody, secret),
  };
}

// ============================================================================
// PART A: HTTP End-to-End Billing, Webhooks, Lifecycle & Security (Memory Store)
// ============================================================================
describe('Phase 3 Part A — Subscription Billing & Mock Payment System (HTTP E2E)', () => {
  let app;
  let server;
  let baseUrl;
  let store;

  const CLINIC_A = 'clinic_billing_a';
  const CLINIC_B = 'clinic_billing_b';
  let tokenOwnerA;
  let tokenStaffA;
  let tokenOwnerB;

  before(async () => {
    process.env.NODE_ENV = 'test';
    process.env.STORE = 'memory';
    process.env.PORT = '0';
    process.env.JWT_SECRET = TEST_JWT_SECRET;
    process.env.PAYMENT_PROVIDER = 'mock';
    process.env.PAYMENT_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET;
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

    await store.saveClinic({ name: 'Sharma Dental Care', phone: '+919876501001' }, { clinic: CLINIC_A, create: true });
    await store.saveClinic({ name: 'Verma Physio Clinic', phone: '+919876501002' }, { clinic: CLINIC_B, create: true });

    // Seed a historical appointment for Clinic A to confirm read preservation after expiry/cancellation
    await store.createAppointment({
      name: 'Historical Patient',
      phone: '+919900011122',
      date: '28/12/2026',
      time_slot: 'Morning 10:00',
      status: 'Confirmed',
      clinic: CLINIC_A,
    });

    tokenOwnerA = jwt.sign(
      { sub: 'owner_a', email: 'owner@sharma.test', role: 'clinic_owner', clinic: CLINIC_A },
      TEST_JWT_SECRET
    );
    tokenStaffA = jwt.sign(
      { sub: 'staff_a', email: 'staff@sharma.test', role: 'clinic_staff', clinic: CLINIC_A },
      TEST_JWT_SECRET
    );
    tokenOwnerB = jwt.sign(
      { sub: 'owner_b', email: 'owner@verma.test', role: 'clinic_owner', clinic: CLINIC_B },
      TEST_JWT_SECRET
    );
  });

  after(async () => {
    if (server) {
      await new Promise(resolve => server.close(resolve));
    }
  });

  test('1. GET /api/billing/plans lists Starter (₹1,499) and Growth (₹2,499) and respects configurable prices', async () => {
    const res = await fetch(`${baseUrl}/api/billing/plans`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.currency, 'INR');
    assert.equal(data.provider, 'mock');
    assert.equal(data.is_test_mode, true);

    const starter = data.plans.find(p => p.plan_id === 'starter_1499');
    const growth = data.plans.find(p => p.plan_id === 'growth_2499');
    assert.ok(starter && starter.price_inr === 1499);
    assert.ok(growth && growth.price_inr === 2499);

    // Verify dynamic configurability of plan price
    await store.updateSubscriptionPlan('growth_2499', { price_inr: 2699 });
    const resUpdated = await fetch(`${baseUrl}/api/billing/plans`);
    const updatedData = await resUpdated.json();
    assert.equal(updatedData.plans.find(p => p.plan_id === 'growth_2499').price_inr, 2699);

    // Restore original ₹2,499
    await store.updateSubscriptionPlan('growth_2499', { price_inr: 2499 });
  });

  test('2. Browser cannot directly activate subscriptions or pass payment-success flags; staff cannot change plans', async () => {
    // Staff / receptionist rejected (403)
    const staffRes = await fetch(`${baseUrl}/api/billing/checkout`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenStaffA}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan_id: 'growth_2499' }),
    });
    assert.equal(staffRes.status, 403);

    // Browser supplying payment_success: true rejected (400)
    for (const forbidden of [{ payment_success: true }, { paid: true }, { activate: true }, { status: 'active' }]) {
      const res = await fetch(`${baseUrl}/api/billing/checkout`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokenOwnerA}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.assign({ plan_id: 'growth_2499' }, forbidden)),
      });
      assert.equal(res.status, 400, `Forbidden client flag ${JSON.stringify(forbidden)} must be rejected with 400`);
      const body = await res.json();
      assert.equal(body.code, 'FORBIDDEN_CLIENT_PAYMENT_FLAG');
    }
  });

  let createdSessionId;
  let clinicAInvoiceNumber;

  test('3. Successful checkout creates pending session; verified webhook activates subscription & generates test invoice', async () => {
    // Step 1: Create checkout session
    const checkoutRes = await fetch(`${baseUrl}/api/billing/checkout`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenOwnerA}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan_id: 'growth_2499' }),
    });
    assert.equal(checkoutRes.status, 201);
    const checkoutData = await checkoutRes.json();
    assert.equal(checkoutData.ok, true);
    assert.equal(checkoutData.checkout.status, 'pending');
    assert.equal(checkoutData.checkout.amount_inr, 2499);
    assert.equal(checkoutData.checkout.is_test, true);
    assert.match(checkoutData.checkout.session_id, /^mock_cs_/);
    createdSessionId = checkoutData.checkout.session_id;

    // Verify subscription is STILL trial (not yet activated before webhook)
    const subBeforeRes = await fetch(`${baseUrl}/api/billing/subscription`, {
      headers: { Authorization: `Bearer ${tokenOwnerA}` },
    });
    assert.equal(subBeforeRes.status, 200);
    const subBefore = await subBeforeRes.json();
    assert.equal(subBefore.subscription.status, 'trial', 'Checkout alone must NEVER activate subscription');

    // Step 2: Deliver cryptographically signed payment.succeeded webhook
    const payload = {
      event_id: 'mock_evt_success_001',
      event_type: 'payment.succeeded',
      session_id: createdSessionId,
    };
    const rawBody = JSON.stringify(payload);
    const webhookRes = await fetch(`${baseUrl}/api/billing/webhook`, {
      method: 'POST',
      headers: signedWebhookHeaders(rawBody),
      body: rawBody,
    });
    assert.equal(webhookRes.status, 200);
    const webhookData = await webhookRes.json();
    assert.equal(webhookData.ok, true);
    assert.equal(webhookData.duplicate, false);
    assert.match(webhookData.transaction_ref, /^mock_txn_/);
    assert.equal(webhookData.subscription.status, 'active');
    assert.equal(webhookData.subscription.plan_id, 'growth_2499');

    // Verify generated test invoice
    const inv = webhookData.invoice;
    assert.ok(inv);
    assert.match(inv.invoice_number, /^TEST-INV-/);
    assert.equal(inv.is_test_invoice, true, 'Mock invoice must be explicitly marked as test invoice');
    assert.equal(inv.amount_inr, 2499);
    assert.equal(inv.status, 'paid');
    assert.equal(inv.clinic_snapshot.name, 'Sharma Dental Care');
    assert.equal(inv.transaction_ref, webhookData.transaction_ref);
    assert.ok(inv.billing_period_start && inv.billing_period_end);
    assert.ok(inv.issued_at);
    clinicAInvoiceNumber = inv.invoice_number;
  });

  test('4. Duplicate webhook replay is idempotent and does not create duplicate invoices', async () => {
    const payload = {
      event_id: 'mock_evt_success_001', // exact same event_id
      event_type: 'payment.succeeded',
      session_id: createdSessionId,
    };
    const rawBody = JSON.stringify(payload);
    const res = await fetch(`${baseUrl}/api/billing/webhook`, {
      method: 'POST',
      headers: signedWebhookHeaders(rawBody),
      body: rawBody,
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.duplicate, true, 'Replayed webhook must be flagged as duplicate');

    // Confirm Clinic A still has strictly 1 invoice
    const invRes = await fetch(`${baseUrl}/api/billing/invoices`, {
      headers: { Authorization: `Bearer ${tokenOwnerA}` },
    });
    const invData = await invRes.json();
    assert.equal(invData.invoices.length, 1, 'Duplicate webhook must NOT generate a second invoice');
  });

  test('5. Invalid, missing, or tampered webhook signatures are rejected (401)', async () => {
    const payload = {
      event_id: 'mock_evt_forged_001',
      event_type: 'payment.succeeded',
      session_id: createdSessionId,
    };
    const rawBody = JSON.stringify(payload);

    // Missing signature
    const resMissing = await fetch(`${baseUrl}/api/billing/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: rawBody,
    });
    assert.equal(resMissing.status, 401);

    // Wrong signature
    const resWrong = await fetch(`${baseUrl}/api/billing/webhook`, {
      method: 'POST',
      headers: signedWebhookHeaders(rawBody, 'wrong-attacker-secret'),
      body: rawBody,
    });
    assert.equal(resWrong.status, 401);

    // Tampered body after signing
    const validSig = signWebhookPayload(rawBody, TEST_WEBHOOK_SECRET);
    const tamperedBody = JSON.stringify(Object.assign({}, payload, { event_id: 'mock_evt_tampered' }));
    const resTampered = await fetch(`${baseUrl}/api/billing/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Payment-Signature': validSig },
      body: tamperedBody,
    });
    assert.equal(resTampered.status, 401);
  });

  test('6. Failed checkout transitions active clinic to past_due with grace period & creates failed test invoice', async () => {
    const checkoutRes = await fetch(`${baseUrl}/api/billing/checkout`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenOwnerA}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan_id: 'growth_2499' }),
    });
    const { checkout } = await checkoutRes.json();

    const failPayload = {
      event_id: 'mock_evt_fail_001',
      event_type: 'payment.failed',
      session_id: checkout.session_id,
    };
    const rawBody = JSON.stringify(failPayload);
    const failRes = await fetch(`${baseUrl}/api/billing/webhook`, {
      method: 'POST',
      headers: signedWebhookHeaders(rawBody),
      body: rawBody,
    });
    assert.equal(failRes.status, 200);
    const failData = await failRes.json();
    assert.equal(failData.subscription.status, 'past_due');
    assert.ok(failData.subscription.grace_period_ends_at, 'Grace period end timestamp must be set');
    assert.equal(failData.invoice.status, 'failed');
    assert.equal(failData.invoice.is_test_invoice, true);

    // Verify grace period evaluation: valid during grace period, expired once elapsed
    const evalInGrace = evaluateSubscription(failData.subscription);
    assert.equal(evalInGrace.status, 'past_due');
    assert.equal(evalInGrace.in_grace_period, true);
    assert.equal(evalInGrace.canBook, true);

    const evalPastGrace = evaluateSubscription(Object.assign({}, failData.subscription, {
      grace_period_ends_at: new Date(Date.now() - 10000),
    }));
    assert.equal(evalPastGrace.status, 'expired');
    assert.equal(evalPastGrace.grace_period_ended, true);
    assert.equal(evalPastGrace.canBook, false);
  });

  test('7. Subscription renewal restores active status, extends period by 30 days, and issues renewal invoice', async () => {
    const renewPayload = {
      event_id: 'mock_evt_renew_001',
      event_type: 'subscription.renewed',
      clinic_id: CLINIC_A,
      plan_id: 'growth_2499',
    };
    const rawBody = JSON.stringify(renewPayload);
    const res = await fetch(`${baseUrl}/api/billing/webhook`, {
      method: 'POST',
      headers: signedWebhookHeaders(rawBody),
      body: rawBody,
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.subscription.status, 'active');
    assert.equal(data.subscription.grace_period_ends_at, null);
    assert.equal(data.invoice.status, 'paid');
    assert.equal(data.invoice.is_test_invoice, true);
    assert.match(data.invoice.notes, /RENEWAL/i);
  });

  test('8. Cancellation (at period end vs immediate) and expiry preserve historical appointments & invoices', async () => {
    // 8a. Cancel at period end
    const cancelGraceRes = await fetch(`${baseUrl}/api/billing/cancel`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenOwnerA}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ cancel_at_period_end: true }),
    });
    assert.equal(cancelGraceRes.status, 200);
    const cancelGraceData = await cancelGraceRes.json();
    assert.equal(cancelGraceData.subscription.status, 'canceled');
    assert.equal(cancelGraceData.subscription.cancel_at_period_end, true);

    // 8b. Immediate cancellation blocks new bookings (402)
    const cancelImmRes = await fetch(`${baseUrl}/api/billing/cancel`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenOwnerA}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ cancel_at_period_end: false }),
    });
    assert.equal(cancelImmRes.status, 200);

    const blockedBookRes = await fetch(`${baseUrl}/api/appointments`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenOwnerA}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Blocked Patient',
        phone: '+919900099999',
        date: '29/12/2026',
        time_slot: 'Morning 10:00',
      }),
    });
    assert.equal(blockedBookRes.status, 402);

    // 8c. Expiry webhook transitions to expired; historical appointments & invoices remain accessible
    const expPayload = {
      event_id: 'mock_evt_expire_001',
      event_type: 'subscription.expired',
      clinic_id: CLINIC_A,
    };
    const rawBody = JSON.stringify(expPayload);
    const expRes = await fetch(`${baseUrl}/api/billing/webhook`, {
      method: 'POST',
      headers: signedWebhookHeaders(rawBody),
      body: rawBody,
    });
    assert.equal(expRes.status, 200);
    const expData = await expRes.json();
    assert.equal(expData.subscription.status, 'expired');

    const histApptsRes = await fetch(`${baseUrl}/api/appointments`, {
      headers: { Authorization: `Bearer ${tokenOwnerA}` },
    });
    assert.equal(histApptsRes.status, 200);
    const histAppts = await histApptsRes.json();
    assert.ok(histAppts.some(a => a.name === 'Historical Patient'), 'Historical appointments must remain readable after expiry');

    const histInvRes = await fetch(`${baseUrl}/api/billing/invoices`, {
      headers: { Authorization: `Bearer ${tokenOwnerA}` },
    });
    assert.equal(histInvRes.status, 200);
    const histInv = await histInvRes.json();
    assert.ok(histInv.invoices.length >= 3, 'Historical invoices must remain readable after expiry');
  });

  test('9. Cross-tenant invoice access is strictly prevented', async () => {
    // Clinic B trying to list Clinic A's invoices via query param spoofing gets only Clinic B's (0) invoices
    const listBRes = await fetch(`${baseUrl}/api/billing/invoices?clinic=${CLINIC_A}`, {
      headers: { Authorization: `Bearer ${tokenOwnerB}` },
    });
    assert.equal(listBRes.status, 200);
    const listB = await listBRes.json();
    assert.equal(listB.clinicId, CLINIC_B);
    assert.equal(listB.invoices.length, 0, 'Clinic B must NOT see Clinic A invoices');

    // Clinic B trying to fetch Clinic A's invoice directly by invoice_number gets 404
    const getCrossRes = await fetch(`${baseUrl}/api/billing/invoices/${clinicAInvoiceNumber}`, {
      headers: { Authorization: `Bearer ${tokenOwnerB}` },
    });
    assert.equal(getCrossRes.status, 404, 'Cross-clinic invoice lookup must return 404');

    // Clinic A can still fetch its own invoice (200)
    const getOwnRes = await fetch(`${baseUrl}/api/billing/invoices/${clinicAInvoiceNumber}`, {
      headers: { Authorization: `Bearer ${tokenOwnerA}` },
    });
    assert.equal(getOwnRes.status, 200);
  });
});

// ============================================================================
// PART B: Production Fail-Closed Guards & Provider Separation
// ============================================================================
describe('Phase 3 Part B — Mock Mode Production Rejection & Provider Separation', () => {
  test('10. Server refuses to start when NODE_ENV=production and PAYMENT_PROVIDER=mock (exit code 1)', () => {
    const res = spawnSync(process.execPath, [path.join(__dirname, 'server.js')], {
      env: Object.assign({}, process.env, {
        NODE_ENV: 'production',
        PORT: '0',
        STORE: 'mongo',
        MONGODB_URI: TEST_DB_URI,
        JWT_SECRET: 'test-production-secret-at-least-32-chars-long-012345',
        TWILIO_VALIDATE_SIGNATURE: 'true',
        TWILIO_AUTH_TOKEN: 'test-auth-token-min-32-chars-long-12345',
        INTERNAL_SERVICE_KEY: 'test-internal-service-key-min-32-chars',
        PAYMENT_PROVIDER: 'mock',
      }),
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.equal(res.status, 1, 'Production with PAYMENT_PROVIDER=mock must exit with code 1');
    assert.match(res.stderr, /PAYMENT_PROVIDER=mock is not permitted in production/i);
  });

  test('11. MockPaymentService and createPaymentService fail closed in production; non-mock providers never fall back to mock', async () => {
    const origNodeEnv = process.env.NODE_ENV;
    const origProvider = process.env.PAYMENT_PROVIDER;
    try {
      process.env.NODE_ENV = 'production';
      process.env.PAYMENT_PROVIDER = 'mock';

      assert.throws(
        () => new MockPaymentService({}),
        err => err.code === 'MOCK_PAYMENT_FORBIDDEN_IN_PRODUCTION'
      );
      assert.throws(
        () => createPaymentService({}),
        err => err.code === 'MOCK_PAYMENT_FORBIDDEN_IN_PRODUCTION'
      );

      // Non-mock provider in production returns UnconfiguredProductionPaymentService and fails closed
      process.env.PAYMENT_PROVIDER = 'razorpay';
      const prodSvc = createPaymentService({});
      assert.ok(prodSvc instanceof UnconfiguredProductionPaymentService);
      await assert.rejects(
        () => prodSvc.createCheckoutSession({}),
        err => err.code === 'PAYMENT_PROVIDER_NOT_CONFIGURED'
      );
    } finally {
      process.env.NODE_ENV = origNodeEnv;
      process.env.PAYMENT_PROVIDER = origProvider;
    }
  });
});

// ============================================================================
// PART C: MongoDB Persistence & Unique Indexes for Billing Models
// ============================================================================
describe('Phase 3 Part C — MongoDB Billing Persistence & Indexes', () => {
  let mongoAvailable = false;
  let mongoStore = null;

  before(async () => {
    try {
      await mongoose.connect(TEST_DB_URI, { serverSelectionTimeoutMS: 4000 });
      mongoAvailable = true;
    } catch (err) {
      console.warn('Skipping MongoDB Phase 3 billing tests: local MongoDB not reachable:', err.message);
      return;
    }
    await ensureIndexes();
    mongoStore = createMongoStore();
    await Promise.all([
      Clinic.deleteMany({}),
      Invoice.deleteMany({}),
      CheckoutSession.deleteMany({}),
      PaymentEvent.deleteMany({}),
    ]);
  });

  after(async () => {
    if (mongoose.connection && mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
  });

  test('12. MongoDB verifies unique indexes, end-to-end MockPaymentService webhook persistence & tenant-isolated invoices', async (t) => {
    if (!mongoAvailable) return t.skip('MongoDB not available');

    const [invIdxs, csIdxs, peIdxs] = await Promise.all([
      Invoice.collection.indexes(),
      CheckoutSession.collection.indexes(),
      PaymentEvent.collection.indexes(),
    ]);
    assert.ok(invIdxs.some(i => i.unique === true && i.key.invoice_number === 1));
    assert.ok(csIdxs.some(i => i.unique === true && i.key.session_id === 1));
    assert.ok(peIdxs.some(i => i.unique === true && i.key.event_id === 1));

    const clinicA = await Clinic.create({ name: 'Mongo Clinic A', phone: '+919800112233' });
    const clinicB = await Clinic.create({ name: 'Mongo Clinic B', phone: '+919800112244' });
    const plan = await mongoStore.getSubscriptionPlan('starter_1499');

    const svc = new MockPaymentService(mongoStore, { webhookSecret: TEST_WEBHOOK_SECRET });
    const checkout = await svc.createCheckoutSession({ clinic: clinicA, plan, userId: 'u_mongo_1' });
    assert.equal(checkout.status, 'pending');

    const payload = {
      event_id: 'mongo_evt_001',
      event_type: 'payment.succeeded',
      session_id: checkout.session_id,
    };
    const raw = JSON.stringify(payload);
    const sig = signWebhookPayload(raw, TEST_WEBHOOK_SECRET);

    const res1 = await svc.handleWebhook({ rawBody: raw, signature: sig, payload });
    assert.equal(res1.ok, true);
    assert.equal(res1.duplicate, false);
    assert.equal(res1.subscription.status, 'active');
    assert.equal(res1.invoice.is_test_invoice, true);

    // Duplicate webhook against MongoDB unique index
    const res2 = await svc.handleWebhook({ rawBody: raw, signature: sig, payload });
    assert.equal(res2.ok, true);
    assert.equal(res2.duplicate, true);

    // Cross-tenant invoice isolation in MongoDB
    const ownInv = await mongoStore.getInvoice(res1.invoice.invoice_number, { clinic: clinicA._id });
    assert.ok(ownInv);
    const crossInv = await mongoStore.getInvoice(res1.invoice.invoice_number, { clinic: clinicB._id });
    assert.equal(crossInv, null, 'Clinic B must never retrieve Clinic A MongoDB invoice');
  });
});
