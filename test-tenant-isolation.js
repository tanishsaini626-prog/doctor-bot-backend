"use strict";
/* ==========================================================================
 * test-tenant-isolation.js - Phase 2 Tenant Isolation Tests
 *
 * Verifies strict clinic isolation within a shared store:
 * - A single store instance holds data for multiple clinics.
 * - Clinic A cannot read, modify, or delete Clinic B's records.
 * - Clinic-scoped aggregations (stats) only include records for that clinic.
 * - Missing clinic context fails closed (throws explicit error).
 * - Tested against memory store and file store.
 * ========================================================================== */

const { test, describe, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-must-be-at-least-32-chars-long-012345';
const express = require('express');
const jwt = require('jsonwebtoken');
const { createAuth } = require('./auth');
const { createMemoryStore } = require('./store-memory');
const { createFileStore } = require('./store-file');

const CLINIC_A = '507f1f77bcf86cd799439011';
const CLINIC_B = '507f1f77bcf86cd799439022';
const UNKNOWN_CLINIC = '507f1f77bcf86cd799439099';
const INVALID_CLINIC = 'not-a-valid-24-hex-id';

function runTenantIsolationSuite(storeFactory, storeName) {
  describe(`Tenant Isolation: ${storeName}`, () => {
    let store;
    let tempDir = null;

    beforeEach(async () => {
      if (storeName === 'file') {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-test-'));
        const filePath = path.join(tempDir, 'store.json');
        store = storeFactory(filePath);
      } else if (storeName === 'mongo') {
        const { Appointment, Clinic, Doctor, CallLog, Lead, User } = require('./store-mongo');
        await Promise.all([
          Appointment.deleteMany({}),
          Clinic.deleteMany({}),
          Doctor.deleteMany({}),
          CallLog.deleteMany({}),
          Lead.deleteMany({}),
          User.deleteMany({}),
        ]);
        store = storeFactory();
      } else {
        store = storeFactory();
      }
    });

    afterEach(() => {
      if (tempDir && fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    // ========================================================================
    // 1. APPOINTMENTS
    // ========================================================================
    describe('Appointments Isolation', () => {
      test('Clinic A and Clinic B appointments are isolated in listing', async () => {
        await store.createAppointment({
          name: 'Patient A', phone: '9999900001', date: '24/06/2026',
          time_slot: '10:00', clinic: CLINIC_A, status: 'Confirmed',
        });
        await store.createAppointment({
          name: 'Patient B', phone: '9999900002', date: '24/06/2026',
          time_slot: '10:00', clinic: CLINIC_B, status: 'Confirmed',
        });

        const listA = await store.listAppointments({ clinic: CLINIC_A });
        const listB = await store.listAppointments({ clinic: CLINIC_B });

        assert.equal(listA.length, 1);
        assert.equal(listA[0].name, 'Patient A');
        assert.equal(String(listA[0].clinic), CLINIC_A);

        assert.equal(listB.length, 1);
        assert.equal(listB[0].name, 'Patient B');
        assert.equal(String(listB[0].clinic), CLINIC_B);
      });

      test('Clinic A cannot get an appointment belonging to Clinic B', async () => {
        const apptB = await store.createAppointment({
          name: 'Patient B', phone: '9999900002', date: '24/06/2026',
          time_slot: '10:00', clinic: CLINIC_B, status: 'Confirmed',
        });

        const fetchByA = await store.getAppointment(apptB._id, { clinic: CLINIC_A });
        assert.equal(fetchByA, null, 'Clinic A must not be able to retrieve Clinic B appointment');

        const fetchByB = await store.getAppointment(apptB._id, { clinic: CLINIC_B });
        assert.ok(fetchByB);
        assert.equal(String(fetchByB._id), String(apptB._id));
      });

      test('Clinic A cannot update status of Clinic B appointment', async () => {
        const apptB = await store.createAppointment({
          name: 'Patient B', phone: '9999900002', date: '24/06/2026',
          time_slot: '10:00', clinic: CLINIC_B, status: 'Confirmed',
        });

        const updateResult = await store.updateAppointmentStatus(apptB._id, 'Cancelled', { clinic: CLINIC_A });
        assert.equal(updateResult, null, 'Clinic A update must return null for Clinic B appointment');

        // Confirm status remained unchanged in Clinic B
        const currentB = await store.getAppointment(apptB._id, { clinic: CLINIC_B });
        assert.equal(currentB.status, 'Confirmed');
      });

      test('Clinic A cannot delete Clinic B appointment', async () => {
        const apptB = await store.createAppointment({
          name: 'Patient B', phone: '9999900002', date: '24/06/2026',
          time_slot: '10:00', clinic: CLINIC_B, status: 'Confirmed',
        });

        const deleteResult = await store.deleteAppointment(apptB._id, { clinic: CLINIC_A });
        assert.equal(deleteResult, false, 'Clinic A delete must return false');

        // Confirm record still exists in Clinic B
        const currentB = await store.getAppointment(apptB._id, { clinic: CLINIC_B });
        assert.ok(currentB, 'Appointment must still exist in Clinic B');
      });

      test('Appointment creation fails closed when clinic is missing', async () => {
        await assert.rejects(
          async () => store.createAppointment({ name: 'No Clinic', phone: '1111111111', date: '24/06/2026', time_slot: '10:00' }),
          /clinic is required/
        );
      });

      test('Appointment listing fails closed when clinic is missing', async () => {
        await assert.rejects(
          async () => store.listAppointments({}),
          /clinic is required/
        );
      });
    });

    // ========================================================================
    // 2. DOCTORS
    // ========================================================================
    describe('Doctors Isolation', () => {
      test('Clinic A and Clinic B doctors are isolated in listing', async () => {
        await store.createDoctor({ name: 'Dr. Alpha' }, { clinic: CLINIC_A });
        await store.createDoctor({ name: 'Dr. Beta' }, { clinic: CLINIC_B });

        const docsA = await store.listDoctors({ clinic: CLINIC_A });
        const docsB = await store.listDoctors({ clinic: CLINIC_B });

        assert.equal(docsA.length, 1);
        assert.equal(docsA[0].name, 'Dr. Alpha');
        assert.equal(String(docsA[0].clinic), CLINIC_A);

        assert.equal(docsB.length, 1);
        assert.equal(docsB[0].name, 'Dr. Beta');
        assert.equal(String(docsB[0].clinic), CLINIC_B);
      });

      test('Clinic A cannot get or modify Clinic B doctor', async () => {
        const docB = await store.createDoctor({ name: 'Dr. Beta' }, { clinic: CLINIC_B });

        const getByA = await store.getDoctor(docB._id, { clinic: CLINIC_A });
        assert.equal(getByA, null);

        const updateByA = await store.updateDoctor(docB._id, { name: 'Dr. Hacked' }, { clinic: CLINIC_A });
        assert.equal(updateByA, null);

        const deleteByA = await store.deleteDoctor(docB._id, { clinic: CLINIC_A });
        assert.equal(deleteByA, false);

        // Verify Clinic B doctor was untouched
        const getByB = await store.getDoctor(docB._id, { clinic: CLINIC_B });
        assert.equal(getByB.name, 'Dr. Beta');
      });

      test('Doctor operations fail closed when clinic is missing', async () => {
        await assert.rejects(
          async () => store.createDoctor({ name: 'Dr. Void' }),
          /clinic is required/
        );
        await assert.rejects(
          async () => store.listDoctors({}),
          /clinic is required/
        );
      });
    });

    // ========================================================================
    // 3. STATS & ANALYTICS
    // ========================================================================
    describe('Stats & Analytics Isolation', () => {
      test('Stats only aggregates records for the requesting clinic', async () => {
        await store.createAppointment({
          name: 'P1', phone: '100', date: '24/06/2026', time_slot: '09:00',
          clinic: CLINIC_A, status: 'Confirmed',
        });
        await store.createAppointment({
          name: 'P2', phone: '200', date: '24/06/2026', time_slot: '09:00',
          clinic: CLINIC_A, status: 'Incomplete',
        });
        await store.createAppointment({
          name: 'P3', phone: '300', date: '24/06/2026', time_slot: '09:00',
          clinic: CLINIC_B, status: 'Confirmed',
        });

        const statsA = await store.stats({ clinic: CLINIC_A });
        const statsB = await store.stats({ clinic: CLINIC_B });

        assert.equal(statsA.total, 2);
        assert.equal(statsA.confirmed, 1);
        assert.equal(statsA.incomplete, 1);

        assert.equal(statsB.total, 1);
        assert.equal(statsB.confirmed, 1);
        assert.equal(statsB.incomplete, 0);
      });

      test('Stats fails closed when clinic is missing', async () => {
        await assert.rejects(
          async () => store.stats({}),
          /clinic is required/
        );
      });
    });

    // ========================================================================
    // 4. CALL LOGS & LEADS
    // ========================================================================
    describe('Call Logs & Leads Isolation', () => {
      test('Call logs are filtered by clinic', async () => {
        await store.logCallTurn('call-1', { phone: '100', clinic: CLINIC_A, transcript: 'hi' });
        await store.logCallTurn('call-2', { phone: '200', clinic: CLINIC_B, transcript: 'hello' });

        const callsA = await store.listCallLogs({ clinic: CLINIC_A });
        const callsB = await store.listCallLogs({ clinic: CLINIC_B });

        assert.equal(callsA.length, 1);
        assert.equal(callsA[0].call_sid, 'call-1');

        assert.equal(callsB.length, 1);
        assert.equal(callsB[0].call_sid, 'call-2');
      });

      test('Call log ownership cannot be overwritten by another clinic', async () => {
        await store.logCallTurn('call-locked-1', { phone: '100', clinic: CLINIC_A, transcript: 'turn 1' });
        // Attempt cross-clinic overwrite
        await store.logCallTurn('call-locked-1', { clinic: CLINIC_B, transcript: 'turn 2 malicious' });

        const callsA = await store.listCallLogs({ clinic: CLINIC_A });
        const callsB = await store.listCallLogs({ clinic: CLINIC_B });

        const logInA = callsA.find(c => c.call_sid === 'call-locked-1');
        assert.ok(logInA, 'Call log must remain in Clinic A');
        assert.equal(String(logInA.clinic), CLINIC_A);

        const logInB = callsB.find(c => c.call_sid === 'call-locked-1');
        assert.equal(logInB, undefined, 'Call log must not appear in Clinic B');
      });

      test('Leads are filtered by clinic', async () => {
        await store.createLead({ name: 'Lead A', phone: '111', clinic: CLINIC_A });
        await store.createLead({ name: 'Lead B', phone: '222', clinic: CLINIC_B });

        const leadsA = await store.listLeads({ clinic: CLINIC_A });
        const leadsB = await store.listLeads({ clinic: CLINIC_B });

        assert.equal(leadsA.length, 1);
        assert.equal(leadsA[0].name, 'Lead A');
        assert.equal(String(leadsA[0].clinic), CLINIC_A);

        assert.equal(leadsB.length, 1);
        assert.equal(leadsB[0].name, 'Lead B');
        assert.equal(String(leadsB[0].clinic), CLINIC_B);
      });

      test('Clinic-scoped lead creation and listing fail closed when clinic is missing', async () => {
        await assert.rejects(
          async () => store.createLead({ name: 'No Clinic Lead', scope: 'clinic' }),
          /clinic is required/
        );
        await assert.rejects(
          async () => store.listLeads({}),
          /clinic is required/
        );
      });
    });

    // ========================================================================
    // 5. CLINIC SETTINGS
    // ========================================================================
    describe('Clinic Settings Isolation', () => {
      test('Clinic A and Clinic B can read their own settings', async () => {
        await store.saveClinic({ name: 'Alpha Clinic', phone: '+91 91111 11111' }, { clinic: CLINIC_A, create: true });
        await store.saveClinic({ name: 'Beta Clinic', phone: '+91 92222 22222' }, { clinic: CLINIC_B, create: true });

        const clinicA = await store.getClinic(CLINIC_A);
        const clinicB = await store.getClinic(CLINIC_B);

        assert.ok(clinicA, 'Clinic A settings must exist');
        assert.equal(clinicA.name, 'Alpha Clinic');
        assert.equal(clinicA.phone, '+91 91111 11111');

        assert.ok(clinicB, 'Clinic B settings must exist');
        assert.equal(clinicB.name, 'Beta Clinic');
        assert.equal(clinicB.phone, '+91 92222 22222');
      });

      test('Clinic B cannot read or overwrite Clinic A settings', async () => {
        await store.saveClinic({ name: 'Alpha Clinic', phone: '+91 91111 11111' }, { clinic: CLINIC_A, create: true });
        await store.saveClinic({ name: 'Beta Clinic', phone: '+91 92222 22222' }, { clinic: CLINIC_B, create: true });

        // Update Clinic B settings
        await store.saveClinic({ name: 'Beta New Name', phone: '+91 99999 88888' }, { clinic: CLINIC_B });

        // Verify Clinic A is completely untouched
        const clinicA = await store.getClinic(CLINIC_A);
        assert.equal(clinicA.name, 'Alpha Clinic');
        assert.equal(clinicA.phone, '+91 91111 11111');

        // Verify Clinic B has updated settings
        const clinicB = await store.getClinic(CLINIC_B);
        assert.equal(clinicB.name, 'Beta New Name');
        assert.equal(clinicB.phone, '+91 99999 88888');
      });

      test('Unknown clinic ID returns null and prevents accidental creation', async () => {
        const result = await store.saveClinic({ name: 'Ghost Clinic' }, { clinic: UNKNOWN_CLINIC });
        assert.equal(result, null, 'Updating an unknown clinic without create: true must return null');

        const fetched = await store.getClinic(UNKNOWN_CLINIC);
        assert.equal(fetched, null, 'Unknown clinic must not have been created');
      });

      test('Invalid clinic ID format is rejected safely', async () => {
        if (storeName === 'mongo') {
          await assert.rejects(
            async () => store.saveClinic({ name: 'Bad ID' }, { clinic: INVALID_CLINIC }),
            /Invalid clinic ID/
          );
          const fetched = await store.getClinic(INVALID_CLINIC);
          assert.equal(fetched, null);
        }
      });

      test('Clinic settings operations fail closed when clinic context is missing', async () => {
        await assert.rejects(
          async () => store.saveClinic({ name: 'No Context' }, {}),
          /clinic is required/
        );
      });
    });
  });
}

// Run the full direct-store suite against both memory and file store implementations
runTenantIsolationSuite(() => createMemoryStore(), 'memory');
runTenantIsolationSuite((filePath) => createFileStore(filePath), 'file');

// ============================================================================
// 6. REAL HTTP ROUTE AUTHORIZATION SUITE (/api/clinic)
// ============================================================================
function createClinicHttpServer(store) {
  const app = express();
  app.use(express.json());
  const { router, requireAuth, signToken } = createAuth(store, (_req, _res, next) => next());
  app.use('/api', router);

  app.get('/api/clinic', requireAuth, async (req, res) => {
    try {
      const userClinic = req.user && req.user.clinic;
      if (!userClinic) {
        return res.status(403).json({ error: 'Clinic not assigned. Configure clinic during onboarding before viewing settings.' });
      }
      const clinic = await store.getClinic(userClinic);
      if (!clinic) {
        return res.status(404).json({ error: 'Clinic not found' });
      }
      res.json(clinic);
    } catch (err) {
      res.status(500).json({ error: 'Could not load the clinic' });
    }
  });

  app.patch('/api/clinic', requireAuth, async (req, res) => {
    const userClinic = req.user && req.user.clinic;
    if (!userClinic || userClinic === 'default') {
      return res.status(403).json({ error: 'Clinic not assigned. Configure clinic during onboarding before modifying settings.' });
    }
    const body = req.body || {};
    const patch = {};
    for (const field of ['name', 'phone', 'whatsapp_to', 'greeting_text', 'timezone']) {
      if (body[field] !== undefined) patch[field] = String(body[field]);
    }
    if (body.languages !== undefined) {
      if (!Array.isArray(body.languages)) return res.status(400).json({ error: 'languages must be an array' });
      patch.languages = body.languages.map(String);
    }
    if (body.greeting_text !== undefined && !String(body.greeting_text).trim()) {
      return res.status(400).json({ error: 'The greeting cannot be empty' });
    }
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nothing to update' });
    try {
      const updated = await store.saveClinic(patch, { clinic: userClinic });
      if (!updated) {
        return res.status(404).json({ error: 'Clinic not found' });
      }
      res.json(updated);
    } catch (err) {
      if (err.message && err.message.includes('Invalid clinic ID')) {
        return res.status(400).json({ error: 'Invalid clinic ID' });
      }
      res.status(500).json({ error: 'Could not save the clinic settings' });
    }
  });

  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        base: `http://127.0.0.1:${port}`,
        signToken,
        close: () => new Promise((res) => {
          if (typeof server.closeAllConnections === 'function') {
            server.closeAllConnections();
          }
          server.close(res);
        }),
      });
    });
  });
}

