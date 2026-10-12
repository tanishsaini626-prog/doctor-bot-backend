'use strict';
/* ==========================================================================
 * Phase D tests for the public demo-request endpoint POST /api/leads.
 * Boots the real Express app on an ephemeral port with the in-memory store
 * (STORE=memory) and drives it with real HTTP requests via fetch().
 *
 *   node --test
 * ========================================================================== */

const test = require('node:test');
const assert = require('node:assert/strict');

// Force the in-memory store BEFORE requiring server.js so no MongoDB is needed.
process.env.STORE = 'memory';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-not-used-in-prod';
process.env.TWILIO_VALIDATE_SIGNATURE = 'false';

const app = require('./server');

// CommonJS has no top-level await, so start the server inside a helper that the
// first async test awaits. Node's test runner runs tests in order, and the
// ensureServer() call is idempotent.
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

// Reset the in-process rate limiter before every case so the shared 127.0.0.1
// IP does not leak request counts between tests.
test.beforeEach(() => { if (app.locals.__resetLeadLimiter) app.locals.__resetLeadLimiter(); });

const validLead = () => ({
  name: 'Asha Verma',
  clinic: 'Verma Dental',
  phone: '+91 98765 43210',
  email: 'asha@vermadental.in',
  message: 'We get 40 calls a day and miss half of them.',
  consent: true,
  source: 'landing',
});

async function post(body) {
  const url = await ensureServer();
  const res = await fetch(url + '/api/leads', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, json };
}

// ------------------------------------------------------------------ happy path
test('a valid demo request is accepted and stored', async () => {
  const r = await post(validLead());
  assert.equal(r.status, 201);
  assert.equal(r.json.ok, true);
  assert.ok(r.json.id, 'returns the new lead id');
  assert.equal(typeof r.json.id, 'string');
});

test('the public response never leaks internal fields', async () => {
  const r = await post(validLead());
  assert.equal(r.status, 201);
  assert.equal(r.json.ip, undefined);
  assert.equal(r.json.user_agent, undefined);
  assert.equal(r.json.status, undefined);
});

// ------------------------------------------------------------------ validation
test('a missing name is rejected', async () => {
  const b = validLead(); delete b.name;
  const r = await post(b);
  assert.equal(r.status, 400);
  assert.match(r.json.error, /name/i);
});

test('an invalid email is rejected', async () => {
  const b = validLead(); b.email = 'not-an-email';
  const r = await post(b);
  assert.equal(r.status, 400);
  assert.match(r.json.error, /email/i);
});

test('an invalid phone is rejected', async () => {
  const b = validLead(); b.phone = '123';
  const r = await post(b);
  assert.equal(r.status, 400);
  assert.match(r.json.error, /phone/i);
});

test('missing consent is rejected', async () => {
  const b = validLead(); b.consent = false;
  const r = await post(b);
  assert.equal(r.status, 400);
  assert.match(r.json.error, /contact/i);
});

test('an over-long message is rejected', async () => {
  const b = validLead(); b.message = 'x'.repeat(2001);
  const r = await post(b);
  assert.equal(r.status, 400);
  assert.match(r.json.error, /long/i);
});

// -------------------------------------------------------------------- honeypot
test('a filled honeypot is silently dropped, not stored', async () => {
  const b = validLead(); b.company_website = 'http://spam.example';
  const r = await post(b);
  // 201 so the bot thinks it worked, but nothing is actually stored.
  assert.equal(r.status, 201);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.id, undefined);   // no id -> nothing stored
});

// ----------------------------------------------------------------- rate limit
test('too many requests from one IP are rate-limited (429)', async () => {
  // LEAD_MAX_PER_IP is 5 per 10 minutes. Fire several valid requests and expect
  // the limiter to eventually answer 429.
  let saw429 = false;
  for (let i = 0; i < 8; i++) {
    const r = await post(validLead());
    if (r.status === 429) { saw429 = true; break; }
  }
  assert.equal(saw429, true, 'expected a 429 after several requests');
});
