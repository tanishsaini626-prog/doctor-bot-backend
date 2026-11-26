'use strict';
/**
 * test-phase1-saas-subscription.js
 *
 * Automated test suite for MediBot Phase 1 — Subscription & Usage Data Models.
 * Verifies:
 * 1. SubscriptionPlan model validation (plan_id, name, price_inr, included limits, features).
 * 2. Clinic subscription defaults (trial status, 14-day trial, period dates, provider fields).
 * 3. ClinicUsage model and tenant isolation ({ clinic, billing_month } uniqueness).
 * 4. Memory store compatibility (plans, clinic subscriptions, atomic usage increments).
 * 5. Memory snapshot and hydrate durability (persistence seams).
 * 6. File store compatibility (flushing and reloading subscription/usage data).
 * 7. MongoDB schema and index definition verification.
 * 8. Backward compatibility for legacy clinics without explicit subscription objects.
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

const { createMemoryStore } = require('./store-memory');
const { createFileStore } = require('./store-file');
const { createMongoStore } = require('./store-mongo');

// ============================================================================
// 1. SubscriptionPlan Data Model Verification
// ============================================================================
test('1. SubscriptionPlan schema validation', () => {
  // Plan ID, name and price are required
  const plan = new SubscriptionPlan({
    plan_id: 'STARTER_1499 ',
    name: 'Clinic Starter',
    price_inr: 1499,
    included_call_minutes: 350,
    included_bookings: 150,
    max_doctors: 2,
    features: ['hindi_voice', 'whatsapp_alerts', 'analytics'],
  });

  assert.equal(plan.plan_id, 'starter_1499', 'plan_id should be trimmed and lowercased');
  assert.equal(plan.price_inr, 1499);
  assert.equal(plan.billing_interval, 'month');
  assert.equal(plan.included_call_minutes, 350);
  assert.equal(plan.included_bookings, 150);
  assert.equal(plan.max_doctors, 2);
  assert.deepEqual(plan.features, ['hindi_voice', 'whatsapp_alerts', 'analytics']);
  assert.equal(plan.active, true);

  // Validate negative price fails validation
  const invalidPlan = new SubscriptionPlan({
    plan_id: 'invalid',
    name: 'Invalid',
    price_inr: -100,
  });
  const err = invalidPlan.validateSync();
  assert.ok(err, 'Validation should fail for negative price_inr');
  assert.ok(err.errors.price_inr, 'price_inr should have validation error');
});

test('1b. Default subscription plans definition', () => {
  assert.ok(Array.isArray(DEFAULT_PLANS), 'DEFAULT_PLANS should be an array');
  assert.ok(DEFAULT_PLANS.length >= 2, 'Should have at least 2 default plans');

  const starter = DEFAULT_PLANS.find(p => p.plan_id === 'starter_1499');
  assert.ok(starter, 'Starter plan (starter_1499) must exist');
  assert.equal(starter.price_inr, 1499);
  assert.equal(starter.included_call_minutes, 350);
  assert.equal(starter.included_bookings, 150);
  assert.equal(starter.max_doctors, 2);

  const growth = DEFAULT_PLANS.find(p => p.plan_id === 'growth_2499');
  assert.ok(growth, 'Growth plan (growth_2499) must exist');
  assert.equal(growth.price_inr, 2499);
  assert.equal(growth.max_doctors, 5);
});

// ============================================================================
// 2. Clinic Subscription Defaults & Field Verification
// ============================================================================
test('2. Clinic subscription defaults to trial without breaking existing clinics', () => {
  const clinic = new Clinic({
    name: 'City Care Hospital',
    phone: '+919876543210',
  });

  assert.ok(clinic.subscription, 'Subscription object must exist on clinic');
  assert.equal(clinic.subscription.status, 'trial', 'Default status must be trial');
  assert.equal(clinic.subscription.plan_id, 'starter_1499');
  assert.equal(clinic.subscription.payment_provider, 'mock');
  assert.equal(clinic.subscription.cancel_at_period_end, false);
  assert.ok(clinic.subscription.trial_ends_at instanceof Date, 'trial_ends_at must be a Date');
  assert.ok(clinic.subscription.trial_ends_at.getTime() > Date.now(), 'trial_ends_at must be in the future');
});

test('2b. Clinic subscription allows all specified lifecycle states', () => {
  const allowedStatuses = ['trial', 'active', 'past_due', 'canceled', 'expired'];
  for (const st of allowedStatuses) {
    const c = new Clinic({
      name: 'Test Clinic',
      phone: '+919876543211',
      subscription: { status: st, plan_id: 'growth_2499' },
    });
    const err = c.validateSync();
    assert.equal(err, undefined, `Status ${st} must be valid`);
    assert.equal(c.subscription.status, st);
  }

  // Invalid status rejected
  const invalid = new Clinic({
    name: 'Invalid Clinic',
    subscription: { status: 'unlimited_free' },
  });
  const err = invalid.validateSync();
  assert.ok(err && err.errors['subscription.status'], 'Invalid subscription status must be rejected');
});

// ============================================================================
// 3. ClinicUsage Data Model & Index Definition
// ============================================================================
test('3. ClinicUsage schema validates billing_month format (YYYY-MM)', () => {
  const clinicId = new mongoose.Types.ObjectId();
  const valid = new ClinicUsage({
    clinic: clinicId,
    billing_month: '2026-11',
    call_count: 42,
    call_minutes: 63,
    booking_count: 18,
    whatsapp_count: 18,
  });

  const validErr = valid.validateSync();
  assert.equal(validErr, undefined, '2026-11 should be a valid billing_month');
  assert.equal(valid.call_count, 42);
  assert.equal(valid.call_minutes, 63);

  // Invalid format (not YYYY-MM)
  const invalidMonth = new ClinicUsage({
    clinic: clinicId,
    billing_month: '2026/11',
  });
  const err1 = invalidMonth.validateSync();
  assert.ok(err1 && err1.errors.billing_month, 'Slash format must be rejected');

  const invalidMonth2 = new ClinicUsage({
    clinic: clinicId,
    billing_month: 'Nov-2026',
  });
  const err2 = invalidMonth2.validateSync();
  assert.ok(err2 && err2.errors.billing_month, 'Text month must be rejected');

  // Verify unique compound index definition on schema
  const indexes = ClinicUsage.schema.indexes();
  const hasCompoundUnique = indexes.some(
    idx => idx[0] && idx[0].clinic === 1 && idx[0].billing_month === 1 && idx[1] && idx[1].unique === true
  );
  assert.ok(hasCompoundUnique, 'ClinicUsage must define compound unique index on { clinic: 1, billing_month: 1 }');
});

// ============================================================================
// 4. Memory Store Compatibility
// ============================================================================
test('4a. Memory store pre-seeds default subscription plans', async () => {
  const store = createMemoryStore();
  const plans = await store.listSubscriptionPlans();
  assert.ok(plans.length >= 2, 'Default plans should be listed');
  assert.equal(plans[0].plan_id, 'starter_1499');

  const starter = await store.getSubscriptionPlan('starter_1499');
  assert.ok(starter);
  assert.equal(starter.name, 'Clinic Starter');
  assert.equal(starter.price_inr, 1499);
});

test('4b. Memory store creates and updates subscription plans', async () => {
  const store = createMemoryStore();
  const custom = await store.createSubscriptionPlan({
    plan_id: 'enterprise_custom',
    name: 'Enterprise VIP',
    price_inr: 4999,
    included_call_minutes: 2000,
    max_doctors: 20,
  });

  assert.equal(custom.plan_id, 'enterprise_custom');
  assert.equal(custom.price_inr, 4999);

  // Duplicate plan_id rejected
  await assert.rejects(
    async () => {
      await store.createSubscriptionPlan({ plan_id: 'enterprise_custom', name: 'Dup', price_inr: 5000 });
    },
    /already exists/
  );

  // Update plan
  const updated = await store.updateSubscriptionPlan('enterprise_custom', { price_inr: 4499, name: 'Enterprise Pro' });
  assert.equal(updated.price_inr, 4499);
  assert.equal(updated.name, 'Enterprise Pro');
});

test('4c. Memory store clinic subscription lifecycle and safe defaults', async () => {
  const store = createMemoryStore();
  const clinic = await store.saveClinic({ name: 'Dental Care Center', phone: '+919988776655' }, { clinic: 'clinic_test_1', create: true });
  assert.ok(clinic);

  // Read subscription
  const subInfo = await store.getClinicSubscription('clinic_test_1');
  assert.ok(subInfo);
  assert.equal(subInfo.clinic_id, 'clinic_test_1');
  assert.equal(subInfo.subscription.status, 'trial');
  assert.equal(subInfo.subscription.plan_id, 'starter_1499');

  // Update subscription to active
  const activated = await store.updateClinicSubscription('clinic_test_1', {
    status: 'active',
    plan_id: 'growth_2499',
    payment_provider: 'mock',
    subscription_id: 'sub_mock_12345',
  });
  assert.equal(activated.subscription.status, 'active');
  assert.equal(activated.subscription.plan_id, 'growth_2499');
  assert.equal(activated.subscription.subscription_id, 'sub_mock_12345');

  // Verify subsequent read returns updated status
  const reRead = await store.getClinicSubscription('clinic_test_1');
  assert.equal(reRead.subscription.status, 'active');
});

test('4d. Memory store atomic monthly usage tracking & tenant isolation', async () => {
  const store = createMemoryStore();
  const clinicA = 'clinic_alpha';
  const clinicB = 'clinic_beta';

  // 1. Get or create initializes usage with 0 counts
  const usageA = await store.getOrCreateClinicUsage(clinicA, '2026-11');
  assert.equal(usageA.clinic, clinicA);
  assert.equal(usageA.billing_month, '2026-11');
  assert.equal(usageA.call_count, 0);
  assert.equal(usageA.call_minutes, 0);

  // 2. Increment usage atomically
  await store.recordClinicUsage(clinicA, '2026-11', { call_count: 1, call_minutes: 2, booking_count: 1, whatsapp_count: 1 });
  await store.recordClinicUsage(clinicA, '2026-11', { call_count: 2, call_minutes: 3 });

  const updatedA = await store.getClinicUsage(clinicA, '2026-11');
  assert.equal(updatedA.call_count, 3);
  assert.equal(updatedA.call_minutes, 5);
  assert.equal(updatedA.booking_count, 1);
  assert.equal(updatedA.whatsapp_count, 1);

  // 3. Strict Tenant Isolation: Clinic B must not see or affect Clinic A's usage
  const usageB = await store.getClinicUsage(clinicB, '2026-11');
  assert.equal(usageB, null, 'Clinic B should have no usage recorded yet');

  await store.recordClinicUsage(clinicB, '2026-11', { call_count: 5 });
  const updatedB = await store.getClinicUsage(clinicB, '2026-11');
  assert.equal(updatedB.call_count, 5);

  // Verify Clinic A is unchanged by Clinic B's activity
  const checkA = await store.getClinicUsage(clinicA, '2026-11');
  assert.equal(checkA.call_count, 3);

  // 4. Invalid billing month formats rejected
  await assert.rejects(
    async () => store.recordClinicUsage(clinicA, 'invalid-date', { call_count: 1 }),
    /Valid billing_month/
  );
  await assert.rejects(
    async () => store.getOrCreateClinicUsage(clinicA, '2026/11'),
    /Valid billing_month/
  );
});

// ============================================================================
// 5. Memory Store Snapshot & Hydration Durability
// ============================================================================
test('5. Memory store snapshot and hydrate preserves plans and usage records', async () => {
  const store1 = createMemoryStore();
  await store1.createSubscriptionPlan({ plan_id: 'custom_plan', name: 'Custom', price_inr: 1999 });
  await store1.saveClinic({ name: 'Clinic One' }, { clinic: 'c_one', create: true });
  await store1.recordClinicUsage('c_one', '2026-11', { call_count: 12, booking_count: 4 });

  const snapshot = store1.__snapshot();
  assert.ok(Array.isArray(snapshot.plans));
  assert.ok(Array.isArray(snapshot.clinicUsages));

  // Hydrate into clean store
  const store2 = createMemoryStore();
  store2.__hydrate(snapshot);

  const plan = await store2.getSubscriptionPlan('custom_plan');
  assert.ok(plan);
  assert.equal(plan.price_inr, 1999);

  const usage = await store2.getClinicUsage('c_one', '2026-11');
  assert.ok(usage);
  assert.equal(usage.call_count, 12);
  assert.equal(usage.booking_count, 4);
});

// ============================================================================
// 6. File Store Durability
// ============================================================================
test('6. File store persists subscription plans, clinic subscriptions and usage to disk', async () => {
  const tmpFile = path.join(os.tmpdir(), `medibot-store-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);

  try {
    const fileStore1 = createFileStore(tmpFile);
    await fileStore1.saveClinic({ name: 'File Test Clinic', phone: '+919112233445' }, { clinic: 'file_clinic_1', create: true });
    await fileStore1.updateClinicSubscription('file_clinic_1', { status: 'active', plan_id: 'growth_2499' });
    await fileStore1.recordClinicUsage('file_clinic_1', '2026-11', { call_count: 15, call_minutes: 25, booking_count: 5 });
    fileStore1.flush();

    // Verify file exists on disk and contains data
    assert.ok(fs.existsSync(tmpFile), 'Persistence file must exist');
    const content = JSON.parse(fs.readFileSync(tmpFile, 'utf8'));
    assert.ok(Array.isArray(content.clinicUsages), 'clinicUsages must be serialized');
    assert.ok(content.clinicUsages.some(([k, v]) => k === 'file_clinic_1:2026-11' && v.call_count === 15));

    // Re-open with new store instance
    const fileStore2 = createFileStore(tmpFile);
    const sub = await fileStore2.getClinicSubscription('file_clinic_1');
    assert.equal(sub.subscription.status, 'active');
    assert.equal(sub.subscription.plan_id, 'growth_2499');

    const usage = await fileStore2.getClinicUsage('file_clinic_1', '2026-11');
    assert.equal(usage.call_count, 15);
    assert.equal(usage.call_minutes, 25);
  } finally {
    try { if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile); } catch (_) {}
  }
});

// ============================================================================
// 7. Mongo Store Schema & Tenant Isolation
// ============================================================================
test('7. Mongo store methods enforce clinic validation and tenant isolation', async () => {
  const mongoStore = createMongoStore();

  // Missing clinic throws immediately
  await assert.rejects(
    async () => mongoStore.getClinicSubscription(null),
    /clinic is required/
  );
  await assert.rejects(
    async () => mongoStore.getOrCreateClinicUsage(null, '2026-11'),
    /clinic is required/
  );
  await assert.rejects(
    async () => mongoStore.recordClinicUsage(null, '2026-11', { call_count: 1 }),
    /clinic is required/
  );
  await assert.rejects(
    async () => mongoStore.listClinicUsage(null),
    /clinic is required/
  );

  // Invalid ObjectId returns safe empty/null without crashing
  const badId = 'not-a-valid-object-id';
  const sub = await mongoStore.getClinicSubscription(badId);
  assert.equal(sub, null);

  const list = await mongoStore.listClinicUsage(badId);
  assert.deepEqual(list, []);
});

// ============================================================================
// 8. Backward Compatibility: Legacy Clinics Without Subscription Field
// ============================================================================
test('8. Legacy clinic without subscription field resolves safely to trial', async () => {
  const store = createMemoryStore();
  // Manually insert clinic without subscription property
  store.clinics.set('legacy_clinic_99', {
    _id: 'legacy_clinic_99',
    name: 'Legacy Practice',
    phone: '+919876500099',
    active: true,
  });

  const clinicDoc = await store.getClinic('legacy_clinic_99');
  assert.ok(clinicDoc);
  assert.ok(clinicDoc.subscription, 'Subscription must be auto-populated for legacy clinic');
  assert.equal(clinicDoc.subscription.status, 'trial');
  assert.equal(clinicDoc.subscription.plan_id, 'starter_1499');

  const subInfo = await store.getClinicSubscription('legacy_clinic_99');
  assert.equal(subInfo.subscription.status, 'trial');
});