describe('HTTP Route Authorization: /api/clinic', () => {
  let serverCtx;
  let store;
  let tokenA, tokenB, tokenNoClinic, tokenGhost;

  before(async () => {
    store = createMemoryStore();
    // Provision Clinic A and Clinic B
    await store.saveClinic({ name: 'Alpha Clinic', phone: '+91 91111 11111' }, { clinic: CLINIC_A, create: true });
    await store.saveClinic({ name: 'Beta Clinic', phone: '+91 92222 22222' }, { clinic: CLINIC_B, create: true });

    serverCtx = await createClinicHttpServer(store);

    tokenA = serverCtx.signToken({ _id: 'u_a', clinic: CLINIC_A, email: 'a@clinic.test', role: 'receptionist' }).token;
    tokenB = serverCtx.signToken({ _id: 'u_b', clinic: CLINIC_B, email: 'b@clinic.test', role: 'receptionist' }).token;
    tokenNoClinic = serverCtx.signToken({ _id: 'u_orphan', clinic: null, email: 'orphan@test.com', role: 'receptionist' }).token;
    tokenGhost = serverCtx.signToken({ _id: 'u_ghost', clinic: UNKNOWN_CLINIC, email: 'ghost@test.com', role: 'receptionist' }).token;
  });

  after(async () => {
    if (serverCtx && serverCtx.close) {
      await serverCtx.close();
    }
  });

  test('GET /api/clinic without token returns 401 Unauthorized', async () => {
    const res = await fetch(`${serverCtx.base}/api/clinic`);
    assert.equal(res.status, 401);
  });

  test('GET /api/clinic with missing clinic in token returns 403 Forbidden', async () => {
    const res = await fetch(`${serverCtx.base}/api/clinic`, {
      headers: { Authorization: `Bearer ${tokenNoClinic}` },
    });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.match(body.error, /Clinic not assigned/);
  });

  test('PATCH /api/clinic with missing clinic in token returns 403 Forbidden', async () => {
    const res = await fetch(`${serverCtx.base}/api/clinic`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${tokenNoClinic}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'Hacked Name' }),
    });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.match(body.error, /Clinic not assigned/);
  });

  test('GET /api/clinic for Clinic A returns Clinic A settings (200)', async () => {
    const res = await fetch(`${serverCtx.base}/api/clinic`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.name, 'Alpha Clinic');
    assert.equal(body.phone, '+91 91111 11111');
  });

  test('GET /api/clinic for unprovisioned clinic returns 404 (never leaks Clinic A)', async () => {
    const res = await fetch(`${serverCtx.base}/api/clinic`, {
      headers: { Authorization: `Bearer ${tokenGhost}` },
    });
    assert.equal(res.status, 404);
  });

  test('PATCH /api/clinic ignores client-supplied clinic ID in request body (cross-tenant overwrite prevented)', async () => {
    // Clinic B attempts to overwrite Clinic A by sending clinic: CLINIC_A in the body
    const res = await fetch(`${serverCtx.base}/api/clinic`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${tokenB}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'Beta Malicious Overwrite',
        clinic: CLINIC_A, // Malicious injection attempt
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.name, 'Beta Malicious Overwrite');

    // Verify Clinic A is completely unaffected
    const resA = await fetch(`${serverCtx.base}/api/clinic`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    const bodyA = await resA.json();
    assert.equal(bodyA.name, 'Alpha Clinic', 'Clinic A must retain its original name despite injection attempt');
  });

  test('PATCH /api/clinic for unprovisioned clinic returns 404 (prevents accidental provisioning via PATCH)', async () => {
    const res = await fetch(`${serverCtx.base}/api/clinic`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${tokenGhost}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'Rogue Provisioning' }),
    });
    assert.equal(res.status, 404);
  });
});

