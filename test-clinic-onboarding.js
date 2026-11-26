'use strict';
/* ==========================================================================
 * test-clinic-onboarding.js - MediBot Batch 4E Secure Clinic Onboarding Tests
 *
 * Verifies:
 * 1. POST /api/auth/register-clinic creates clinic first, then user assigned as clinic_owner.
 * 2. Token issued carries role: 'clinic_owner' and clinic matching newly created clinic ID.
 * 3. Client cannot specify clinic ID (spoofing rejected with HTTP 400).
 * 4. User cannot register as platform admin (rejected with HTTP 400).
 * 5. Input validation and normalization (email, password, phone, name, clinic_name).
 * 6. Duplicate email rejected with HTTP 409.
 * 7. Duplicate active clinic phone number rejected with HTTP 409.
 * 8. Multi-tenant isolation: onboarded Clinic A cannot access Clinic B appointments or settings.
 * 9. Atomic rollback: failure during user creation deletes the newly created clinic (no orphans).
 * 10. requireClinic rejects inactive clinics (active === false) with HTTP 403 across dashboard APIs.
 * 11. requireClinic rejects unassigned clinic tokens (clinic === null) with HTTP 403.
 * 12. Production safeguard: NODE_ENV=production blocks registration unless secret/invite is provided.
 * 13. End-to-end compatibility with memory store and MongoDB (when TEST_MONGODB_URI is set).
 * ========================================================================== */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

process.env.STORE = 'memory';
process.env.TWILIO_VALIDATE_SIGNATURE = 'false';
const testSecret = process.env.TEST_JWT_SECRET || 'medibot-automated-test-suite-ephemeral-secret-min32chars';
process.env.JWT_SECRET = testSecret;

const serverApp = require('./server');

