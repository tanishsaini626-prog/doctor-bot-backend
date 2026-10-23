'use strict';
/* ==========================================================================
 * Tests for the manual appointment API endpoints:
 *   POST   /api/appointments      (create)
 *   GET    /api/appointments/check-duplicate   (pre-check)
 *   DELETE /api/appointments/:id  (delete)
 *   GET    /api/appointments      (list)
 *   PATCH  /api/appointments/:id  (status update)
 *
 * Boots the real Express app on an ephemeral port with the in-memory store
 * (STORE=memory) and drives it with real HTTP requests via fetch().
 *
 *   node --test
 * ========================================================================== */

const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

// Force the in-memory store BEFORE requiring server.js so no MongoDB is needed.
process.env.STORE = 'memory';
process.env.PORT = '0';
// TEST_JWT_SECRET is required for the test suite. Never hardcode a production secret here.
// Tests fail clearly if it is missing.
const testSecret = process.env.TEST_JWT_SECRET || process.env.JWT_SECRET;
if (!testSecret) {
  throw new Error(
    'FATAL: TEST_JWT_SECRET is not set. Set a dedicated test-only JWT secret in your ' +
    'environment (e.g. TEST_JWT_SECRET=test-only-do-not-use-in-production) and re-run. ' +
    'Never commit a production JWT_SECRET to source control.'
  );
}
// Reject the leaked production secret if it is still present in the environment.
if (String(testSecret).includes('ifkHCeRjCLRTatBZX9K5v0MS34gPvW4')) {
  throw new Error(
    'FATAL: TEST_JWT_SECRET appears to be the leaked production JWT_SECRET. ' +
    'Set a dedicated test-only secret instead.'
  );
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
  // Retry on 503 (store still initializing via requireStoreReady) so tests are
  // robust against async store readiness.
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

// Generate a JWT token directly instead of relying on the /api/auth/login endpoint.
// Mirrors auth.js signToken() exactly so requireAuth() accepts the token.
test.before(async () => {
  // Give ensureSeedAdmin() a moment to finish creating the admin account
  await sleep(500);
  const jti = crypto.randomBytes(16).toString('hex');
  const testUser = {
    _id: 'test-admin-1',
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

// ------------------------------------------------------------ POST /api/auth/login

test('POST /api/auth/login with valid seeded admin returns token + user (200)', async () => {
  const r = await request('POST', '/api/auth/login', {
    email: process.env.ADMIN_EMAIL || 'admin@medibot.local',
    password: process.env.ADMIN_PASSWORD || 'TestAdmin123!',
  }, false);
  assert.equal(r.status, 200);
  assert.ok(r.json.token, 'login should return a token');
  assert.ok(r.json.user, 'login should return a user');
  assert.equal(r.json.user.email, (process.env.ADMIN_EMAIL || 'admin@medibot.local').toLowerCase());
  assert.equal(r.json.user.role, 'admin');
});

test('POST /api/auth/login with invalid password is rejected (401)', async () => {
  const r = await request('POST', '/api/auth/login', {
    email: process.env.ADMIN_EMAIL || 'admin@medibot.local',
    password: 'WrongPassword123!',
  }, false);
  assert.equal(r.status, 401);
  const json = await r.json ? r.json : null;
  assert.equal(r.status, 401);
  assert.equal(json.error, 'Invalid email or password');
});

test('POST /api/auth/login for unknown account is rejected without leaking existence (401)', async () => {
  const r = await request('POST', '/api/auth/login', {
    email: 'nonexistent-user-' + Date.now() + '@medibot.local',
    password: process.env.ADMIN_PASSWORD || 'TestAdmin123!',
  }, false);
  assert.equal(r.status, 401);
  const json = await r.json ? r.json : null;
  assert.equal(json.error, 'Invalid email or password');
});

test('POST /api/auth/login issued token authenticates a protected appointment endpoint (200)', async () => {
  const r = await request('POST', '/api/auth/login', {
    email: process.env.ADMIN_EMAIL || 'admin@medibot.local',
    password: process.env.ADMIN_PASSWORD || 'TestAdmin123!',
  }, false);
  assert.equal(r.status, 200);
  assert.ok(r.json.token, 'login should return a token');

  // Use the login-issued token explicitly against a protected endpoint.
  const url = await ensureServer();
  const res = await fetch(url + '/api/appointments', {
    headers: { Authorization: 'Bearer ' + r.json.token },
  });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.ok(Array.isArray(json), 'appointments list should be an array');
});

// ------------------------------------------------------------------ POST /api/appointments

test('POST /api/appointments creates a new appointment (201)', async () => {
  const r = await request('POST', '/api/appointments', {
    name: 'Ramesh Kumar',
    phone: '+91 98765 43210',
    date: '25/06/2026',
    time_slot: 'Morning 10:00',
    reason: 'Fever',
    booking_for: 'Self',
  });
  assert.equal(r.status, 201);
  assert.equal(r.json.name, 'Ramesh Kumar');
  assert.equal(r.json.phone, '+91 98765 43210');
  assert.equal(r.json.date, '25/06/2026');
  assert.equal(r.json.time_slot, 'Morning 10:00');
  assert.equal(r.json.reason, 'Fever');
  assert.equal(r.json.status, 'Confirmed');
  assert.ok(r.json._id);
});

test('POST /api/appointments rejects missing required fields (400)', async () => {
  const r = await request('POST', '/api/appointments', {
    phone: '+91 98765 43210',
    date: '25/06/2026',
    time_slot: 'Morning 10:00',
  });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /name/i);
});

test('POST /api/appointments rejects duplicate phone+date+slot (409)', async () => {
  const r = await request('POST', '/api/appointments', {
    name: 'Ramesh Kumar',
    phone: '+91 98765 43210',
    date: '25/06/2026',
    time_slot: 'Morning 10:00',
    reason: 'Fever',
  });
  assert.equal(r.status, 409);
  assert.match(r.json.error, /already exists/i);
});

// ------------------------------------------------------- GET /api/appointments/check-duplicate

test('GET /api/appointments/check-duplicate returns duplicate: true when clash exists', async () => {
  const url = await ensureServer();
  const res = await fetch(url + '/api/appointments/check-duplicate?phone=%2B91%2098765%2043210&date=25%2F06%2F2026&time_slot=Morning%2010%3A00', {
    headers: { 'Authorization': 'Bearer ' + token },
  });
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(json.duplicate, true);
  assert.ok(json.appointment);
});

test('GET /api/appointments/check-duplicate returns duplicate: false when no clash', async () => {
  const url = await ensureServer();
  const res = await fetch(url + '/api/appointments/check-duplicate?phone=%2B91%2098765%2043210&date=26%2F06%2F2026&time_slot=Morning%2010%3A00', {
    headers: { 'Authorization': 'Bearer ' + token },
  });
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(json.duplicate, false);
  assert.equal(json.appointment, null);
});

test('GET /api/appointments/check-duplicate rejects missing params (400)', async () => {
  const url = await ensureServer();
  const res = await fetch(url + '/api/appointments/check-duplicate?phone=%2B91%2098765%2043210', {
    headers: { 'Authorization': 'Bearer ' + token },
  });
  assert.equal(res.status, 400);
});

// ----------------------------------------------------------------- DELETE /api/appointments/:id

test('DELETE /api/appointments/:id removes an existing appointment (200)', async () => {
  const create = await request('POST', '/api/appointments', {
    name: 'To Be Deleted',
    phone: '+91 11111 22222',
    date: '27/06/2026',
    time_slot: 'Afternoon 14:00',
    reason: 'Checkup',
  });
  assert.equal(create.status, 201);
  const id = create.json._id;

  const r = await request('DELETE', '/api/appointments/' + id);
  assert.equal(r.status, 200);
  assert.equal(r.json.deleted, true);
});

test('DELETE /api/appointments/:id returns 404 for unknown id', async () => {
  const r = await request('DELETE', '/api/appointments/nonexistent-id-12345');
  assert.equal(r.status, 404);
});

// ------------------------------------------------------------- GET /api/appointments (list)

test('GET /api/appointments lists appointments', async () => {
  const r = await request('GET', '/api/appointments');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.json));
  assert.ok(r.json.length >= 1);
});

// ------------------------------------------------------------- PATCH /api/appointments/:id

test('PATCH /api/appointments/:id updates status', async () => {
  const create = await request('POST', '/api/appointments', {
    name: 'Status Test',
    phone: '+91 33333 44444',
    date: '28/06/2026',
    time_slot: 'Evening 17:00',
    reason: 'Follow-up',
  });
  assert.equal(create.status, 201);
  const id = create.json._id;

  const r = await request('PATCH', '/api/appointments/' + id, { status: 'Completed' });
  assert.equal(r.status, 200);
  assert.equal(r.json.status, 'Completed');
});

test('PATCH /api/appointments/:id rejects invalid status (400)', async () => {
  const create = await request('POST', '/api/appointments', {
    name: 'Bad Status',
    phone: '+91 55555 66666',
    date: '29/06/2026',
    time_slot: 'Morning 09:00',
    reason: 'Test',
  });
  assert.equal(create.status, 201);
  const id = create.json._id;

  const r = await request('PATCH', '/api/appointments/' + id, { status: 'InvalidStatus' });
  assert.equal(r.status, 400);
});

// --------------------------------------------------------------- unauthenticated access rejected

test('POST /api/appointments without token returns 401', async () => {
  const r = await request('POST', '/api/appointments', {
    name: 'No Auth',
    phone: '+91 99999 99999',
    date: '30/06/2026',
    time_slot: 'Morning 09:00',
  }, false);
  assert.equal(r.status, 401);
});