// ============================================================================
// 6b. HTTP ROUTE CONSISTENCY & TENANT ISOLATION (Batch 4C)
// ============================================================================
describe('HTTP Route Consistency & Multi-Tenant Authorization (Batch 4C)', () => {
  let serverInstance;
  let baseUrl;
  let serverStore;
  let tokenA, tokenB, tokenNoClinic, tokenDefaultClinic;
  let doctorA, doctorB;
  let apptA, apptB;

  before(async () => {
    process.env.STORE = 'memory';
    process.env.TWILIO_VALIDATE_SIGNATURE = 'false';
    const serverApp = require('./server');
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

    const { signToken } = createAuth(serverStore);
    tokenA = signToken({ _id: 'u_a_b4c', clinic: CLINIC_A, email: 'a@clinic.test', role: 'admin' }).token;
    tokenB = signToken({ _id: 'u_b_b4c', clinic: CLINIC_B, email: 'b@clinic.test', role: 'admin' }).token;
    tokenNoClinic = signToken({ _id: 'u_orphan_b4c', clinic: null, email: 'orphan@test.com', role: 'receptionist' }).token;
    tokenDefaultClinic = signToken({ _id: 'u_default_b4c', clinic: 'default', email: 'default@test.com', role: 'receptionist' }).token;

    // Seed doctors
    doctorA = await serverStore.createDoctor({
      name: 'Dr. Alpha Batch4C',
      specialty: 'Cardiology',
      working_hours: [{ day: 1, start: '09:00', end: '17:00' }],
    }, { clinic: CLINIC_A });

    doctorB = await serverStore.createDoctor({
      name: 'Dr. Beta Batch4C',
      specialty: 'Dermatology',
      working_hours: [{ day: 1, start: '09:00', end: '17:00' }],
    }, { clinic: CLINIC_B });

    // Seed appointments
    apptA = await serverStore.createAppointment({
      name: 'Patient A Batch4C',
      phone: '+91 99999 11111',
      date: '28/12/2026',
      time_slot: 'Morning 10:00',
      clinic: CLINIC_A,
      status: 'Confirmed',
    });

    apptB = await serverStore.createAppointment({
      name: 'Patient B Batch4C',
      phone: '+91 99999 22222',
      date: '28/12/2026',
      time_slot: 'Morning 10:00',
      clinic: CLINIC_B,
      status: 'Confirmed',
    });

    // Seed call logs
    await serverStore.logCallTurn('CA-A-001', { phone: '+91 99999 11111', clinic: CLINIC_A, transcript: 'turn A' });
    await serverStore.logCallTurn('CA-B-001', { phone: '+91 99999 22222', clinic: CLINIC_B, transcript: 'turn B' });
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

  test('GET /api/appointments/:id retrieves own appointment but returns 404 for another clinic', async () => {
    // Clinic A retrieves its own appointment
    const resA = await fetch(`${baseUrl}/api/appointments/${apptA._id}`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    assert.equal(resA.status, 200);
    const bodyA = await resA.json();
    assert.equal(bodyA._id, apptA._id);

    // Clinic A cannot retrieve Clinic B appointment
    const resCross = await fetch(`${baseUrl}/api/appointments/${apptB._id}`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    assert.equal(resCross.status, 404);
  });

  test('PATCH /api/appointments/:id returns 404 and does not modify another clinic appointment', async () => {
    const resCross = await fetch(`${baseUrl}/api/appointments/${apptB._id}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${tokenA}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ status: 'Cancelled' }),
    });
    assert.equal(resCross.status, 404);

    // Verify Clinic B appointment remained Confirmed
    const apptCheck = await serverStore.getAppointment(apptB._id, { clinic: CLINIC_B });
    assert.equal(apptCheck.status, 'Confirmed');
  });

  test('DELETE /api/appointments/:id returns 404 when attempting to delete another clinic appointment', async () => {
    const resCross = await fetch(`${baseUrl}/api/appointments/${apptB._id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    assert.equal(resCross.status, 404);

    // Verify Clinic B appointment still exists
    const apptCheck = await serverStore.getAppointment(apptB._id, { clinic: CLINIC_B });
    assert.ok(apptCheck);

    // Clinic A can delete its own appointment
    const resOwn = await fetch(`${baseUrl}/api/appointments/${apptA._id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    assert.equal(resOwn.status, 200);
    const bodyOwn = await resOwn.json();
    assert.equal(bodyOwn.deleted, true);
  });

  test('GET /api/appointments returns strictly scoped appointments for the authenticated clinic', async () => {
    const resA = await fetch(`${baseUrl}/api/appointments`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    assert.equal(resA.status, 200);
    const listA = await resA.json();
    assert.ok(Array.isArray(listA));
    assert.ok(listA.every(a => a.clinic === CLINIC_A), 'All appointments in Clinic A list must belong to Clinic A');

    const resB = await fetch(`${baseUrl}/api/appointments`, {
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    assert.equal(resB.status, 200);
    const listB = await resB.json();
    assert.ok(Array.isArray(listB));
    assert.ok(listB.every(b => b.clinic === CLINIC_B), 'All appointments in Clinic B list must belong to Clinic B');
    assert.ok(listB.some(b => b._id === apptB._id), 'Clinic B appointment must be present in Clinic B list');
  });

  test('GET /api/calls returns strictly scoped call logs for the authenticated clinic', async () => {
    const resA = await fetch(`${baseUrl}/api/calls`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    assert.equal(resA.status, 200);
    const callsA = await resA.json();
    assert.ok(Array.isArray(callsA));
    assert.ok(callsA.some(c => c.call_sid === 'CA-A-001'), 'Clinic A call log must be in Clinic A list');
    assert.ok(!callsA.some(c => c.call_sid === 'CA-B-001'), 'Clinic B call log must NOT be in Clinic A list');

    const resB = await fetch(`${baseUrl}/api/calls`, {
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    assert.equal(resB.status, 200);
    const callsB = await resB.json();
    assert.ok(Array.isArray(callsB));
    assert.ok(callsB.some(c => c.call_sid === 'CA-B-001'), 'Clinic B call log must be in Clinic B list');
    assert.ok(!callsB.some(c => c.call_sid === 'CA-A-001'), 'Clinic A call log must NOT be in Clinic B list');
  });

  test('GET, PATCH, and DELETE /api/doctors enforce tenant isolation', async () => {
    // Listing
    const resA = await fetch(`${baseUrl}/api/doctors`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    assert.equal(resA.status, 200);
    const docsA = await resA.json();
    assert.ok(docsA.some(d => d._id === doctorA._id));
    assert.ok(!docsA.some(d => d._id === doctorB._id));

    // Cross-clinic PATCH returns 404
    const resPatchCross = await fetch(`${baseUrl}/api/doctors/${doctorB._id}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${tokenA}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ specialty: 'Hacked Specialty' }),
    });
    assert.equal(resPatchCross.status, 404);

    // Cross-clinic DELETE returns 404
    const resDeleteCross = await fetch(`${baseUrl}/api/doctors/${doctorB._id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    assert.equal(resDeleteCross.status, 404);
  });

  test('Missing clinic context in token returns HTTP 403 (fails closed, not 500)', async () => {
    const endpoints = [
      '/api/appointments',
      '/api/calls',
      '/api/doctors',
      '/api/leads',
      '/api/analytics',
      '/api/patients',
      '/api/stats',
    ];

    for (const ep of endpoints) {
      const res = await fetch(`${baseUrl}${ep}`, {
        headers: { Authorization: `Bearer ${tokenNoClinic}` },
      });
      assert.equal(res.status, 403, `${ep} must return 403 when clinic context is missing`);
      const body = await res.json();
      assert.match(body.error, /Clinic not assigned/);
    }
  });

  test('Token with clinic: "default" returns HTTP 403 across protected endpoints', async () => {
    const endpoints = [
      '/api/appointments',
      '/api/calls',
      '/api/doctors',
    ];

    for (const ep of endpoints) {
      const res = await fetch(`${baseUrl}${ep}`, {
        headers: { Authorization: `Bearer ${tokenDefaultClinic}` },
      });
      assert.equal(res.status, 403, `${ep} must return 403 when clinic is 'default'`);
    }
  });

  test('Unauthenticated requests to protected endpoints return HTTP 401', async () => {
    const endpoints = ['/api/appointments', '/api/calls', '/api/doctors'];
    for (const ep of endpoints) {
      const res = await fetch(`${baseUrl}${ep}`);
      assert.equal(res.status, 401, `${ep} must return 401 when unauthenticated`);
    }
  });

  test('POST /api/appointments: booking with Clinic A doctor succeeds (201)', async () => {
    const res = await fetch(`${baseUrl}/api/appointments`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokenA}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'Valid Patient A',
        phone: '+91 98888 11111',
        date: '28/12/2026',
        time_slot: 'Morning 10:00',
        reason: 'Consultation',
        doctorId: doctorA._id,
      }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.status, 'Confirmed');
    assert.equal(body.clinic, CLINIC_A);
    assert.equal(body.doctorId, doctorA._id);
  });

  test('POST /api/appointments: booking with Clinic B doctor is rejected (400)', async () => {
    const res = await fetch(`${baseUrl}/api/appointments`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokenA}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'Intruder Patient',
        phone: '+91 98888 22222',
        date: '28/12/2026',
        time_slot: 'Morning 10:00',
        reason: 'Consultation',
        doctorId: doctorB._id,
      }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /Doctor not found for this clinic/);
  });

  test('POST /api/appointments: booking with malformed doctor ID is rejected (400)', async () => {
    const res = await fetch(`${baseUrl}/api/appointments`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokenA}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'Invalid Doctor Id Patient',
        phone: '+91 98888 33333',
        date: '28/12/2026',
        time_slot: 'Morning 10:00',
        reason: 'Consultation',
        doctorId: 'nonexistent-doctor-id-999',
      }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /Doctor not found for this clinic/);
  });

  test('POST /api/appointments: request-body clinic spoofing is ignored and forced to token clinic', async () => {
    // Clinic A user supplies clinic: CLINIC_B in the body
    const res = await fetch(`${baseUrl}/api/appointments`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokenA}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'Spoof Test Patient',
        phone: '+91 98888 44444',
        date: '28/12/2026',
        time_slot: 'Morning 11:00',
        reason: 'Spoofing test',
        clinic: CLINIC_B, // Malicious spoof attempt
      }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.clinic, CLINIC_A, 'Created appointment must be assigned to token clinic (Clinic A)');

    // Ensure it is NOT present in Clinic B
    const apptsB = await serverStore.listAppointments({ clinic: CLINIC_B });
    assert.ok(!apptsB.some(a => a._id === body._id), 'Appointment must not appear in Clinic B');
  });
});

// ============================================================================
// 7. DEDICATED MONGODB SUITE (or graceful skip)
// ============================================================================
const mongodbUri = process.env.TEST_MONGODB_URI;
if (mongodbUri && mongodbUri.trim() !== '') {
  const { createMongoStore, ensureIndexes } = require('./store-mongo');
  const mongoose = require('mongoose');
  describe('Tenant Isolation: MongoDB', () => {
    let mongoStore;
    before(async () => {
      await mongoose.connect(mongodbUri, { serverSelectionTimeoutMS: 5000 });
      await ensureIndexes();
      mongoStore = createMongoStore({ maxPerSlot: 1 });
    });
    after(async () => {
      await mongoose.disconnect();
    });
    runTenantIsolationSuite(() => createMongoStore(), 'mongo');

    describe('MongoDB Specific: Atomicity, Slot Caps & Leads', () => {
      beforeEach(async () => {
        const { Appointment, Clinic, Doctor, CallLog, Lead, User, SlotReservation } = require('./store-mongo');
        await Promise.all([
          Appointment.deleteMany({}),
          Clinic.deleteMany({}),
          Doctor.deleteMany({}),
          CallLog.deleteMany({}),
          Lead.deleteMany({}),
          User.deleteMany({}),
          SlotReservation ? SlotReservation.deleteMany({}) : Promise.resolve(),
        ]);
      });

      test('Concurrent duplicate booking: exactly one succeeds and one is rejected', async () => {
        const payload = {
          name: 'Patient Concurrent',
          phone: '+91 99999 88888',
          date: '28/12/2026',
          time_slot: 'Morning 10:00',
          clinic: CLINIC_A,
          status: 'Confirmed',
        };

        const [res1, res2] = await Promise.all([
          mongoStore.createAppointmentIfAvailable(payload, 1),
          mongoStore.createAppointmentIfAvailable(payload, 1),
        ]);

        const successes = [res1, res2].filter(r => r.ok);
        const failures = [res1, res2].filter(r => !r.ok);

        assert.equal(successes.length, 1, 'Exactly one concurrent booking must succeed');
        assert.equal(failures.length, 1, 'Exactly one concurrent booking must fail');
        assert.ok(failures[0].reason === 'duplicate' || failures[0].reason === 'slot_full');

        // Confirm database has exactly one confirmed appointment
        const count = await mongoStore.countBooked({ date: '28/12/2026', time_slot: 'Morning 10:00', clinic: CLINIC_A });
        assert.equal(count, 1);
      });

      test('Slot-cap isolation across tenants: full slot in Clinic A does not block Clinic B', async () => {
        // Book 1 slot in Clinic A (maxPerSlot = 1)
        const resA = await mongoStore.createAppointmentIfAvailable({
          name: 'Patient Alpha',
          phone: '+91 99999 11111',
          date: '28/12/2026',
          time_slot: 'Morning 10:00',
          clinic: CLINIC_A,
          status: 'Confirmed',
        }, 1);
        assert.equal(resA.ok, true);

        // Second booking for Clinic A in same slot fails (slot_full)
        const resA2 = await mongoStore.createAppointmentIfAvailable({
          name: 'Patient Alpha 2',
          phone: '+91 99999 22222',
          date: '28/12/2026',
          time_slot: 'Morning 10:00',
          clinic: CLINIC_A,
          status: 'Confirmed',
        }, 1);
        assert.equal(resA2.ok, false);
        assert.equal(resA2.reason, 'slot_full');

        // Clinic B booking in same date and time slot succeeds
        const resB = await mongoStore.createAppointmentIfAvailable({
          name: 'Patient Beta',
          phone: '+91 99999 33333',
          date: '28/12/2026',
          time_slot: 'Morning 10:00',
          clinic: CLINIC_B,
          status: 'Confirmed',
        }, 1);
        assert.equal(resB.ok, true, 'Clinic B must book successfully despite Clinic A slot being full');
      });

      test('Platform leads and legacy leads are strictly isolated from clinic dashboards', async () => {
        const { Lead } = require('./store-mongo');

        // 1. Raw legacy lead with string clinic
        await Lead.collection.insertOne({
          name: 'Legacy Doctor Lead',
          clinic: 'Legacy City Clinic',
          phone: '+91 98888 11111',
          email: 'legacy@prospect.test',
          message: 'Interested in demo',
          createdAt: new Date(),
        });

        // 2. Modern platform marketing lead
        await mongoStore.createLead({
          name: 'Modern Platform Lead',
          clinic_name: 'Modern Dental Care',
          clinic: null,
          scope: 'platform',
          phone: '+91 98888 22222',
          email: 'modern@prospect.test',
          message: 'Please call me',
        });

        // 3. Clinic-owned lead
        await mongoStore.createLead({
          name: 'Clinic A Patient Enquiry',
          clinic: CLINIC_A,
          scope: 'clinic',
          phone: '+91 98888 33333',
          email: 'patient@clinic-a.test',
        });

        // Clinic A listing must only see Clinic A lead
        const clinicLeads = await mongoStore.listLeads({ clinic: CLINIC_A });
        assert.equal(clinicLeads.length, 1);
        assert.equal(clinicLeads[0].name, 'Clinic A Patient Enquiry');
        assert.equal(String(clinicLeads[0].clinic), CLINIC_A);

        // Platform leads query must see both modern and legacy prospect leads
        const platformLeads = await mongoStore.listPlatformLeads();
        assert.equal(platformLeads.length, 2);
        const legacyDoc = platformLeads.find(l => l.name === 'Legacy Doctor Lead');
        assert.ok(legacyDoc);
        assert.equal(legacyDoc.clinic_name, 'Legacy City Clinic');
        assert.equal(legacyDoc.clinic, null);
        assert.equal(legacyDoc.scope, 'platform');

        const modernDoc = platformLeads.find(l => l.name === 'Modern Platform Lead');
        assert.ok(modernDoc);
        assert.equal(modernDoc.clinic_name, 'Modern Dental Care');
        assert.equal(modernDoc.clinic, null);
      });
    });
  });
} else {
  describe('Tenant Isolation: MongoDB (skipped - no TEST_MONGODB_URI)', () => {
    test('skipped gracefully when TEST_MONGODB_URI is not set', (t) => {
      t.skip('Set TEST_MONGODB_URI to run multi-tenant tests against dedicated MongoDB database');
    });
  });
}
