'use strict';
/**
 * test-phase3g2-data-integrity.js
 *
 * Automated verification suite for MediBot Phase 3G.2 Data Integrity Hardening & Phase 3G.2.2 Remediation:
 * 1. Clinic phone uniqueness (database-level unique partial index).
 * 2. Inactive clinic phone behavior (allowed to share phone).
 * 3. Existing duplicate active phone detection in ensureIndexes().
 * 4. Multi-process concurrent clinic onboarding protection (2 child processes).
 * 5. Clinic phone update normalization, formatting variation collision, and invalid rejection (Task 1).
 * 6. SlotReservation reconciliation (dry-run, apply, stale, missing, mismatched, malformed).
 * 7. Protection guards (production refusal, non-mongo refusal, appointment immutability).
 * 8. Maintenance-window confirmation requirement for apply mode (Task 2).
 * 9. Fail-closed database target safety and NODE_ENV guards (Task 3).
 */

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const mongoose = require('mongoose');
const { spawn } = require('node:child_process');
const path = require('node:path');
const jwt = require('jsonwebtoken');

const TEST_DB_URI = process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017/medibot_test_phase3e';
const { Clinic, Appointment, SlotReservation, User } = require('./store-mongo');
const { ensureIndexes } = require('./store-mongo');
const { reconcileSlots, inspectDatabaseTarget } = require('./scripts/reconcile-slots');

function makeRequest(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const reqOpts = {
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method: opts.method || 'GET',
      headers: opts.headers || {},
    };

    const req = http.request(reqOpts, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(body); } catch (_) {}
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body,
          json,
        });
      });
    });

    req.on('error', reject);
    if (opts.body) {
      req.write(typeof opts.body === 'object' ? JSON.stringify(opts.body) : opts.body);
    }
    req.end();
  });
}

