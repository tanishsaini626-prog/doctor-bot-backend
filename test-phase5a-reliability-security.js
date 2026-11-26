'use strict';
/**
 * test-phase5a-reliability-security.js
 *
 * Acceptance test suite for MediBot Phase 5A — Reliability and Security.
 * Verifies:
 * 1. Bounded browser receptionist session management (LRU eviction at maxSessions).
 * 2. Safe local voice warm-up endpoint (POST /api/receptionist/warmup).
 * 3. Clinic ownership verification on session inspection (GET /api/receptionist/sessions/:id).
 * 4. Browser receptionist session & audio rate limiting (HTTP 429).
 * 5. Atomic doctor reactivation quota enforcement (PATCH /api/doctors/:id) under concurrent
 *    requests on both Memory store and real MongoDB.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

const { createMemoryStore } = require('./store-memory');
const { createBrowserReceptionist } = require('./browser-receptionist');
const { createMongoStore, ensureIndexes } = require('./store-mongo');
const { Clinic, Doctor } = require('./models');

const TEST_JWT_SECRET = 'medibot-phase5a-reliability-security-secret-32chars';
const TEST_DB_URI = process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017/medibot_test_phase5a';

describe('MediBot Phase 5A — Reliability & Security Acceptance Suite', () => {
  let app;
  let server;
  let baseUrl;
  let store;

  const CLINIC_A = 'clinic_p5a_alpha';
  const CLINIC_B = 'clinic_p5a_beta';
  let tokenA;
  let tokenB;

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

    await store.saveClinic({ name: 'Phase5A Clinic A', phone: '+919876550001' }, { clinic: CLINIC_A, create: true });
    await store.saveClinic({ name: 'Phase5A Clinic B', phone: '+919876550002' }, { clinic: CLINIC_B, create: true });

    tokenA = jwt.sign(
      { sub: 'u_p5a_a', email: 'a@p5a.test', role: 'clinic_owner', clinic: CLINIC_A },
      TEST_JWT_SECRET
    );
    tokenB = jwt.sign(
      { sub: 'u_p5a_b', email: 'b@p5a.test', role: 'clinic_owner', clinic: CLINIC_B },
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
      await new Promise(resolve => server.close(resolve));
    }
  });

  test('1. Bounded browser receptionist session management evicts oldest sessions at cap', async () => {
    const memStore = createMemoryStore();
    await memStore.saveClinic({ name: 'Bounded Clinic', phone: '+919876550099' }, { clinic: 'c_bound', create: true });

    const rec = createBrowserReceptionist({ store: memStore, maxSessions: 3 });
    const s1 = await rec.startSession({ clinicId: 'c_bound', language: 'en' });
    await new Promise(r => setTimeout(r, 5));
    const s2 = await rec.startSession({ clinicId: 'c_bound', language: 'en' });
    await new Promise(r => setTimeout(r, 5));
    const s3 = await rec.startSession({ clinicId: 'c_bound', language: 'en' });
    assert.equal(rec.getActiveSessionCount(), 3);

    await new Promise(r => setTimeout(r, 5));
    const s4 = await rec.startSession({ clinicId: 'c_bound', language: 'en' });
    assert.equal(rec.getActiveSessionCount(), 3, 'Active sessions must never exceed maxSessions cap');
    assert.equal(rec.getSessionState({ sessionId: s1.session_id, clinicId: 'c_bound' }), null, 'Oldest session must be evicted');
    assert.ok(rec.getSessionState({ sessionId: s4.session_id, clinicId: 'c_bound' }), 'Newest session must be retained');
  });

  test('2. Safe local voice warmup endpoint responds cleanly (200) with JWT auth and rejects unauthenticated (401)', async () => {
    const unauth = await fetch(`${baseUrl}/api/receptionist/warmup`, { method: 'POST' });
    assert.equal(unauth.status, 401);

    const res = await fetch(`${baseUrl}/api/receptionist/warmup`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(typeof data.available, 'boolean');
  });

  test('3. Clinic ownership verified on GET /api/receptionist/sessions/:id (cross-tenant returns 404)', async () => {
    app.locals.__resetReceptionistLimiters();
    const startRes = await fetch(`${baseUrl}/api/receptionist/sessions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ language: 'en', speak: false }),
    });
    assert.equal(startRes.status, 201);
    const { session_id: sid } = await startRes.json();

    // Clinic A can inspect its own session (200)
    const ownRes = await fetch(`${baseUrl}/api/receptionist/sessions/${sid}`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    assert.equal(ownRes.status, 200);
    const ownData = await ownRes.json();
    assert.equal(ownData.session_id, sid);
    assert.ok(Array.isArray(ownData.transcript));

    // Clinic B attempting to inspect Clinic A's session gets 404
    const crossRes = await fetch(`${baseUrl}/api/receptionist/sessions/${sid}`, {
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    assert.equal(crossRes.status, 404, 'Cross-clinic session inspection must return 404');

    // Unauthenticated gets 401
    const unauthRes = await fetch(`${baseUrl}/api/receptionist/sessions/${sid}`);
    assert.equal(unauthRes.status, 401);
  });

  test('4. Browser receptionist session & audio rate limiters enforce HTTP 429 on bursts', async () => {
    app.locals.__resetReceptionistLimiters();

    // 4a. Session creation limiter (15/min): send 18 requests from same IP
    const sessionStatuses = [];
    for (let i = 0; i < 18; i++) {
      const r = await fetch(`${baseUrl}/api/receptionist/sessions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tokenA}`,
          'Content-Type': 'application/json',
          'X-Forwarded-For': '10.55.0.10',
        },
        body: JSON.stringify({ language: 'en', speak: false }),
      });
      sessionStatuses.push(r.status);
    }
    assert.ok(sessionStatuses.includes(429), `Session burst must trigger HTTP 429 (got: ${sessionStatuses.join(',')})`);

    // 4b. Audio limiter (20/min): create 1 valid session from fresh IP, then send 23 audio requests
    const startRes = await fetch(`${baseUrl}/api/receptionist/sessions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokenA}`,
        'Content-Type': 'application/json',
        'X-Forwarded-For': '10.55.0.20',
      },
      body: JSON.stringify({ language: 'en', speak: false }),
    });
    const { session_id: sid } = await startRes.json();

    const audioStatuses = [];
    for (let i = 0; i < 23; i++) {
      const r = await fetch(`${baseUrl}/api/receptionist/sessions/${sid}/audio`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tokenA}`,
          'Content-Type': 'application/json',
          'X-Forwarded-For': '10.55.0.20',
        },
        body: JSON.stringify({}), // triggers 400 validation until 429 rate limit fires
      });
      audioStatuses.push(r.status);
    }
    assert.ok(audioStatuses.includes(429), `Audio burst must trigger HTTP 429 (got: ${audioStatuses.join(',')})`);
  });

  test('5. Atomic concurrent doctor reactivation (PATCH /api/doctors/:id) strictly enforces max_doctors=2', async () => {
    // Starter plan max_doctors = 2. Seed 1 active doctor + 2 inactive doctors for Clinic B.
    const dActive = await store.createDoctor({ name: 'Dr. Active 1', active: true }, { clinic: CLINIC_B });
    const dInact1 = await store.createDoctor({ name: 'Dr. Inactive 1', active: false }, { clinic: CLINIC_B });
    const dInact2 = await store.createDoctor({ name: 'Dr. Inactive 2', active: false }, { clinic: CLINIC_B });
    assert.ok(dActive._id && dInact1._id && dInact2._id);

    process.env.ENFORCE_SUBSCRIPTION_QUOTAS = 'true';
    try {
      // Simultaneously attempt to reactivate BOTH inactive doctors when only 1 slot remains (1 + 1 = 2 max)
      const [r1, r2] = await Promise.all([
        fetch(`${baseUrl}/api/doctors/${dInact1._id}`, {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${tokenB}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ active: true }),
        }),
        fetch(`${baseUrl}/api/doctors/${dInact2._id}`, {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${tokenB}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ active: true }),
        }),
      ]);

      const statuses = [r1.status, r2.status].sort();
      assert.deepEqual(statuses, [200, 409], `Exactly one reactivation must succeed (200) and one fail (409), got ${statuses}`);

      const allDocs = await store.listDoctors({ clinic: CLINIC_B });
      const activeCount = allDocs.filter(d => d.active !== false).length;
      assert.equal(activeCount, 2, 'Active doctors must never exceed max_doctors=2');
    } finally {
      delete process.env.ENFORCE_SUBSCRIPTION_QUOTAS;
    }
  });

  test('6. MongoDB updateDoctorIfWithinLimit enforces atomic max_doctors rollback under concurrent reactivation', async (t) => {
    try {
      await mongoose.connect(TEST_DB_URI, { serverSelectionTimeoutMS: 3000 });
    } catch (_) {
      return t.skip('Local MongoDB not reachable');
    }
    try {
      await ensureIndexes();
      await Promise.all([Clinic.deleteMany({}), Doctor.deleteMany({})]);
      const mongoStore = createMongoStore();

      const clinic = await Clinic.create({ name: 'Mongo 5A Clinic', phone: '+919876550111' });
      await mongoStore.createDoctor({ name: 'Dr. M1', active: true }, { clinic: clinic._id });
      const mInact1 = await mongoStore.createDoctor({ name: 'Dr. M2', active: false }, { clinic: clinic._id });
      const mInact2 = await mongoStore.createDoctor({ name: 'Dr. M3', active: false }, { clinic: clinic._id });

      const [res1, res2] = await Promise.all([
        mongoStore.updateDoctorIfWithinLimit(mInact1._id, { active: true }, { clinic: clinic._id, maxDoctors: 2, enforce: true }),
        mongoStore.updateDoctorIfWithinLimit(mInact2._id, { active: true }, { clinic: clinic._id, maxDoctors: 2, enforce: true }),
      ]);

      const okCount = [res1, res2].filter(r => r.ok).length;
      const quotaCount = [res1, res2].filter(r => !r.ok && r.reason === 'quota_exceeded').length;
      assert.equal(okCount, 1, 'Exactly one MongoDB reactivation must succeed');
      assert.equal(quotaCount, 1, 'Exactly one MongoDB reactivation must be rejected with quota_exceeded');

      const dbActive = await Doctor.countDocuments({ clinic: clinic._id, active: { $ne: false } });
      assert.equal(dbActive, 2, 'MongoDB active doctor count must equal exactly 2');
    } finally {
      await mongoose.disconnect();
    }
  });
});
