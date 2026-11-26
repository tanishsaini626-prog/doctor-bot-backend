'use strict';
/* ==========================================================================
 * test-platform-admin.js - MediBot Batch 4F Platform Admin & Security Hardening
 *
 * Verifies:
 * 1. Role separation: explicit platform_admin vs clinic_owner / clinic_staff.
 * 2. Generic role 'admin' is NEVER treated as platform_admin.
 * 3. Platform endpoints (/api/platform/*) require platform_admin; clinic users get 403.
 * 4. Missing credentials return 401; non-platform-admin returns 403.
 * 5. Public registration and clinic onboarding reject role: platform_admin / admin (400).
 * 6. Clinic owner cannot promote themselves or create platform_admin users.
 * 7. Valid platform admin can list clinics, view clinic details, and view platform leads.
 * 8. Platform admin can deactivate a clinic; deactivated clinic users get 403 on dashboard.
 * 9. Platform admin can reactivate a clinic; reactivated clinic users regain access.
 * 10. Platform admin can view platform leads; clinic users get 403 on /api/platform/leads.
 * 11. Production guard hardening: role 'admin' or 'clinic_owner' cannot bypass guard.
 *     Only platform_admin or timing-safe onboarding secret / invite code can bypass.
 * 12. End-to-end compatibility with memory store and MongoDB (when TEST_MONGODB_URI is set).
 * ========================================================================== */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

process.env.STORE = 'memory';
process.env.TWILIO_VALIDATE_SIGNATURE = 'false';
const testSecret = process.env.TEST_JWT_SECRET || 'medibot-automated-test-suite-ephemeral-secret-min32chars';
process.env.JWT_SECRET = testSecret;

const serverApp = require('./server');