describe('MediBot Phase 3G.2: Data Integrity Hardening Suite', () => {
  let app;
  let testServer;
  let serverPort;

  before(async () => {
    process.env.NODE_ENV = 'test';
    process.env.STORE = 'mongo';
    process.env.TEST_MONGODB_URI = TEST_DB_URI;
    process.env.MONGODB_URI = TEST_DB_URI;
    process.env.JWT_SECRET = 'test-secret-at-least-32-chars-long-data-integrity';
    process.env.TWILIO_AUTH_TOKEN = 'test-twilio-auth-token-integrity';
    process.env.INTERNAL_SERVICE_KEY = 'test-internal-service-key-at-least-32-chars';

    app = require('./server.js');
    if (app.locals && app.locals.storeReadyPromise) {
      await app.locals.storeReadyPromise;
    }

    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(TEST_DB_URI, { serverSelectionTimeoutMS: 5000 });
    }
    await ensureIndexes();

    testServer = http.createServer(app);
    await new Promise(resolve => testServer.listen(0, resolve));
    serverPort = testServer.address().port;
  });

  after(async () => {
    if (testServer) {
      await new Promise(resolve => testServer.close(resolve));
    }
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
  });

  // ==========================================================================
  // TASK A: Clinic Phone Uniqueness, Concurrency & Update Remediation (C-01)
  // ==========================================================================
  describe('Task A: Clinic Phone Uniqueness & Concurrency', () => {
    const testPhone = '+919123456789';

    beforeEach(async () => {
      await Clinic.deleteMany({ phone: { $in: [testPhone, '+919123456780', '+919999999999'] } });
    });

    test('A.1: Unique partial index exists on Clinic collection', async () => {
      const idxs = await Clinic.collection.indexes();
      const hasPhoneIdx = idxs.some(idx =>
        idx.unique === true &&
        idx.key.phone === 1 &&
        idx.partialFilterExpression &&
        idx.partialFilterExpression.active === true
      );
      assert.equal(hasPhoneIdx, true, 'Unique partial index on active clinic phone must exist');
    });

    test('A.2: Database rejects duplicate active clinic with identical phone (E11000)', async () => {
      const clinic1 = await Clinic.create({
        name: 'Clinic Alpha',
        phone: testPhone,
        active: true,
      });
      assert.ok(clinic1._id);

      await assert.rejects(
        () => Clinic.create({
          name: 'Clinic Alpha Duplicate',
          phone: testPhone,
          active: true,
        }),
        (err) => err.code === 11000 || (err.message && err.message.includes('E11000'))
      );
    });

    test('A.3: Inactive clinics are exempt from unique constraint collision', async () => {
      // Inactive clinic 1
      const inact1 = await Clinic.create({
        name: 'Inactive Clinic 1',
        phone: testPhone,
        active: false,
      });

      // Inactive clinic 2 with SAME phone - allowed because active is false
      const inact2 = await Clinic.create({
        name: 'Inactive Clinic 2',
        phone: testPhone,
        active: false,
      });
      assert.ok(inact1._id);
      assert.ok(inact2._id);

      // Active clinic can also claim this phone because the partial index only indexes active: true
      const activeClinic = await Clinic.create({
        name: 'Active Clinic',
        phone: testPhone,
        active: true,
      });
      assert.ok(activeClinic._id);
    });

    test('A.4: ensureIndexes detects existing duplicate active phones and halts startup safely', async () => {
      // Temporarily drop index to simulate pre-existing dirty database state
      try {
        await Clinic.collection.dropIndex('unique_active_clinic_phone');
      } catch (_) {}

      // Insert two active clinics with same phone
      await Clinic.create([
        { name: 'Legacy Dup 1', phone: '+919999999999', active: true },
        { name: 'Legacy Dup 2', phone: '+919999999999', active: true },
      ]);

      // ensureIndexes must throw without modifying or deleting records
      await assert.rejects(
        () => ensureIndexes(),
        /Duplicate active clinic phone numbers found before creating unique index/
      );

      // Verify records were NEVER deleted or merged automatically
      const count = await Clinic.countDocuments({ phone: '+919999999999' });
      assert.equal(count, 2, 'Existing duplicate clinics must not be deleted automatically');

      // Cleanup dirty state and restore index
      await Clinic.deleteMany({ phone: '+919999999999' });
      await ensureIndexes();
    });

    test('A.5: Concurrent onboarding attempts from two processes allow exactly one registration', async () => {
      const concurrentPhone = '+919123456780';
      await Clinic.deleteMany({ phone: concurrentPhone });
      await User.deleteMany({ email: { $in: ['onboard1@example.com', 'onboard2@example.com'] } });

      const scriptPath = path.resolve(__dirname, 'scratch', 'onboard_client.js');
      const fs = require('fs');
      if (!fs.existsSync(path.dirname(scriptPath))) {
        fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
      }

      fs.writeFileSync(scriptPath, `
        const http = require('http');
        const data = JSON.stringify({
          clinic_name: process.argv[2],
          admin_name: 'Dr. Admin',
          email: process.argv[3],
          password: 'Password123!',
          phone: '${concurrentPhone}'
        });

        const req = http.request({
          hostname: '127.0.0.1',
          port: ${serverPort},
          path: '/api/auth/register-clinic',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(data),
          }
        }, (res) => {
          let body = '';
          res.on('data', c => body += c);
          res.on('end', () => {
            console.log(JSON.stringify({ status: res.statusCode, body }));
            process.exit(0);
          });
        });
        req.on('error', (e) => {
          console.error(e);
          process.exit(1);
        });
        req.write(data);
        req.end();
      `);

      // Spawn two simultaneous child processes
      const p1 = spawn(process.execPath, [scriptPath, 'Clinic One', 'onboard1@example.com']);
      const p2 = spawn(process.execPath, [scriptPath, 'Clinic Two', 'onboard2@example.com']);

      const readProcess = (p) => new Promise((resolve) => {
        let out = '';
        p.stdout.on('data', d => out += d.toString());
        p.on('exit', () => {
          try { resolve(JSON.parse(out.trim())); } catch (_) { resolve({ status: 500 }); }
        });
      });

      const [res1, res2] = await Promise.all([readProcess(p1), readProcess(p2)]);
      const statuses = [res1.status, res2.status].sort();

      // Exactly one must succeed (201), the other must be rejected (409)
      assert.deepEqual(statuses, [201, 409], `Expected [201, 409], got ${JSON.stringify(statuses)}`);

      // Exactly one active clinic was created in MongoDB
      const clinicCount = await Clinic.countDocuments({ phone: concurrentPhone, active: true });
      assert.equal(clinicCount, 1, 'Only one active clinic record must exist in MongoDB');
    });

    test('A.6: Clinic phone update normalization, formatting variation collision (409), invalid phone (400) and tenant isolation', async () => {
      const clinicAId = new mongoose.Types.ObjectId();
      const clinicBId = new mongoose.Types.ObjectId();
      const phoneA = '+919876500001';
      const phoneB = '+919876500002';

      await Clinic.deleteMany({ _id: { $in: [clinicAId, clinicBId] } });
      await Clinic.deleteMany({ phone: { $in: [phoneA, phoneB, '+919876500003'] } });

      await Clinic.create([
        { _id: clinicAId, name: 'Clinic A', phone: phoneA, active: true },
        { _id: clinicBId, name: 'Clinic B', phone: phoneB, active: true },
      ]);

      const tokenA = jwt.sign({ sub: 'user_a', email: 'a@clinic.com', role: 'admin', clinic: clinicAId.toString() }, process.env.JWT_SECRET);
      const tokenB = jwt.sign({ sub: 'user_b', email: 'b@clinic.com', role: 'admin', clinic: clinicBId.toString() }, process.env.JWT_SECRET);

      // (a) Valid normalized phone update: Clinic A updates phone with unformatted string "9876500003"
      const resUpdateA = await makeRequest(`http://127.0.0.1:${serverPort}/api/clinic`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenA}`,
        },
        body: { phone: '9876500003' },
      });
      assert.equal(resUpdateA.statusCode, 200);
      assert.equal(resUpdateA.json.phone, '+919876500003', 'Must normalize 10-digit Indian number to E.164');

      // Verify persisted in MongoDB
      const docA = await Clinic.findById(clinicAId).lean();
      assert.equal(docA.phone, '+919876500003', 'Must be stored normalized in MongoDB');

      // (b) Formatting variation duplicate attempt: Clinic B attempts to claim Clinic A phone with spaces and punctuation
      // " +91 (98765) 00003 " normalizes to "+919876500003"
      const resDupFormat = await makeRequest(`http://127.0.0.1:${serverPort}/api/clinic`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenB}`,
        },
        body: { phone: ' +91 (98765) 00003 ' },
      });
      assert.equal(resDupFormat.statusCode, 409, 'Must return HTTP 409 Conflict when normalized phone collides');
      assert.match(resDupFormat.json.error, /already exists/i);

      // Verify Clinic B phone did NOT change
      const docBUnchanged = await Clinic.findById(clinicBId).lean();
      assert.equal(docBUnchanged.phone, phoneB, 'Clinic B phone must remain unchanged after collision rejection');

      // (c) Direct identical string duplicate attempt: Clinic B attempts to claim Clinic A phone directly
      const resDupDirect = await makeRequest(`http://127.0.0.1:${serverPort}/api/clinic`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenB}`,
        },
        body: { phone: '+919876500003' },
      });
      assert.equal(resDupDirect.statusCode, 409, 'Direct duplicate phone update must return 409');

      // (d) Invalid phone number: returns 400
      const resInvalid = await makeRequest(`http://127.0.0.1:${serverPort}/api/clinic`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenA}`,
        },
        body: { phone: 'not-a-number' },
      });
      assert.equal(resInvalid.statusCode, 400, 'Invalid phone number must return HTTP 400');
      assert.match(resInvalid.json.error, /valid 10-digit Indian phone number/i);

      // (e) Missing phone field: updates name and greeting without altering phone
      const resNoPhone = await makeRequest(`http://127.0.0.1:${serverPort}/api/clinic`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenA}`,
        },
        body: { name: 'Clinic A Updated Name', greeting_text: 'Welcome to Clinic A!' },
      });
      assert.equal(resNoPhone.statusCode, 200);
      assert.equal(resNoPhone.json.name, 'Clinic A Updated Name');
      assert.equal(resNoPhone.json.phone, '+919876500003', 'Existing phone must be preserved when phone field is omitted');

      // (f) Tenant isolation: Clinic B attempts cross-clinic update by injecting clinic ID in body
      const resCrossTenant = await makeRequest(`http://127.0.0.1:${serverPort}/api/clinic`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenB}`,
        },
        body: { clinic: clinicAId.toString(), name: 'Malicious Name Hack' },
      });
      assert.equal(resCrossTenant.statusCode, 200);
      assert.equal(resCrossTenant.json.name, 'Malicious Name Hack');
      // Clinic A must NOT be modified
      const docAStillSafe = await Clinic.findById(clinicAId).lean();
      assert.equal(docAStillSafe.name, 'Clinic A Updated Name', 'Clinic A must not be modified by Clinic B request');

      // (g) Same clinic updating its own phone to formatting variation succeeds (no self-collision)
      const resSelfUpdate = await makeRequest(`http://127.0.0.1:${serverPort}/api/clinic`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenA}`,
        },
        body: { phone: '09876500003' }, // Leading 0 Indian 11-digit variation of its own phone
      });
      assert.equal(resSelfUpdate.statusCode, 200, 'Updating own phone to formatting variation must succeed');
      assert.equal(resSelfUpdate.json.phone, '+919876500003');

      // Cleanup
      await Clinic.deleteMany({ _id: { $in: [clinicAId, clinicBId] } });
    });
  });

  // ==========================================================================
  // TASK B: SlotReservation Reconciliation Tooling & Safety Guards (H-01, H-02)
  // ==========================================================================
  describe('Task B: SlotReservation Reconciliation Script', () => {
    const clinicId = new mongoose.Types.ObjectId();
    const date = '25/11/2026';
    const slot1 = 'Morning 10:00';
    const slot2 = 'Afternoon 14:00';
    const slot3 = 'Evening 18:00';

    beforeEach(async () => {
      await Appointment.deleteMany({ clinic: clinicId });
      await SlotReservation.deleteMany({ clinic: clinicId });
    });

    test('B.1: Refuses execution when NODE_ENV is production', async () => {
      process.env.NODE_ENV = 'production';
      try {
        await assert.rejects(
          () => reconcileSlots({ uri: TEST_DB_URI }),
          /cannot be run in NODE_ENV=production/
        );
      } finally {
        process.env.NODE_ENV = 'test';
      }
    });

    test('B.2: Refuses execution when STORE is memory or file', async () => {
      process.env.STORE = 'memory';
      try {
        await assert.rejects(
          () => reconcileSlots({ uri: TEST_DB_URI }),
          /requires MongoDB storage/
        );
      } finally {
        process.env.STORE = 'mongo';
      }
    });

    test('B.3: Dry-run detects discrepancies without modifying database records', async () => {
      // 1. Seed Confirmed appointment without reservation (MISSING)
      await Appointment.create({
        clinic: clinicId,
        date,
        time_slot: slot1,
        phone: '+919999900001',
        status: 'Confirmed',
      });

      // 2. Seed 2 Confirmed appointments but reservation says booked: 1 (MISMATCH)
      const slot2Key = `${clinicId}:${date}:${slot2}`;
      await Appointment.create([
        { clinic: clinicId, date, time_slot: slot2, phone: '+919999900002', status: 'Confirmed' },
        { clinic: clinicId, date, time_slot: slot2, phone: '+919999900003', status: 'Confirmed' },
      ]);
      await SlotReservation.create({
        _id: slot2Key,
        clinic: clinicId,
        date,
        time_slot: slot2,
        booked: 1, // Mismatched (should be 2)
      });

      // 3. Seed reservation with booked: 3 but 0 Confirmed appointments (STALE)
      const slot3Key = `${clinicId}:${date}:${slot3}`;
      await SlotReservation.create({
        _id: slot3Key,
        clinic: clinicId,
        date,
        time_slot: slot3,
        booked: 3, // Stale (should be 0)
      });

      // Execute dry-run
      const report = await reconcileSlots({ uri: TEST_DB_URI, apply: false, shouldDisconnect: false });

      assert.equal(report.dryRun, true);
      assert.equal(report.repairedCount, 0, 'Dry-run must not modify any records');

      const missing = report.discrepancies.find(d => d.type === 'MISSING' && String(d.clinic) === String(clinicId));
      const mismatch = report.discrepancies.find(d => d.type === 'MISMATCH' && String(d.clinic) === String(clinicId));
      const stale = report.discrepancies.find(d => d.type === 'STALE' && String(d.clinic) === String(clinicId));

      assert.ok(missing, 'Must detect MISSING reservation');
      assert.equal(missing.actualCount, 1);

      assert.ok(mismatch, 'Must detect MISMATCH reservation');
      assert.equal(mismatch.actualCount, 2);
      assert.equal(mismatch.reservedCount, 1);

      assert.ok(stale, 'Must detect STALE reservation');
      assert.equal(stale.actualCount, 0);
      assert.equal(stale.reservedCount, 3);

      // Verify database documents are completely unchanged
      const resSlot1 = await SlotReservation.findById(`${clinicId}:${date}:${slot1}`);
      assert.equal(resSlot1, null, 'Missing record must remain null in dry-run');

      const resSlot2 = await SlotReservation.findById(slot2Key);
      assert.equal(resSlot2.booked, 1, 'Mismatched record must remain unchanged in dry-run');

      const resSlot3 = await SlotReservation.findById(slot3Key);
      assert.equal(resSlot3.booked, 3, 'Stale record must remain unchanged in dry-run');
    });

    test('B.4: Apply mode repairs discrepancies when maintenance window is confirmed without touching Appointment collection', async () => {
      // Setup same discrepancies as B.3
      const slot1Key = `${clinicId}:${date}:${slot1}`;
      const slot2Key = `${clinicId}:${date}:${slot2}`;
      const slot3Key = `${clinicId}:${date}:${slot3}`;

      await Appointment.create({
        clinic: clinicId,
        date,
        time_slot: slot1,
        phone: '+919999900001',
        status: 'Confirmed',
      });
      await Appointment.create([
        { clinic: clinicId, date, time_slot: slot2, phone: '+919999900002', status: 'Confirmed' },
        { clinic: clinicId, date, time_slot: slot2, phone: '+919999900003', status: 'Confirmed' },
      ]);
      await SlotReservation.create({
        _id: slot2Key,
        clinic: clinicId,
        date,
        time_slot: slot2,
        booked: 1,
      });
      await SlotReservation.create({
        _id: slot3Key,
        clinic: clinicId,
        date,
        time_slot: slot3,
        booked: 3,
      });

      // Capture appointments snapshot to verify immutability
      const apptsBefore = await Appointment.find({ clinic: clinicId }).sort({ _id: 1 }).lean();

      // Execute in apply mode with maintenanceWindowConfirmed: true
      const report = await reconcileSlots({
        uri: TEST_DB_URI,
        apply: true,
        maintenanceWindowConfirmed: true,
        shouldDisconnect: false,
      });

      assert.equal(report.dryRun, false);
      assert.ok(report.repairedCount >= 3);

      // Verify repairs in SlotReservation
      const fixed1 = await SlotReservation.findById(slot1Key);
      assert.ok(fixed1, 'Missing reservation must be created');
      assert.equal(fixed1.booked, 1);

      const fixed2 = await SlotReservation.findById(slot2Key);
      assert.equal(fixed2.booked, 2, 'Mismatched count must be updated to 2');

      const fixed3 = await SlotReservation.findById(slot3Key);
      assert.equal(fixed3.booked, 0, 'Stale count must be reset to 0');

      // Verify Appointment collection was completely untouched
      const apptsAfter = await Appointment.find({ clinic: clinicId }).sort({ _id: 1 }).lean();
      assert.deepEqual(
        apptsBefore.map(a => ({ _id: String(a._id), status: a.status })),
        apptsAfter.map(a => ({ _id: String(a._id), status: a.status })),
        'Appointments must never be modified by reconciliation script'
      );
    });

    test('B.5: Malformed reservation records are detected and reported safely', async () => {
      // Seed a record with negative booked count and malformed key
      const malformedKey = 'invalid-key-no-colons';
      await SlotReservation.create({
        _id: malformedKey,
        clinic: clinicId,
        date,
        time_slot: 'Unknown',
        booked: -3,
      });

      const report = await reconcileSlots({ uri: TEST_DB_URI, apply: false, shouldDisconnect: false });
      const malformed = report.discrepancies.find(d => d.type === 'MALFORMED_RESERVATION' && d.slotKey === malformedKey);

      assert.ok(malformed, 'Malformed reservation must be flagged in report');
      assert.equal(malformed.reservedCount, -3);

      await SlotReservation.deleteOne({ _id: malformedKey });
    });

    test('B.6: Apply mode without --maintenance-window-confirmed is strictly rejected', async () => {
      await assert.rejects(
        () => reconcileSlots({ uri: TEST_DB_URI, apply: true, maintenanceWindowConfirmed: false }),
        /Apply mode requires explicit confirmation via --maintenance-window-confirmed/
      );
    });

    test('B.7: Apply mode is rejected when NODE_ENV is unset or empty', async () => {
      const savedEnv = process.env.NODE_ENV;
      try {
        delete process.env.NODE_ENV;
        await assert.rejects(
          () => reconcileSlots({ uri: TEST_DB_URI, apply: true, maintenanceWindowConfirmed: true }),
          /Apply mode requires an explicit non-production NODE_ENV/
        );

        process.env.NODE_ENV = '   ';
        await assert.rejects(
          () => reconcileSlots({ uri: TEST_DB_URI, apply: true, maintenanceWindowConfirmed: true }),
          /Apply mode requires an explicit non-production NODE_ENV/
        );
      } finally {
        process.env.NODE_ENV = savedEnv;
      }
    });

    test('B.8: Production database targets are unconditionally refused', async () => {
      // 1. Cloud / production cluster URI
      await assert.rejects(
        () => reconcileSlots({
          uri: 'mongodb+srv://admin:pass@medibot-cluster.mongodb.net/medibot_prod',
          apply: false,
        }),
        /Production database detected/
      );

      // 2. Localhost URI with production database name
      await assert.rejects(
        () => reconcileSlots({
          uri: 'mongodb://127.0.0.1:27017/medibot_production',
          apply: false,
        }),
        /Production database detected/
      );
    });

    test('B.9: Unknown or non-approved database targets are rejected for apply mode', async () => {
      // Unrecognized local db name (does not contain test, staging, or dev)
      await assert.rejects(
        () => reconcileSlots({
          uri: 'mongodb://127.0.0.1:27017/random_company_db',
          apply: true,
          maintenanceWindowConfirmed: true,
        }),
        /Unrecognized database target 'random_company_db'/
      );

      // Non-local host
      await assert.rejects(
        () => reconcileSlots({
          uri: 'mongodb://remote-host.example.com:27017/medibot_test',
          apply: true,
          maintenanceWindowConfirmed: true,
        }),
        /Non-local host 'remote-host.example.com' is not an approved local test\/staging target/
      );
    });

    test('B.10: inspectDatabaseTarget classifies URIs, masks credentials, and rejects cloud/prod', () => {
      // Credential masking
      const withCreds = inspectDatabaseTarget('mongodb://secretUser:SuperSecretPass123@127.0.0.1:27017/medibot_test_db');
      assert.equal(withCreds.ok, true);
      assert.ok(!withCreds.sanitized.includes('SuperSecretPass123'), 'Sanitized URI must mask password');
      assert.ok(withCreds.sanitized.includes('//***:***@'), 'Sanitized URI must contain mask marker');

      // Cloud URI
      const cloud = inspectDatabaseTarget('mongodb+srv://user:pass@cluster.mongodb.net/test');
      assert.equal(cloud.ok, false);
      assert.equal(cloud.isProduction, true);

      // Approved local test DB
      const localTest = inspectDatabaseTarget(TEST_DB_URI);
      assert.equal(localTest.ok, true);
      assert.equal(localTest.isApproved, true);

      // Approved local staging DB
      const localStaging = inspectDatabaseTarget('mongodb://localhost:27017/medibot_staging');
      assert.equal(localStaging.ok, true);
      assert.equal(localStaging.isApproved, true);

      // Unrecognized DB
      const unknown = inspectDatabaseTarget('mongodb://localhost:27017/random_unknown_db');
      assert.equal(unknown.ok, false);
      assert.equal(unknown.isUnknown, true);
    });
  });
});
