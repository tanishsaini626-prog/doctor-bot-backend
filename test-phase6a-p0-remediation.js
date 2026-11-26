'use strict';
/**
 * test-phase6a-p0-remediation.js — Verification Suite for Phase 6A P0 Remediation
 * -----------------------------------------------------------------------------
 * Validates:
 * 1. P0-1 Transaction Fail-Closed:
 *    - Successful multi-document transaction commits atomically.
 *    - Aborted transaction rolls back 100% cleanly.
 *    - Transaction failure throws TRANSACTION_FAILED and NEVER falls back to fn(null) or silent writes.
 * 2. P0-2 Process Crash Handling & Safe Shutdown:
 *    - Graceful shutdown closes HTTP server and MongoDB connection idempotently.
 *    - Uncaught exception in child process logs FATAL error and exits with code 1.
 *    - Unhandled rejection in child process logs FATAL error and exits with code 1.
 *    - Express error middleware sanitizes 500 errors and does not expose stack traces to clients.
 * 3. P0-3 MongoDB Lifecycle Monitoring:
 *    - /api/health/ready returns 200 when MongoDB is connected.
 *    - /api/health/ready returns 503 unready when MongoDB is disconnected.
 *    - /api/health/ready returns 200 ready when reconnected (healthy -> unready -> healthy).
 * 4. Cancellation Quota Policy A:
 *    - Cancelling an appointment frees SlotReservation.booked (-1).
 *    - Monthly booking quota (ClinicUsage.booking_count) remains consumed.
 *    - Historical appointment remains preserved with status 'Cancelled'.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const mongoose = require('mongoose');

const TEST_DB_URI = process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27018/medibot_test_p0?replicaSet=rs0';
process.env.NODE_ENV = 'test';
process.env.TEST_MONGODB_URI = TEST_DB_URI;
process.env.MONGODB_URI = TEST_DB_URI;
process.env.STORE = 'mongo';
process.env.PORT = '0';
process.env.JWT_SECRET = 'medibot-ephemeral-jwt-secret-phase6a-min32chars';

const serverApp = require('./server');
const {
  createMongoStore,
  ensureIndexes,
  withTransaction,
  Appointment,
  SlotReservation,
  ClinicUsage,
  Clinic,
} = require('./store-mongo');

describe('MediBot Phase 6A: P0 Remediation Verification', () => {
  let serverInstance;
  let baseUrl;
  let testStore;
  const testClinicId = new mongoose.Types.ObjectId();

  before(async () => {
    if (serverApp.locals && serverApp.locals.storeReadyPromise) {
      await serverApp.locals.storeReadyPromise;
    }
    testStore = serverApp.locals.store;

    if (mongoose.connection.readyState !== 1) {
      await mongoose.connect(TEST_DB_URI, { serverSelectionTimeoutMS: 5000 });
    }
    await ensureIndexes();

    await Promise.all([
      Appointment.deleteMany({}),
      SlotReservation.deleteMany({}),
      ClinicUsage.deleteMany({}),
      Clinic.deleteMany({}),
    ]);

    await new Promise((resolve) => {
      serverInstance = serverApp.listen(0, '127.0.0.1', () => {
        baseUrl = `http://127.0.0.1:${serverInstance.address().port}`;
        resolve();
      });
    });
  });

  after(async () => {
    if (serverApp && serverApp.locals && typeof serverApp.locals.shutdownLocalVoice === 'function') {
      try { serverApp.locals.shutdownLocalVoice(); } catch (_) {}
    }
    if (serverInstance) {
      if (typeof serverInstance.closeAllConnections === 'function') {
        try { serverInstance.closeAllConnections(); } catch (_) {}
      }
      await new Promise((resolve) => {
        try {
          serverInstance.close(() => resolve());
        } catch (_) {
          resolve();
        }
      });
    }
    if (mongoose.connection && mongoose.connection.readyState !== 0) {
      try { await mongoose.connection.close(true); } catch (_) {}
    }
    setTimeout(() => process.exit(0), 200);
  });

  // --------------------------------------------------------------------------
  // P0-1: Transaction Fail-Closed
  // --------------------------------------------------------------------------
  describe('P0-1: Transaction Fail-Closed Behavior', () => {
    test('1.1 Multi-document transaction commit succeeds atomically', async () => {
      const uniqueSlot = `slot_tx_commit_${Date.now()}`;
      const result = await withTransaction(async (session) => {
        const slot = await SlotReservation.create(
          [{ _id: uniqueSlot, clinic: testClinicId, date: '2026-06-25', time_slot: '10:00', booked: 1 }],
          { session }
        );
        const appt = await Appointment.create(
          [{ name: 'Patient Tx', phone: '+919999900001', date: '2026-06-25', time_slot: '10:00', clinic: testClinicId, status: 'Confirmed' }],
          { session }
        );
        return { slot: slot[0], appt: appt[0] };
      });

      assert.ok(result.slot);
      assert.ok(result.appt);

      const foundSlot = await SlotReservation.findById(uniqueSlot).lean();
      const foundAppt = await Appointment.findById(result.appt._id).lean();
      assert.equal(foundSlot.booked, 1);
      assert.equal(foundAppt.name, 'Patient Tx');
    });

    test('1.2 Multi-document transaction abort rolls back all writes cleanly', async () => {
      const uniqueSlot = `slot_tx_abort_${Date.now()}`;
      let caught = false;

      try {
        await withTransaction(async (session) => {
          await SlotReservation.create(
            [{ _id: uniqueSlot, clinic: testClinicId, date: '2026-06-26', time_slot: '11:00', booked: 1 }],
            { session }
          );
          await Appointment.create(
            [{ name: 'Patient Abort', phone: '+919999900002', date: '2026-06-26', time_slot: '11:00', clinic: testClinicId, status: 'Confirmed' }],
            { session }
          );
          throw new Error('Simulated mid-transaction failure');
        });
      } catch (err) {
        caught = true;
        assert.equal(err.message, 'Simulated mid-transaction failure');
      }

      assert.ok(caught, 'Expected error was thrown');
      const foundSlot = await SlotReservation.findById(uniqueSlot).lean();
      const foundAppt = await Appointment.findOne({ phone: '+919999900002' }).lean();
      assert.equal(foundSlot, null, 'SlotReservation must be rolled back');
      assert.equal(foundAppt, null, 'Appointment must be rolled back');
    });

    test('1.3 Transaction failure throws TRANSACTION_FAILED and NEVER silently writes', async () => {
      const originalStartSession = mongoose.startSession;
      let fallbackAttempted = false;

      mongoose.startSession = async () => {
        throw new Error('Simulated replica set election in progress');
      };

      try {
        await withTransaction(async () => {
          fallbackAttempted = true;
          return { ok: true };
        });
        assert.fail('Should not succeed when startSession fails');
      } catch (err) {
        assert.equal(err.code, 'TRANSACTION_FAILED');
        assert.match(err.message, /Transaction start failed/);
      } finally {
        mongoose.startSession = originalStartSession;
      }

      assert.equal(fallbackAttempted, false, 'withTransaction MUST NEVER execute fn(null) or fallback silently');
    });
  });

  // --------------------------------------------------------------------------
  // P0-2: Process Crash Handling & Safe Shutdown
  // --------------------------------------------------------------------------
  describe('P0-2: Process Crash Handling & Error Sanitization', () => {
    test('2.1 Graceful shutdown is idempotent and closes server safely', async () => {
      const mockServer = {
        close: (cb) => setTimeout(cb, 10),
        closeIdleConnections: () => {},
      };

      const res1 = await serverApp.gracefulShutdown(mockServer, { exit: false, signal: 'SIGTERM', timeoutMs: 1000, closeDatabase: false });
      assert.equal(res1.ok, true);

      // Call again while already shutting down
      const res2 = await serverApp.gracefulShutdown(mockServer, { exit: false, signal: 'SIGTERM', timeoutMs: 1000, closeDatabase: false });
      assert.equal(res2.ok, false);
      assert.equal(res2.alreadyShuttingDown, true);

      serverApp.resetShutdownForTests();
    });

    test('2.2 Child process handles uncaughtException with fatal log and exit code 1', async () => {
      const childCode = `
        const serverApp = require('./server');
        const mockHttp = { close: (cb) => cb(), closeIdleConnections: () => {} };
        serverApp.setupProcessLifecycle(mockHttp, { exitOnFatal: true });
        setTimeout(() => {
          throw new Error('Simulated Uncaught Exception in worker');
        }, 50);
      `;

      const child = spawn(process.execPath, ['-e', childCode], {
        cwd: __dirname,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stderr = '';
      child.stderr.on('data', (d) => { stderr += d.toString(); });

      const exitCode = await new Promise((resolve) => child.on('exit', resolve));
      assert.equal(exitCode, 1, 'Child process must exit with non-zero exit code 1');
      assert.match(stderr, /FATAL \[uncaughtException\]/, 'Fatal error must be logged to stderr');
      assert.match(stderr, /Simulated Uncaught Exception in worker/);
    });

    test('2.3 Child process handles unhandledRejection with fatal log and exit code 1', async () => {
      const childCode = `
        const serverApp = require('./server');
        const mockHttp = { close: (cb) => cb(), closeIdleConnections: () => {} };
        serverApp.setupProcessLifecycle(mockHttp, { exitOnFatal: true });
        setTimeout(() => {
          Promise.reject(new Error('Simulated Unhandled Promise Rejection in worker'));
        }, 50);
      `;

      const child = spawn(process.execPath, ['-e', childCode], {
        cwd: __dirname,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stderr = '';
      child.stderr.on('data', (d) => { stderr += d.toString(); });

      const exitCode = await new Promise((resolve) => child.on('exit', resolve));
      assert.equal(exitCode, 1, 'Child process must exit with non-zero exit code 1');
      assert.match(stderr, /FATAL \[unhandledRejection\]/, 'Fatal rejection must be logged to stderr');
      assert.match(stderr, /Simulated Unhandled Promise Rejection in worker/);
    });

    test('2.4 Express error middleware sanitizes 500 errors and does not expose stack traces to client', async () => {
      const res = await fetch(`${baseUrl}/api/test/sanitized-error`);
      assert.equal(res.status, 500);
      const data = await res.json();
      assert.equal(data.error, 'Internal server error', 'Must NOT leak internal message');
      assert.equal(data.code, 'INTERNAL_SERVER_ERROR');
      assert.equal(data.stack, undefined, 'Stack trace must NEVER be sent to client');
    });
  });

  // --------------------------------------------------------------------------
  // P0-3: MongoDB Lifecycle Monitoring
  // --------------------------------------------------------------------------
  describe('P0-3: MongoDB Lifecycle Monitoring & Readiness', () => {
    test('3.1 /api/health/ready returns 200 ready when MongoDB is connected', async () => {
      const res = await fetch(`${baseUrl}/api/health/ready`);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.ready, true);
      assert.equal(data.status, 'ready');
      assert.equal(data.database, 'connected');
    });

    test('3.2 /api/health/ready returns 503 unready when MongoDB is disconnected, and recovers', async () => {
      // Temporarily mock readyState to 0 (disconnected)
      const originalReadyState = mongoose.connection.readyState;
      Object.defineProperty(mongoose.connection, 'readyState', { value: 0, configurable: true });

      try {
        const resUnready = await fetch(`${baseUrl}/api/health/ready`);
        assert.equal(resUnready.status, 503);
        const dataUnready = await resUnready.json();
        assert.equal(dataUnready.ready, false);
        assert.equal(dataUnready.status, 'unready');
        assert.equal(dataUnready.database, 'disconnected');
      } finally {
        // Restore readyState to 1 (connected)
        Object.defineProperty(mongoose.connection, 'readyState', { value: originalReadyState, configurable: true });
      }

      // Verify recovery (healthy -> unready -> healthy)
      const resRecovered = await fetch(`${baseUrl}/api/health/ready`);
      assert.equal(resRecovered.status, 200);
      const dataRecovered = await resRecovered.json();
      assert.equal(dataRecovered.ready, true);
      assert.equal(dataRecovered.database, 'connected');
    });
  });

  // --------------------------------------------------------------------------
  // Cancellation Quota Policy A Verification
  // --------------------------------------------------------------------------
  describe('Cancellation Quota Policy A Enforcement', () => {
    test('4.1 Cancelling appointment frees slot capacity, preserves consumed quota, keeps appointment record', async () => {
      const clinicA = new mongoose.Types.ObjectId();
      const bookingDate = '2026-07-10';
      const slotTime = '11:00';
      const slotKey = `${clinicA}:${bookingDate}:${slotTime}`;
      const billingMonth = '2026-07';

      // 1. Book an appointment
      const bookRes = await testStore.createAppointmentIfAvailable({
        name: 'Suresh Kumar',
        phone: '+919876543210',
        date: bookingDate,
        time_slot: slotTime,
        time_slot_display: slotTime,
        status: 'Confirmed',
        clinic: clinicA,
      }, 1);

      assert.equal(bookRes.ok, true);
      const apptId = bookRes.appointment._id;

      // Simulate quota tracking for booking
      await testStore.recordClinicUsage(clinicA, billingMonth, { booking_count: 1 });

      // Verify initial state
      const slotBefore = await SlotReservation.findById(slotKey).lean();
      assert.equal(slotBefore.booked, 1, 'Slot must be booked');

      const usageBefore = await testStore.getClinicUsage(clinicA, billingMonth);
      assert.equal(usageBefore.booking_count, 1, 'Booking quota must be 1');

      // 2. Cancel the appointment via updateAppointmentStatus
      const updated = await testStore.updateAppointmentStatus(apptId, 'Cancelled', { clinic: clinicA });
      assert.equal(updated.status, 'Cancelled');

      // 3. Verify Policy A Invariants:
      // Invariant 1: Slot reservation freed for new patients
      const slotAfter = await SlotReservation.findById(slotKey).lean();
      assert.equal(slotAfter.booked, 0, 'SlotReservation MUST be freed on cancellation');

      // Invariant 2: Monthly booking quota remains consumed (NO refund)
      const usageAfter = await testStore.getClinicUsage(clinicA, billingMonth);
      assert.equal(usageAfter.booking_count, 1, 'Booking quota MUST remain consumed (Policy A)');

      // Invariant 3: Historical appointment preserved
      const apptRecord = await testStore.getAppointment(apptId, { clinic: clinicA });
      assert.ok(apptRecord, 'Appointment document MUST NOT be deleted');
      assert.equal(apptRecord.status, 'Cancelled', 'Status must be Cancelled in historical record');

      // Invariant 4: New patient can now book the freed slot
      const newBookRes = await testStore.createAppointmentIfAvailable({
        name: 'Anita Verma',
        phone: '+919876543211',
        date: bookingDate,
        time_slot: slotTime,
        time_slot_display: slotTime,
        status: 'Confirmed',
        clinic: clinicA,
      }, 1);

      assert.equal(newBookRes.ok, true, 'Freed slot must be bookable by another patient');
      const slotRefilled = await SlotReservation.findById(slotKey).lean();
      assert.equal(slotRefilled.booked, 1);
    });
  });
});