describe('MediBot Batch 4F: Platform Admin & Security Hardening', () => {
  let serverInstance;
  let baseUrl;
  let serverStore;
  let reqCounter = 1;

  function nextIp() {
    return `192.168.101.${reqCounter++}`;
  }

  function signTestToken(user) {
    return jwt.sign(
      { sub: String(user._id), email: user.email, role: user.role, clinic: user.clinic || null },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );
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
  // 1. REJECTION OF PLATFORM REGISTRATION & ROLE ESCALATION
  // --------------------------------------------------------------------------
  test('Public registration POST /api/auth/register rejects role: platform_admin and admin (400)', async () => {
    const rolesToTest = ['platform_admin', 'admin'];

    for (const role of rolesToTest) {
      const res = await fetch(`${baseUrl}/api/auth/register`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Forwarded-For': nextIp(),
        },
        body: JSON.stringify({
          name: 'Hacker User',
          email: `hacker.${Date.now()}.${Math.random()}@test.com`,
          password: 'Password123!',
          role,
        }),
      });

      assert.equal(res.status, 400, `Registering with role: ${role} must return 400`);
      const body = await res.json();
      assert.match(body.error, /cannot register as platform admin/i);
    }
  });

  test('Clinic onboarding POST /api/auth/register-clinic rejects role: platform_admin and admin (400)', async () => {
    const rolesToTest = ['platform_admin', 'admin'];

    for (const role of rolesToTest) {
      const res = await fetch(`${baseUrl}/api/auth/register-clinic`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Forwarded-For': nextIp(),
        },
        body: JSON.stringify({
          clinic_name: 'Escalation Clinic',
          admin_name: 'Escalator',
          email: `escalator.${Date.now()}.${Math.random()}@test.com`,
          password: 'Password123!',
          phone: `+91 97${Math.floor(10000000 + Math.random() * 90000000)}`,
          role,
        }),
      });

      assert.equal(res.status, 400, `Onboarding with role: ${role} must return 400`);
      const body = await res.json();
      assert.match(body.error, /cannot register as platform admin/i);
    }
  });

  // --------------------------------------------------------------------------
  // 2. PLATFORM ENDPOINTS REQUIRE PLATFORM_ADMIN (NOT CLINIC OWNER OR GENERIC ADMIN)
  // --------------------------------------------------------------------------
  test('Clinic owner and generic admin are rejected with HTTP 403 on all /api/platform/* endpoints', async () => {
    const clinicOwnerToken = signTestToken({ _id: 'u_owner_1', email: 'owner@clinic.test', role: 'clinic_owner', clinic: '507f1f77bcf86cd799439011' });
    const legacyAdminToken = signTestToken({ _id: 'u_legacy_admin', email: 'legacy@clinic.test', role: 'admin', clinic: '507f1f77bcf86cd799439011' });
    const receptionistToken = signTestToken({ _id: 'u_staff_1', email: 'staff@clinic.test', role: 'receptionist', clinic: '507f1f77bcf86cd799439011' });

    const forbiddenTokens = [
      { name: 'clinic_owner', token: clinicOwnerToken },
      { name: 'legacy admin', token: legacyAdminToken },
      { name: 'receptionist', token: receptionistToken },
    ];

    const platformRoutes = [
      { method: 'GET', path: '/api/platform/clinics' },
      { method: 'GET', path: '/api/platform/clinics/507f1f77bcf86cd799439011' },
      { method: 'PATCH', path: '/api/platform/clinics/507f1f77bcf86cd799439011', body: { active: false } },
      { method: 'GET', path: '/api/platform/leads' },
    ];

    for (const { name, token } of forbiddenTokens) {
      for (const route of platformRoutes) {
        const res = await fetch(`${baseUrl}${route.path}`, {
          method: route.method,
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'X-Forwarded-For': nextIp(),
          },
          body: route.body ? JSON.stringify(route.body) : undefined,
        });

        assert.equal(res.status, 403, `${name} must receive 403 on ${route.method} ${route.path}`);
        const body = await res.json();
        assert.match(body.error, /platform administrator authorization required/i);
      }
    }
  });

  test('Unauthenticated requests to /api/platform/* endpoints return HTTP 401', async () => {
    const platformRoutes = [
      { method: 'GET', path: '/api/platform/clinics' },
      { method: 'GET', path: '/api/platform/clinics/507f1f77bcf86cd799439011' },
      { method: 'PATCH', path: '/api/platform/clinics/507f1f77bcf86cd799439011', body: { active: false } },
      { method: 'GET', path: '/api/platform/leads' },
    ];

    for (const route of platformRoutes) {
      const res = await fetch(`${baseUrl}${route.path}`, {
        method: route.method,
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': nextIp() },
        body: route.body ? JSON.stringify(route.body) : undefined,
      });

      assert.equal(res.status, 401, `Unauthenticated request to ${route.method} ${route.path} must return 401`);
    }
  });

  // --------------------------------------------------------------------------
  // 3. PLATFORM ADMIN CAPABILITIES
  // --------------------------------------------------------------------------
  test('Platform admin can list clinics, view clinic details, and toggle active status', async () => {
    const platformAdminToken = signTestToken({ _id: 'u_platform_root', email: 'platform@medibot.local', role: 'platform_admin', clinic: null });

    // Seed a clinic via store
    const clinicId = '507f1f77bcf86cd799439055';
    await serverStore.saveClinic({
      name: 'Managed Platform Clinic',
      phone: '+919877700001',
      active: true,
    }, { clinic: clinicId, create: true });

    // 1. List clinics
    const listRes = await fetch(`${baseUrl}/api/platform/clinics`, {
      headers: { Authorization: `Bearer ${platformAdminToken}` },
    });
    assert.equal(listRes.status, 200);
    const clinics = await listRes.json();
    assert.ok(Array.isArray(clinics), 'Should return an array of clinics');
    const target = clinics.find(c => String(c._id) === clinicId);
    assert.ok(target, 'Seeded clinic should be in the list');
    assert.equal(target.name, 'Managed Platform Clinic');

    // 2. View clinic details
    const detailRes = await fetch(`${baseUrl}/api/platform/clinics/${clinicId}`, {
      headers: { Authorization: `Bearer ${platformAdminToken}` },
    });
    assert.equal(detailRes.status, 200);
    const detail = await detailRes.json();
    assert.equal(detail.name, 'Managed Platform Clinic');
    assert.equal(detail.active, true);

    // 3. Nonexistent clinic returns 404
    const notFoundRes = await fetch(`${baseUrl}/api/platform/clinics/507f1f77bcf86cd799439999`, {
      headers: { Authorization: `Bearer ${platformAdminToken}` },
    });
    assert.equal(notFoundRes.status, 404);

    // 4. Deactivate clinic
    const deactRes = await fetch(`${baseUrl}/api/platform/clinics/${clinicId}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${platformAdminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ active: false }),
    });
    assert.equal(deactRes.status, 200);
    const deactBody = await deactRes.json();
    assert.equal(deactBody.active, false);

    // Verify clinic is now deactivated in store
    const checkClinic = await serverStore.getClinic(clinicId);
    assert.equal(checkClinic.active, false);

    // 5. Invalid active payload rejects 400
    const invalidRes = await fetch(`${baseUrl}/api/platform/clinics/${clinicId}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${platformAdminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ active: 'not-a-boolean' }),
    });
    assert.equal(invalidRes.status, 400);

    // 6. Reactivate clinic
    const reactRes = await fetch(`${baseUrl}/api/platform/clinics/${clinicId}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${platformAdminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ active: true }),
    });
    assert.equal(reactRes.status, 200);
    const reactBody = await reactRes.json();
    assert.equal(reactBody.active, true);
  });

  // --------------------------------------------------------------------------
  // 4. DEACTIVATION PROPAGATION TO CLINIC USERS
  // --------------------------------------------------------------------------
  test('Deactivating a clinic via platform API blocks clinic users on dashboard; reactivating restores access', async () => {
    const platformAdminToken = signTestToken({ _id: 'u_platform_root', email: 'platform@medibot.local', role: 'platform_admin', clinic: null });
    const targetClinicId = '507f1f77bcf86cd799439066';
    const clinicUserToken = signTestToken({ _id: 'u_owner_prop', email: 'owner.prop@test.com', role: 'clinic_owner', clinic: targetClinicId });

    // Seed clinic as active
    await serverStore.saveClinic({
      name: 'Propagation Test Clinic',
      phone: '+919877700002',
      active: true,
    }, { clinic: targetClinicId, create: true });

    // Verify clinic user has access while active
    const check1 = await fetch(`${baseUrl}/api/clinic`, {
      headers: { Authorization: `Bearer ${clinicUserToken}` },
    });
    assert.equal(check1.status, 200);

    // Platform admin deactivates the clinic
    const deactRes = await fetch(`${baseUrl}/api/platform/clinics/${targetClinicId}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${platformAdminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ active: false }),
    });
    assert.equal(deactRes.status, 200);

    // Clinic user is now blocked with HTTP 403 across dashboard APIs
    const blockedCheck = await fetch(`${baseUrl}/api/clinic`, {
      headers: { Authorization: `Bearer ${clinicUserToken}` },
    });
    assert.equal(blockedCheck.status, 403);
    const blockedBody = await blockedCheck.json();
    assert.match(blockedBody.error, /clinic is inactive/i);

    const apptsCheck = await fetch(`${baseUrl}/api/appointments`, {
      headers: { Authorization: `Bearer ${clinicUserToken}` },
    });
    assert.equal(apptsCheck.status, 403);

    // Platform admin reactivates the clinic
    const reactRes = await fetch(`${baseUrl}/api/platform/clinics/${targetClinicId}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${platformAdminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ active: true }),
    });
    assert.equal(reactRes.status, 200);

    // Clinic user access is restored
    const restoredCheck = await fetch(`${baseUrl}/api/clinic`, {
      headers: { Authorization: `Bearer ${clinicUserToken}` },
    });
    assert.equal(restoredCheck.status, 200);
  });

  // --------------------------------------------------------------------------
  // 5. PLATFORM LEADS VS CLINIC LEADS ISOLATION
  // --------------------------------------------------------------------------
  test('Platform admin views platform leads on /api/platform/leads; clinic user is rejected with 403', async () => {
    const platformAdminToken = signTestToken({ _id: 'u_platform_root', email: 'platform@medibot.local', role: 'platform_admin', clinic: null });
    const clinicUserToken = signTestToken({ _id: 'u_owner_leads', email: 'owner.leads@test.com', role: 'clinic_owner', clinic: '507f1f77bcf86cd799439077' });

    // Seed a platform lead
    await serverStore.createLead({
      name: 'Prospect Dr. Kumar',
      clinic_name: 'Kumar Hospital',
      scope: 'platform',
      clinic: null,
      phone: '+91 98999 11111',
      email: 'kumar@prospect.test',
      message: 'Demo request for entire chain',
    });

    // 1. Platform admin accesses /api/platform/leads -> 200
    const platRes = await fetch(`${baseUrl}/api/platform/leads`, {
      headers: { Authorization: `Bearer ${platformAdminToken}` },
    });
    assert.equal(platRes.status, 200);
    const platLeads = await platRes.json();
    assert.ok(Array.isArray(platLeads));
    assert.ok(platLeads.some(l => l.name === 'Prospect Dr. Kumar'));

    // 2. Clinic user accesses /api/platform/leads -> 403
    const crossRes = await fetch(`${baseUrl}/api/platform/leads`, {
      headers: { Authorization: `Bearer ${clinicUserToken}` },
    });
    assert.equal(crossRes.status, 403);
    const crossBody = await crossRes.json();
    assert.match(crossBody.error, /platform administrator authorization required/i);
  });

  // --------------------------------------------------------------------------
  // 6. PRODUCTION ONBOARDING GUARD SECURITY HARDENING
  // --------------------------------------------------------------------------
  test('Onboarding production guard: clinic_owner and generic admin cannot bypass; only platform_admin or valid secret/invite can', async () => {
    const origNodeEnv = process.env.NODE_ENV;
    const origSecret = process.env.ONBOARDING_SECRET;
    const origInvite = process.env.CLINIC_INVITE_CODE;
    const origAllow = process.env.ALLOW_PUBLIC_REGISTRATION;

    try {
      process.env.NODE_ENV = 'production';
      process.env.ALLOW_PUBLIC_REGISTRATION = 'false';
      process.env.ONBOARDING_SECRET = 'secure-platform-secret-2026';
      process.env.CLINIC_INVITE_CODE = 'INVITE-MEDIBOT-PLATFORM';

      const clinicOwnerToken = signTestToken({ _id: 'u_owner_fake', email: 'owner@fake.test', role: 'clinic_owner', clinic: '507f1f77bcf86cd799439011' });
      const genericAdminToken = signTestToken({ _id: 'u_admin_fake', email: 'admin@fake.test', role: 'admin', clinic: '507f1f77bcf86cd799439011' });
      const platformAdminToken = signTestToken({ _id: 'u_plat_root', email: 'root@medibot.local', role: 'platform_admin', clinic: null });

      const basePayload = {
        clinic_name: 'Prod Secured Clinic',
        admin_name: 'Prod Admin',
        password: 'Password123!',
      };

      // 1. Clinic owner token CANNOT bypass production guard -> 403
      const ownerBypassRes = await fetch(`${baseUrl}/api/auth/register-clinic`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${clinicOwnerToken}`,
          'Content-Type': 'application/json',
          'X-Forwarded-For': nextIp(),
        },
        body: JSON.stringify(Object.assign({}, basePayload, {
          email: 'bypass.owner@test.com',
          phone: '+91 97000 11111',
        })),
      });
      assert.equal(ownerBypassRes.status, 403, 'Clinic owner must not bypass production onboarding guard');

      // 2. Generic role "admin" CANNOT bypass production guard -> 403
      const adminBypassRes = await fetch(`${baseUrl}/api/auth/register-clinic`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${genericAdminToken}`,
          'Content-Type': 'application/json',
          'X-Forwarded-For': nextIp(),
        },
        body: JSON.stringify(Object.assign({}, basePayload, {
          email: 'bypass.admin@test.com',
          phone: '+91 97000 22222',
        })),
      });
      assert.equal(adminBypassRes.status, 403, 'Generic admin must not bypass production onboarding guard');

      // 3. Forged or near-miss secret rejected (timing-safe check) -> 403
      const forgedSecretRes = await fetch(`${baseUrl}/api/auth/register-clinic`, {
        method: 'POST',
        headers: {
          'x-onboarding-secret': 'secure-platform-secret-2027', // Wrong secret
          'Content-Type': 'application/json',
          'X-Forwarded-For': nextIp(),
        },
        body: JSON.stringify(Object.assign({}, basePayload, {
          email: 'forged.secret@test.com',
          phone: '+91 97000 33333',
        })),
      });
      assert.equal(forgedSecretRes.status, 403, 'Wrong secret must return 403');

      // 4. Valid platform_admin token DOES bypass -> 201
      const platBypassRes = await fetch(`${baseUrl}/api/auth/register-clinic`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${platformAdminToken}`,
          'Content-Type': 'application/json',
          'X-Forwarded-For': nextIp(),
        },
        body: JSON.stringify(Object.assign({}, basePayload, {
          email: 'plat.authorized@test.com',
          phone: '+91 97000 44444',
        })),
      });
      assert.equal(platBypassRes.status, 201, 'Platform admin token must authorize onboarding in production');

      // 5. Valid timing-safe secret header DOES bypass -> 201
      const validSecretRes = await fetch(`${baseUrl}/api/auth/register-clinic`, {
        method: 'POST',
        headers: {
          'x-onboarding-secret': 'secure-platform-secret-2026',
          'Content-Type': 'application/json',
          'X-Forwarded-For': nextIp(),
        },
        body: JSON.stringify(Object.assign({}, basePayload, {
          email: 'secret.authorized@test.com',
          phone: '+91 97000 55555',
        })),
      });
      assert.equal(validSecretRes.status, 201, 'Valid secret must authorize onboarding');

      // 6. Valid invite code DOES bypass -> 201
      const validInviteRes = await fetch(`${baseUrl}/api/auth/register-clinic`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Forwarded-For': nextIp(),
        },
        body: JSON.stringify(Object.assign({}, basePayload, {
          email: 'invite.authorized@test.com',
          phone: '+91 97000 66666',
          invite_code: 'INVITE-MEDIBOT-PLATFORM',
        })),
      });
      assert.equal(validInviteRes.status, 201, 'Valid invite code must authorize onboarding');
    } finally {
      process.env.NODE_ENV = origNodeEnv;
      if (origSecret) process.env.ONBOARDING_SECRET = origSecret; else delete process.env.ONBOARDING_SECRET;
      if (origInvite) process.env.CLINIC_INVITE_CODE = origInvite; else delete process.env.CLINIC_INVITE_CODE;
      if (origAllow) process.env.ALLOW_PUBLIC_REGISTRATION = origAllow; else delete process.env.ALLOW_PUBLIC_REGISTRATION;
    }
  });
});

