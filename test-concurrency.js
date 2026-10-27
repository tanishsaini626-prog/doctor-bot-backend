'use strict';
/* ==========================================================================
 * Concurrency tests for booking integrity.
 *
 * Verifies that simultaneous booking requests for the same doctor/date/time
 * slot do not result in double-booking or slot-cap overflow.
 *
 * Uses the in-memory store (STORE=memory) with real HTTP requests via fetch().
 * The memory store uses a process-local async mutex to serialize
 * check-then-create, which is sufficient for a single-instance deployment.
 *
 *   TEST_JWT_SECRET=test-only node --test test-concurrency.js
 * ========================================================================== */

const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

process.env.STORE = 'memory';
process.env.PORT = '0';
process.env.MAX_PER_SLOT = '1';

const testSecret = process.env.TEST_JWT_SECRET || process.env.JWT_SECRET;
if (!testSecret) {
  throw new Error('FATAL: TEST_JWT_SECRET is not set.');
}
if (String(testSecret).includes('ifkHCeRjCLRTatBZX9K5v0MS34gPvW4')) {
  throw new Error('FATAL: TEST_JWT_SECRET appears to be the leaked production JWT_SECRET.');
}
process.env.JWT_SECRET = testSecret;
process.env.TWILIO_VALIDATE_SIGNATURE = 'false';
process.env.ADMIN_EMAIL = 'admin@medibot.local';
process.env.ADMIN_PASSWORD = 'TestAdmin123!';

const app = require('./server');

let base;
let server;
let starting = null;

function ensureServer() {
  if (base) return Promise.resolve(base);
  if (starting) return starting;
  starting = new Promise((resolve) => {
    server = app.listen(0);
    server.once('listening', () => {
      base = 'http://127.0.0.1:' + server.address().port;
      resolve(base);
    });
  });
  return starting;
}

test.after(() => { if (server) server.close(); });

let token = null;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function request(method, path, body, auth = true) {
  const url = await ensureServer();
  const headers = { 'content-type': 'application/json' };
  if (auth && token) {
    headers.Authorization = 'Bearer ' + token;
  }
  let res;
  for (let attempt = 0; attempt < 30; attempt++) {
    res = await fetch(url + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    if (res.status !== 503) break;
    await new Promise(r => setTimeout(r, 200));
  }
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, json };
}

test.before(async () => {
  await sleep(500);
  const jti = crypto.randomBytes(16).toString('hex');
  const testUser = {
    _id: 'test-admin-concurrency',
    email: (process.env.ADMIN_EMAIL || 'admin@medibot.local').toLowerCase(),
    role: 'admin',
    clinic: null,
  };
  token = jwt.sign(
    { sub: String(testUser._id), email: testUser.email, role: testUser.role, clinic: testUser.clinic, jti },
    process.env.JWT_SECRET,
    { expiresIn: '12h' }
  );
  assert.ok(token, 'token should be generated');
});

// ------------------------------------------------------------- concurrent duplicate booking

test('concurrent duplicate booking: only one of two simultaneous requests succeeds', async () => {
  const appt = {
    name: 'Concurrent Patient',
    phone: '+91 90000 11111',
    date: '15/01/2027',
    time_slot: 'Morning 10:00',
    reason: 'Concurrency test',
  };

  // Fire two identical requests at the same time.
  const results = await Promise.all([
    request('POST', '/api/appointments', appt),
    request('POST', '/api/appointments', appt),
  ]);

  // Exactly one should succeed (201), the other should be rejected (409 duplicate).
  const statuses = results.map(r => r.status);
  assert.ok(statuses.includes(201), 'one request should succeed with 201: ' + JSON.stringify(statuses));
  assert.ok(statuses.includes(409), 'one request should be rejected with 409: ' + JSON.stringify(statuses));

  // The 201 response should include an appointment id.
  const created = results.find(r => r.status === 201);
  assert.ok(created.json && created.json._id, 'successful response should include appointment id');

  // Verify the store only has one Confirmed appointment for this phone/date/slot.
  const dupes = await request('GET', '/api/appointments/check-duplicate?phone=%2B91%2090000%2011111&date=15%2F01%2F2027&time_slot=Morning%2010%3A00');
  assert.equal(dupes.status, 200);
  assert.equal(dupes.json.duplicate, true);
});

// ------------------------------------------------------------- concurrent slot-cap overflow

test('concurrent slot-cap overflow: only MAX_PER_SLOT bookings succeed', async () => {
  const slot = { date: '16/01/2027', time_slot: 'Afternoon 14:00' };

  // MAX_PER_SLOT = 1, so only one booking should succeed.
  const results = await Promise.all([
    request('POST', '/api/appointments', {
      name: 'Slot Cap Patient 1', phone: '+91 90000 22222', ...slot, reason: 'Cap test 1',
    }),
    request('POST', '/api/appointments', {
      name: 'Slot Cap Patient 2', phone: '+91 90000 33333', ...slot, reason: 'Cap test 2',
    }),
  ]);

  const statuses = results.map(r => r.status);
  assert.ok(statuses.includes(201), 'one request should succeed with 201: ' + JSON.stringify(statuses));
  assert.ok(statuses.includes(409), 'one request should be rejected with 409 slot_full: ' + JSON.stringify(statuses));

  // The rejected one should mention slot full.
  const rejected = results.find(r => r.status === 409);
  assert.ok(rejected.json.error.toLowerCase().includes('full'), 'rejection should mention slot full: ' + rejected.json.error);
});

// ------------------------------------------------------------- sequential booking still works after concurrency

test('subsequent booking for a different slot still works after concurrent contention', async () => {
  const r = await request('POST', '/api/appointments', {
    name: 'After Concurrency', phone: '+91 90000 44444',
    date: '18/01/2027', time_slot: 'Evening 17:00', reason: 'After contention',
  });
  assert.equal(r.status, 201, 'subsequent booking should succeed: ' + JSON.stringify(r.json));
  assert.ok(r.json && r.json._id);
});