describe('MediBot Batch 4E: Secure Clinic Onboarding', () => {
  let serverInstance;
  let baseUrl;
  let serverStore;
  let ipIndex = 1;

  function nextIp() {
    return `192.168.100.${ipIndex++}`;
  }

  async function postOnboarding(path, payload, customHeaders = {}) {
    const headers = Object.assign({
      'Content-Type': 'application/json',
      'X-Forwarded-For': nextIp(),
    }, customHeaders);
    return fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers,
      body: payload ? JSON.stringify(payload) : undefined,
    });
  }

  before(async () => {
    if (serverApp.locals && serverApp.locals.storeReadyPromise) {
      await serverApp.locals.storeReadyPromise;
    }
    serverStore = serverApp.locals.store;

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
  // 1. HAPPY PATH REGISTRATION
  // --------------------------------------------------------------------------
  test('POST /api/auth/register-clinic succeeds and returns 201 with token, user, and clinic', async () => {
    const payload = {
      clinic_name: 'Care & Cure Health Clinic',
      admin_name: 'Dr. Anita Verma',
      email: 'anita.verma@careandcure.test',
      password: 'StrongPassword123!',
      phone: '+91 98111 22233',
    };

    const res = await postOnboarding('/api/auth/register-clinic', payload);

    assert.equal(res.status, 201, 'Should return HTTP 201 Created');
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.ok(body.token, 'Should return a JWT token');
    assert.ok(body.user, 'Should return the public user profile');
    assert.equal(body.user.email, 'anita.verma@careandcure.test');
    assert.equal(body.user.name, 'Dr. Anita Verma');
    assert.equal(body.user.role, 'clinic_owner', 'Must assign role clinic_owner');
    assert.ok(body.clinic, 'Should return the created clinic');
    assert.equal(body.clinic.name, 'Care & Cure Health Clinic');
    assert.equal(body.clinic.phone, '+919811122233', 'Phone must be normalized');
    assert.equal(body.clinic.active, true);
    assert.equal(String(body.user.clinic), String(body.clinic._id), 'User clinic must match created clinic ID');

    // Verify JWT payload
    const decoded = jwt.verify(body.token, process.env.JWT_SECRET);
    assert.equal(decoded.sub, String(body.user._id));
    assert.equal(decoded.email, 'anita.verma@careandcure.test');
    assert.equal(decoded.role, 'clinic_owner');
    assert.equal(String(decoded.clinic), String(body.clinic._id));

    // Authenticate with newly issued token to access dashboard
    const clinicRes = await fetch(`${baseUrl}/api/clinic`, {
      headers: { Authorization: `Bearer ${body.token}` },
    });
    assert.equal(clinicRes.status, 200);
    const clinicData = await clinicRes.json();
    assert.equal(clinicData.name, 'Care & Cure Health Clinic');

    const apptsRes = await fetch(`${baseUrl}/api/appointments`, {
      headers: { Authorization: `Bearer ${body.token}` },
    });
    assert.equal(apptsRes.status, 200);
    const appts = await apptsRes.json();
    assert.deepEqual(appts, []);
  });

  // --------------------------------------------------------------------------
  // 2. DUPLICATE EMAIL REJECTION
  // --------------------------------------------------------------------------
  test('POST /api/auth/register-clinic rejects duplicate email with HTTP 409', async () => {
    const payload = {
      clinic_name: 'Another Clinic',
      admin_name: 'Duplicate Admin',
      email: 'anita.verma@careandcure.test', // already registered in test 1
      password: 'StrongPassword123!',
      phone: '+91 98222 33344',
    };

    const res = await postOnboarding('/api/auth/register-clinic', payload);

    assert.equal(res.status, 409, 'Duplicate email must return HTTP 409 Conflict');
    const body = await res.json();
    assert.match(body.error, /already registered/i);
  });

  // --------------------------------------------------------------------------
  // 3. DUPLICATE CLINIC PHONE REJECTION
  // --------------------------------------------------------------------------
  test('POST /api/auth/register-clinic rejects duplicate clinic phone number with HTTP 409', async () => {
    const payload = {
      clinic_name: 'Second Clinic Same Phone',
      admin_name: 'New Admin',
      email: 'different.admin@test.com',
      password: 'StrongPassword123!',
      phone: '09811122233', // alternate format of +91 98111 22233
    };

    const res = await postOnboarding('/api/auth/register-clinic', payload);

    assert.equal(res.status, 409, 'Duplicate clinic phone must return HTTP 409 Conflict');
    const body = await res.json();
    assert.match(body.error, /already registered with this phone number/i);
  });

  // --------------------------------------------------------------------------
  // 4. CLIENT CLINIC ID SPOOFING REJECTION
  // --------------------------------------------------------------------------
  test('POST /api/auth/register-clinic rejects client-supplied clinic ID with HTTP 400', async () => {
    const spoofAttempts = [
      { clinic: '507f1f77bcf86cd799439011' },
      { clinic_id: '507f1f77bcf86cd799439011' },
      { clinicId: '507f1f77bcf86cd799439011' },
    ];

    for (const spoof of spoofAttempts) {
      const payload = Object.assign({
        clinic_name: 'Spoof Test Clinic',
        admin_name: 'Spoofer',
        email: `spoof.${Date.now()}.${Math.random()}@test.com`,
        password: 'Password123!',
        phone: '+91 98333 44455',
      }, spoof);

      const res = await postOnboarding('/api/auth/register-clinic', payload);

      assert.equal(res.status, 400, `Client-specified clinic ID (${Object.keys(spoof)[0]}) must return 400`);
      const body = await res.json();
      assert.match(body.error, /cannot specify clinic id/i);
    }
  });

  // --------------------------------------------------------------------------
  // 5. ROLE ESCALATION REJECTION
  // --------------------------------------------------------------------------
  test('POST /api/auth/register-clinic rejects role: admin with HTTP 400', async () => {
    const payload = {
      clinic_name: 'Escalation Clinic',
      admin_name: 'Hacker Admin',
      email: 'hacker@test.com',
      password: 'Password123!',
      phone: '+91 98444 55566',
      role: 'admin',
    };

    const res = await postOnboarding('/api/auth/register-clinic', payload);

    assert.equal(res.status, 400, 'Escalation to admin role must return HTTP 400');
    const body = await res.json();
    assert.match(body.error, /cannot register as platform admin/i);
  });

  // --------------------------------------------------------------------------
  // 6. INPUT VALIDATION
  // --------------------------------------------------------------------------
  test('POST /api/auth/register-clinic enforces input validation constraints', async () => {
    const baseValid = {
      clinic_name: 'Valid Clinic',
      admin_name: 'Valid Admin',
      email: 'valid.admin@test.com',
      password: 'Password123!',
      phone: '+91 98555 66677',
    };

    const invalidCases = [
      { patch: { clinic_name: '' }, reason: 'Empty clinic_name' },
      { patch: { clinic_name: 'A' }, reason: 'Clinic name < 2 chars' },
      { patch: { clinic_name: 'x'.repeat(151) }, reason: 'Clinic name > 150 chars' },
      { patch: { admin_name: 'A' }, reason: 'Admin name < 2 chars' },
      { patch: { admin_name: 'x'.repeat(101) }, reason: 'Admin name > 100 chars' },
      { patch: { email: 'not-an-email' }, reason: 'Invalid email' },
      { patch: { password: 'short' }, reason: 'Password < 8 chars' },
      { patch: { phone: '12345' }, reason: 'Invalid phone' },
      { patch: { phone: '' }, reason: 'Empty phone' },
    ];

    for (const { patch, reason } of invalidCases) {
      const payload = Object.assign({
        email: `valid.${Date.now()}.${Math.random()}@test.com`,
      }, baseValid, patch);
      const res = await postOnboarding('/api/auth/register-clinic', payload);

      assert.equal(res.status, 400, `Expected 400 for ${reason}`);
    }
  });

  // --------------------------------------------------------------------------
  // 7. ROUTE ALIASES: /api/onboarding and /api/auth/onboarding
  // --------------------------------------------------------------------------
  test('Onboarding endpoints are accessible via /api/onboarding and /api/auth/onboarding aliases', async () => {
    const p1 = {
      clinic_name: 'Alias Clinic 1',
      admin_name: 'Admin One',
      email: 'alias1@test.com',
      password: 'Password123!',
      phone: '+91 98666 77788',
    };

    const res1 = await postOnboarding('/api/onboarding', p1);
    assert.equal(res1.status, 201);
    const body1 = await res1.json();
    assert.equal(body1.clinic.name, 'Alias Clinic 1');

    const p2 = {
      clinic_name: 'Alias Clinic 2',
      admin_name: 'Admin Two',
      email: 'alias2@test.com',
      password: 'Password123!',
      phone: '+91 98777 88899',
    };

    const res2 = await postOnboarding('/api/auth/onboarding', p2);
    assert.equal(res2.status, 201);
    const body2 = await res2.json();
    assert.equal(body2.clinic.name, 'Alias Clinic 2');
  });

  // --------------------------------------------------------------------------
  // 8. MULTI-TENANT ISOLATION BETWEEN ONBOARDED CLINICS
  // --------------------------------------------------------------------------
  test('Onboarded Clinic A cannot access Clinic B appointments or settings', async () => {
    // Register Clinic A
    const resA = await postOnboarding('/api/auth/register-clinic', {
      clinic_name: 'Clinic Alpha Multi',
      admin_name: 'Admin Alpha',
      email: 'alpha.multi@test.com',
      password: 'Password123!',
      phone: '+91 99000 11111',
    });
    assert.equal(resA.status, 201);
    const { token: tokenA, clinic: clinicA } = await resA.json();

    // Register Clinic B
    const resB = await postOnboarding('/api/auth/register-clinic', {
      clinic_name: 'Clinic Beta Multi',
      admin_name: 'Admin Beta',
      email: 'beta.multi@test.com',
      password: 'Password123!',
      phone: '+91 99000 22222',
    });
    assert.equal(resB.status, 201);
    const { token: tokenB, clinic: clinicB } = await resB.json();

    // Clinic A creates an appointment
    const createRes = await fetch(`${baseUrl}/api/appointments`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokenA}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'Patient In Clinic A',
        phone: '+91 99999 55555',
        date: '25/12/2026',
        time_slot: 'Morning 10:00',
        reason: 'Fever',
      }),
    });
    assert.equal(createRes.status, 201);
    const apptA = await createRes.json();

    // Clinic B lists appointments: must NOT see Clinic A's appointment
    const listB = await fetch(`${baseUrl}/api/appointments`, {
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    assert.equal(listB.status, 200);
    const bAppts = await listB.json();
    assert.equal(bAppts.length, 0, 'Clinic B must have 0 appointments');

    // Clinic B attempts to retrieve Clinic A's appointment directly: must 404
    const getCross = await fetch(`${baseUrl}/api/appointments/${apptA._id}`, {
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    assert.equal(getCross.status, 404);

    // Clinic B attempts to delete Clinic A's appointment: must 404
    const delCross = await fetch(`${baseUrl}/api/appointments/${apptA._id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    assert.equal(delCross.status, 404);

    // Clinic A updates its settings
    const putRes = await fetch(`${baseUrl}/api/clinic`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${tokenA}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'Clinic Alpha Renamed' }),
    });
    assert.equal(putRes.status, 200);

    // Clinic B views its settings: remains Clinic Beta Multi
    const getClinicB = await fetch(`${baseUrl}/api/clinic`, {
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    assert.equal(getClinicB.status, 200);
    const clinicBData = await getClinicB.json();
    assert.equal(clinicBData.name, 'Clinic Beta Multi');
  });

  // --------------------------------------------------------------------------
  // 9. ATOMIC FAILURE ROLLBACK (NO ORPHAN CLINICS)
  // --------------------------------------------------------------------------
  test('Failure during user creation deletes clinic with zero orphan records', async () => {
    // Intercept store.createUser once to simulate unexpected failure
    const origCreateUser = serverStore.createUser;
    let attemptedClinicId = null;

    serverStore.createUser = async (data) => {
      attemptedClinicId = data.clinic;
      throw new Error('Simulated database failure during user creation');
    };

    try {
      const res = await postOnboarding('/api/auth/register-clinic', {
        clinic_name: 'Rollback Clinic',
        admin_name: 'Rollback Admin',
        email: 'rollback.admin@test.com',
        password: 'Password123!',
        phone: '+91 99111 22233',
      });

      assert.equal(res.status, 500, 'User failure must result in HTTP 500');
      assert.ok(attemptedClinicId, 'Should have created clinic ID before failure');

      // Verify the clinic was rolled back and does NOT exist in the store
      const orphanClinic = await serverStore.getClinic(attemptedClinicId);
      assert.equal(orphanClinic, null, 'Orphan clinic must have been deleted during rollback');

      // Verify phone was freed: registering again with the same phone must succeed
      serverStore.createUser = origCreateUser;

      const retryRes = await postOnboarding('/api/auth/register-clinic', {
        clinic_name: 'Rollback Clinic Retry',
        admin_name: 'Rollback Admin',
        email: 'rollback.admin@test.com',
        password: 'Password123!',
        phone: '+91 99111 22233',
      });

      assert.equal(retryRes.status, 201, 'Retrying registration after rollback must succeed');
    } finally {
      serverStore.createUser = origCreateUser;
    }
  });

  // --------------------------------------------------------------------------
  // 10. INACTIVE CLINIC GATING ACROSS DASHBOARD APIS
  // --------------------------------------------------------------------------
  test('requireClinic rejects inactive clinic (active: false) with HTTP 403 across dashboard APIs', async () => {
    // Register active clinic
    const regRes = await postOnboarding('/api/auth/register-clinic', {
      clinic_name: 'Deactivatable Clinic',
      admin_name: 'Deactivate Admin',
      email: 'deact.admin@test.com',
      password: 'Password123!',
      phone: '+91 99222 33344',
    });
    assert.equal(regRes.status, 201);
    const { token, clinic } = await regRes.json();

    // Verify access while active
    const activeCheck = await fetch(`${baseUrl}/api/clinic`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(activeCheck.status, 200);

    // Deactivate clinic directly in store
    await serverStore.saveClinic({ active: false }, { clinic: clinic._id });

    // Verify all private dashboard endpoints reject with HTTP 403
    const protectedRoutes = [
      { path: '/api/clinic', method: 'GET' },
      { path: '/api/appointments', method: 'GET' },
      { path: '/api/stats', method: 'GET' },
      { path: '/api/doctors', method: 'GET' },
      { path: '/api/calls', method: 'GET' },
      { path: '/api/leads', method: 'GET' },
    ];

    for (const r of protectedRoutes) {
      const res = await fetch(`${baseUrl}${r.path}`, {
        method: r.method,
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(res.status, 403, `${r.method} ${r.path} must return 403 for inactive clinic`);
      const body = await res.json();
      assert.match(body.error, /clinic is inactive/i);
    }
  });

  // --------------------------------------------------------------------------
  // 11. UNASSIGNED CLINIC TOKEN REJECTION
  // --------------------------------------------------------------------------
  test('requireClinic rejects unassigned clinic token (clinic: null) with HTTP 403', async () => {
    const unassignedToken = jwt.sign(
      { sub: 'unassigned-user-1', email: 'no.clinic@test.com', role: 'clinic_owner', clinic: null },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );

    const res = await fetch(`${baseUrl}/api/clinic`, {
      headers: { Authorization: `Bearer ${unassignedToken}` },
    });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.match(body.error, /clinic not assigned/i);
  });

  // --------------------------------------------------------------------------
  // 12. PRODUCTION ONBOARDING SAFEGUARD
  // --------------------------------------------------------------------------
  test('Production safeguard: NODE_ENV=production requires secret or invite code', async () => {
    const origNodeEnv = process.env.NODE_ENV;
    const origSecret = process.env.ONBOARDING_SECRET;
    const origInvite = process.env.CLINIC_INVITE_CODE;
    const origAllow = process.env.ALLOW_PUBLIC_REGISTRATION;

    try {
      process.env.NODE_ENV = 'production';
      process.env.ALLOW_PUBLIC_REGISTRATION = 'false';
      process.env.ONBOARDING_SECRET = 'guard-secret-xyz';
      process.env.CLINIC_INVITE_CODE = 'INVITE-2026-PROD';

      // 1. Without secret or invite: rejected 403
      const blockedRes = await postOnboarding('/api/auth/register-clinic', {
        clinic_name: 'Prod Guard Clinic 1',
        admin_name: 'Prod Admin',
        email: 'prod.admin1@test.com',
        password: 'Password123!',
        phone: '+91 99333 44455',
      });
      assert.equal(blockedRes.status, 403, 'Should be 403 in production without secret/invite');
      const blockedBody = await blockedRes.json();
      assert.match(blockedBody.error, /disabled in production/i);

      // 2. With valid x-onboarding-secret header: accepted 201
      const secretRes = await postOnboarding('/api/auth/register-clinic', {
        clinic_name: 'Prod Guard Clinic 2',
        admin_name: 'Prod Admin',
        email: 'prod.admin2@test.com',
        password: 'Password123!',
        phone: '+91 99333 44466',
      }, { 'x-onboarding-secret': 'guard-secret-xyz' });
      assert.equal(secretRes.status, 201, 'Should succeed with valid onboarding secret');

      // 3. With valid invite_code in body: accepted 201
      const inviteRes = await postOnboarding('/api/auth/register-clinic', {
        clinic_name: 'Prod Guard Clinic 3',
        admin_name: 'Prod Admin',
        email: 'prod.admin3@test.com',
        password: 'Password123!',
        phone: '+91 99333 44477',
        invite_code: 'INVITE-2026-PROD',
      });
      assert.equal(inviteRes.status, 201, 'Should succeed with valid invite code');

      // 4. With platform admin bearer token: accepted 201
      const adminToken = jwt.sign(
        { sub: 'platform-admin-1', email: 'root@medibot.local', role: 'platform_admin', clinic: null },
        process.env.JWT_SECRET,
        { expiresIn: '1h' }
      );
      const adminAuthRes = await postOnboarding('/api/auth/register-clinic', {
        clinic_name: 'Prod Guard Clinic 4',
        admin_name: 'Prod Admin',
        email: 'prod.admin4@test.com',
        password: 'Password123!',
        phone: '+91 99333 44488',
      }, { Authorization: `Bearer ${adminToken}` });
      assert.equal(adminAuthRes.status, 201, 'Should succeed with platform admin token');
    } finally {
      process.env.NODE_ENV = origNodeEnv;
      if (origSecret) process.env.ONBOARDING_SECRET = origSecret; else delete process.env.ONBOARDING_SECRET;
      if (origInvite) process.env.CLINIC_INVITE_CODE = origInvite; else delete process.env.CLINIC_INVITE_CODE;
      if (origAllow) process.env.ALLOW_PUBLIC_REGISTRATION = origAllow; else delete process.env.ALLOW_PUBLIC_REGISTRATION;
    }
  });
});

// ============================================================================
// 13. MONGODB INTEGRATION (when TEST_MONGODB_URI is provided)
// ============================================================================
const mongodbUri = process.env.TEST_MONGODB_URI;
if (mongodbUri && mongodbUri.trim() !== '') {
  const { createMongoStore, Clinic, User } = require('./store-mongo');
  const mongoose = require('mongoose');
  const crypto = require('crypto');

  describe('MongoDB Clinic Onboarding Suite', () => {
    let mongoStore;

    before(async () => {
      const dbUri = mongodbUri.includes('?')
        ? mongodbUri.replace(/([^/?]+)(\?)/, '$1_onboarding$2')
        : (mongodbUri.endsWith('/') ? `${mongodbUri}medibot_test_onboarding` : `${mongodbUri}_onboarding`);
      await mongoose.connect(dbUri, { serverSelectionTimeoutMS: 5000 });
      mongoStore = createMongoStore();
      await Clinic.deleteMany({});
      await User.deleteMany({});
    });

    after(async () => {
      await mongoose.disconnect();
    });

    test('MongoDB: createClinic, createUser, and getClinic behave identically to memory store', async () => {
      const clinicId = new mongoose.Types.ObjectId().toString();
      const clinic = await mongoStore.saveClinic({
        name: 'Apollo Hospital Indiranagar',
        phone: '+919876543210',
        active: true,
      }, { clinic: clinicId, create: true });

      assert.equal(String(clinic._id), clinicId);
      assert.equal(clinic.name, 'Apollo Hospital Indiranagar');

      const user = await mongoStore.createUser({
        email: 'apollo.owner@test.com',
        password_hash: '$2a$10$abcdefghijklmnopqrstuvwxyz0123456789',
        name: 'Dr. Apollo Owner',
        role: 'clinic_owner',
        clinic: clinicId,
        active: true,
      });

      assert.equal(user.email, 'apollo.owner@test.com');
      assert.equal(String(user.clinic), clinicId);
      assert.equal(user.role, 'clinic_owner');

      const fetched = await mongoStore.getClinic(clinicId);
      assert.equal(String(fetched._id), clinicId);
      assert.equal(fetched.name, 'Apollo Hospital Indiranagar');
    });

    test('MongoDB: resolveClinicByPhone accurately resolves registered clinic', async () => {
      const res = await mongoStore.resolveClinicByPhone('098765 43210');
      assert.equal(res.ok, true);
      assert.equal(res.clinic.name, 'Apollo Hospital Indiranagar');
    });

    test('MongoDB: deleteClinic successfully deletes clinic during atomic rollback with no orphan', async () => {
      const orphanClinicId = new mongoose.Types.ObjectId().toString();
      await mongoStore.saveClinic({
        name: 'Temporary Orphan Clinic',
        phone: '+919999900000',
        active: true,
      }, { clinic: orphanClinicId, create: true });

      const beforeDelete = await mongoStore.getClinic(orphanClinicId);
      assert.ok(beforeDelete, 'Clinic should exist before rollback');

      const deleted = await mongoStore.deleteClinic(orphanClinicId);
      assert.equal(deleted, true);

      const afterDelete = await mongoStore.getClinic(orphanClinicId);
      assert.equal(afterDelete, null, 'Clinic must not exist after deleteClinic');
    });
  });
} else {
  describe('MongoDB Clinic Onboarding Suite (skipped - no TEST_MONGODB_URI)', () => {
    test.skip('skipped gracefully when TEST_MONGODB_URI is not set', () => {});
  });
}