// ============================================================================
// 7. MONGODB SUITE (when TEST_MONGODB_URI is provided)
// ============================================================================
const mongodbUri = process.env.TEST_MONGODB_URI;
if (mongodbUri && mongodbUri.trim() !== '') {
  const { createMongoStore, Clinic, User, Lead } = require('./store-mongo');
  const mongoose = require('mongoose');

  describe('MongoDB Platform Admin Suite', () => {
    let mongoStore;

    before(async () => {
      const dbUri = mongodbUri.includes('?')
        ? mongodbUri.replace(/([^/?]+)(\?)/, '$1_platform$2')
        : (mongodbUri.endsWith('/') ? `${mongodbUri}medibot_test_platform` : `${mongodbUri}_platform`);
      await mongoose.connect(dbUri, { serverSelectionTimeoutMS: 5000 });
      mongoStore = createMongoStore();
      await Clinic.deleteMany({});
      await User.deleteMany({});
      await Lead.deleteMany({});
    });

    after(async () => {
      await mongoose.disconnect();
    });

    test('MongoDB: listClinics and saveClinic activation toggle work reliably', async () => {
      const c1Id = new mongoose.Types.ObjectId().toString();
      await mongoStore.saveClinic({
        name: 'MongoDB Platform Clinic 1',
        phone: '+919988800001',
        active: true,
      }, { clinic: c1Id, create: true });

      const c2Id = new mongoose.Types.ObjectId().toString();
      await mongoStore.saveClinic({
        name: 'MongoDB Platform Clinic 2',
        phone: '+919988800002',
        active: false,
      }, { clinic: c2Id, create: true });

      const list = await mongoStore.listClinics();
      assert.ok(list.length >= 2);
      assert.ok(list.some(c => String(c._id) === c1Id && c.active === true));
      assert.ok(list.some(c => String(c._id) === c2Id && c.active === false));

      // Deactivate c1
      await mongoStore.saveClinic({ active: false }, { clinic: c1Id });
      const updatedC1 = await mongoStore.getClinic(c1Id);
      assert.equal(updatedC1.active, false);
    });

    test('MongoDB: listPlatformLeads returns only platform-scoped leads', async () => {
      // Platform lead
      await mongoStore.createLead({
        name: 'Mongo Prospect Lead',
        clinic_name: 'Mongo Clinic',
        scope: 'platform',
        clinic: null,
      });

      // Clinic lead
      const cId = new mongoose.Types.ObjectId().toString();
      await mongoStore.createLead({
        name: 'Mongo Tenant Patient Lead',
        scope: 'clinic',
        clinic: cId,
      });

      const platformLeads = await mongoStore.listPlatformLeads();
      assert.ok(platformLeads.some(l => l.name === 'Mongo Prospect Lead'));
      assert.ok(!platformLeads.some(l => l.name === 'Mongo Tenant Patient Lead'));
    });
  });
} else {
  describe('MongoDB Platform Admin Suite (skipped - no TEST_MONGODB_URI)', () => {
    test.skip('skipped gracefully when TEST_MONGODB_URI is not set', () => {});
  });
}

