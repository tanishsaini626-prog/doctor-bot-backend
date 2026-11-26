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

// -------------------------------------------------------- Batch 1 clinic name & scope
test('a missing clinic name is rejected (HTTP 400)', async () => {
  const b = validLead(); delete b.clinic;
  const r = await post(b);
  assert.equal(r.status, 400);
  assert.match(r.json.error, /clinic name/i);
});

test('a too short clinic name (< 2 chars) is rejected (HTTP 400)', async () => {
  const b = validLead(); b.clinic = 'A';
  const r = await post(b);
  assert.equal(r.status, 400);
  assert.match(r.json.error, /clinic name/i);
});

test('an over-long clinic name (> 150 chars) is rejected (HTTP 400)', async () => {
  const b = validLead(); b.clinic = 'x'.repeat(151);
  const r = await post(b);
  assert.equal(r.status, 400);
  assert.match(r.json.error, /clinic name/i);
});

test('accepts clinic_name field explicitly from request body', async () => {
  const b = validLead();
  delete b.clinic;
  b.clinic_name = 'City Dental Clinic';
  const r = await post(b);
  assert.equal(r.status, 201);
  assert.equal(r.json.ok, true);
});

test('stored lead contains correct clinic_name, scope: platform, and null clinic', async () => {
  const b = validLead();
  b.clinic = 'Unique Platform Clinic';
  const r = await post(b);
  assert.equal(r.status, 201);
  const leads = app.locals.store.leads || [];
  const stored = leads.find(l => l._id === r.json.id);
  assert.ok(stored, 'lead should be found in store');
  assert.equal(stored.clinic_name, 'Unique Platform Clinic');
  assert.equal(stored.scope, 'platform');
  assert.equal(stored.clinic, null);
  assert.equal(stored.status, 'new');
  assert.equal(stored.source, 'landing');
});

test('spoofed clinic ID cannot establish tenant ownership or leak into clinic listing', async () => {
  const spoofedClinicId = 'clinic-victim-999';
  const b = validLead();
  b.clinic = spoofedClinicId;
  const r = await post(b);
  assert.equal(r.status, 201);

  const leads = app.locals.store.leads || [];
  const stored = leads.find(l => l._id === r.json.id);
  assert.ok(stored);
  assert.equal(stored.clinic, null);
  assert.equal(stored.scope, 'platform');

  const clinicLeads = await app.locals.store.listLeads({ clinic: spoofedClinicId });
  assert.equal(clinicLeads.length, 0, 'Spoofed clinic ID must not appear in clinic-scoped listLeads');
});

test('file store persists public marketing leads with clinic_name and scope: platform', async () => {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const { createFileStore } = require('./store-file');

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'leads-file-test-'));
  const filePath = path.join(tempDir, 'store.json');
  try {
    const s1 = createFileStore(filePath);
    const created = await s1.createLead({
      name: 'Dr. Test',
      clinic_name: 'Test File Clinic',
      scope: 'platform',
      phone: '9876543210',
      email: 'dr@test.in',
    });
    assert.ok(created._id);
    assert.equal(created.clinic_name, 'Test File Clinic');
    assert.equal(created.scope, 'platform');
    assert.equal(created.clinic, null);
    s1.flush();

    const s2 = createFileStore(filePath);
    const reloaded = s2.leads.find(l => l._id === created._id);
    assert.ok(reloaded, 'lead must survive restart in file store');
    assert.equal(reloaded.clinic_name, 'Test File Clinic');
    assert.equal(reloaded.scope, 'platform');
    assert.equal(reloaded.clinic, null);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('storage adapters consistently require clinic when scope is clinic', async () => {
  const { createMemoryStore } = require('./store-memory');
  const memStore = createMemoryStore();

  await assert.rejects(
    async () => memStore.createLead({ name: 'Clinic Lead', scope: 'clinic' }),
    /clinic is required/
  );

  const platLead = await memStore.createLead({ name: 'Public Lead', clinic_name: 'Demo Care', scope: 'platform' });
  assert.equal(platLead.scope, 'platform');
  assert.equal(platLead.clinic, null);
});

test('listPlatformLeads retrieves legacy records without scope and hydrates clinic_name', async () => {
  const { createMemoryStore } = require('./store-memory');
  const memStore = createMemoryStore();

  // Directly push a legacy lead without scope, where clinic holds prospect clinic name string
  memStore.leads.push({
    _id: 'legacy_lead_1',
    name: 'Dr. Old User',
    clinic: 'Old Heritage Dental', // string clinic name from old schema
    email: 'old@heritage.in',
    phone: '9876543210',
    createdAt: new Date().toISOString(),
  });

  // Also push a clinic-scoped lead with explicit tenant ownership
  memStore.leads.push({
    _id: 'tenant_lead_1',
    name: 'Patient X',
    clinic: 'tenant-clinic-uuid-123',
    scope: 'clinic',
    email: 'px@clinic.in',
    createdAt: new Date().toISOString(),
  });

  const platformLeads = await memStore.listPlatformLeads();
  const legacyHydrated = platformLeads.find(l => l._id === 'legacy_lead_1');
  assert.ok(legacyHydrated, 'legacy record without scope should be retrieved as platform lead');
  assert.equal(legacyHydrated.clinic_name, 'Old Heritage Dental');
  assert.equal(legacyHydrated.scope, 'platform');
  assert.equal(legacyHydrated.clinic, null, 'legacy string clinic must be nullified to prevent tenant confusion');

  const tenantLead = platformLeads.find(l => l._id === 'tenant_lead_1');
  assert.equal(tenantLead, undefined, 'clinic-scoped leads must never appear in platform leads');
});
