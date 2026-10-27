'use strict';
/* ==========================================================================
 * test-indexes.js - MongoDB index enforcement & duplicate safety (item 2).
 *
 * Verifies that:
 * 1. ensureIndexes() detects existing duplicate Confirmed appointments and aborts.
 * 2. ensureIndexes() creates the unique partial index and token TTL index.
 * 3. The unique partial index enforces slot safety directly at the MongoDB level.
 * 4. Duplicate Confirmed appointments cause startup failure (STORE=mongo/prod).
 *
 *   node --test test-indexes.js
 * ========================================================================== */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const mongoose = require('mongoose');

const { createFileStore } = require('./store-file');
const { createMongoStore, ensureIndexes, Appointment, TokenBlocklist } = require('./store-mongo');

// ---------------------------------------------------------------------------
// 1. File store unit tests (in-memory / file-store parity)
// ---------------------------------------------------------------------------
test('file store allows duplicate Confirmed appointments at createAppointment level (uniqueness enforced by createAppointmentIfAvailable)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'medibot-index-'));
  const file = path.join(dir, 'store.json');

  try {
    const store = createFileStore(file);

    const appt1 = await store.createAppointment({
      name: 'Asha', phone: '+91 90000 00001', date: '2026-06-24',
      time_slot: 'Morning 10:00', reason: 'tooth', status: 'Confirmed',
    });
    assert.ok(appt1.ok || appt1._id, 'first appointment created');

    const appt2 = await store.createAppointment({
      name: 'Bee', phone: '+91 90000 00001', date: '2026-06-24',
      time_slot: 'Morning 10:00', reason: 'checkup', status: 'Confirmed',
    });
    assert.ok(appt2.ok || appt2._id, 'createAppointment allows duplicates (no index enforcement)');

    const third = await store.createAppointmentIfAvailable({
      name: 'Cee', phone: '+91 90000 00001', date: '2026-06-24',
      time_slot: 'Morning 10:00', reason: 'followup', status: 'Confirmed',
    });
    assert.equal(third.ok, false, 'createAppointmentIfAvailable rejects duplicate');
    assert.equal(third.reason, 'duplicate', 'reason is duplicate');

    const appt4 = await store.createAppointment({
      name: 'Dee', phone: '+91 90000 00001', date: '2026-06-24',
      time_slot: 'Morning 10:00', reason: 'x-ray', status: 'Incomplete',
    });
    assert.ok(appt4.ok || appt4._id, 'non-Confirmed allowed');

    const appt5 = await store.createAppointment({
      name: 'Eee', phone: '+91 90000 00001', date: '2026-06-24',
      time_slot: 'Afternoon 14:00', reason: 'cleaning', status: 'Confirmed',
    });
    assert.ok(appt5.ok || appt5._id, 'different time_slot allowed');

    const appt6 = await store.createAppointment({
      name: 'Fff', phone: '+91 90000 00001', date: '2026-06-25',
      time_slot: 'Morning 10:00', reason: 'x-ray', status: 'Confirmed',
    });
    assert.ok(appt6.ok || appt6._id, 'different date allowed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('createAppointmentIfAvailable detects duplicate Confirmed appointments', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'medibot-index-'));
  const file = path.join(dir, 'store.json');

  try {
    const store = createFileStore(file);

    const first = await store.createAppointmentIfAvailable({
      name: 'Asha', phone: '+91 90000 00001', date: '2026-06-24',
      time_slot: 'Morning 10:00', reason: 'tooth', status: 'Confirmed',
    });
    assert.equal(first.ok, true, 'first booking succeeds');

    const second = await store.createAppointmentIfAvailable({
      name: 'Bee', phone: '+91 90000 00001', date: '2026-06-24',
      time_slot: 'Morning 10:00', reason: 'checkup', status: 'Confirmed',
    });
    assert.equal(second.ok, false, 'second booking for same slot rejected');
    assert.equal(second.reason, 'duplicate', 'reason is duplicate');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ensureIndexes is exported from store-mongo module', () => {
  const src = fs.readFileSync(path.join(__dirname, 'store-mongo.js'), 'utf8');
  assert.ok(src.includes('async function ensureIndexes()'),
    'ensureIndexes function defined in store-mongo.js');
  assert.ok(src.includes('module.exports = { createMongoStore, ensureIndexes'),
    'ensureIndexes exported from store-mongo.js');
});

test('server.js calls ensureIndexes before accepting traffic', () => {
  const src = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  assert.ok(src.includes('await ensureIndexes()'),
    'server.js awaits ensureIndexes()');
  assert.ok(src.includes('indexes verified'),
    'server.js logs index verification');
});

// ---------------------------------------------------------------------------
// 2. Targeted MongoDB integration tests: index creation, duplicates, startup failure
// ---------------------------------------------------------------------------
const MONGO_TEST_URI = 'mongodb://127.0.0.1:27017/medibot-test-indexes';

test('ensureIndexes detects duplicate Confirmed appointments and aborts without altering data', async () => {
  await mongoose.connect(MONGO_TEST_URI, { serverSelectionTimeoutMS: 5000 });

  try {
    // Drop indexes and clear collection
    try { await Appointment.collection.dropIndexes(); } catch {}
    await Appointment.deleteMany({});

    // Seed duplicate Confirmed appointments directly into collection
    await Appointment.collection.insertMany([
      { name: 'Patient A', phone: '+91 99999 11111', date: '2026-06-24', time_slot: 'Morning 10:00', status: 'Confirmed', createdAt: new Date() },
      { name: 'Patient B', phone: '+91 99999 11111', date: '2026-06-24', time_slot: 'Morning 10:00', status: 'Confirmed', createdAt: new Date() },
    ]);

    // Calling ensureIndexes must fail fast and report duplicates
    await assert.rejects(
      async () => { await ensureIndexes(); },
      (err) => {
        assert.ok(
          err.message.includes('Duplicate Confirmed appointments found before creating unique index'),
          'error message mentions duplicate detection'
        );
        assert.ok(
          err.message.includes('phone=+91 99999 11111') && err.message.includes('Morning 10:00'),
          'error message provides detailed duplicate info for manual resolution: ' + err.message
        );
        return true;
      }
    );

    // Verify existing duplicate documents were NOT mutated or dropped
    const count = await Appointment.countDocuments({ phone: '+91 99999 11111' });
    assert.equal(count, 2, 'ensureIndexes must not delete or alter duplicate data');
  } finally {
    await Appointment.deleteMany({});
    await mongoose.disconnect();
  }
});

test('ensureIndexes creates unique partial index and token TTL index when clean', async () => {
  await mongoose.connect(MONGO_TEST_URI, { serverSelectionTimeoutMS: 5000 });

  try {
    try { await Appointment.collection.dropIndexes(); } catch {}
    await Appointment.deleteMany({});
    await TokenBlocklist.deleteMany({});

    await ensureIndexes();

    // Verify Appointment unique partial index
    const apptIndexes = await Appointment.collection.indexes();
    const uniquePartial = apptIndexes.find((idx) =>
      idx.unique === true &&
      idx.partialFilterExpression &&
      idx.partialFilterExpression.status === 'Confirmed' &&
      idx.key.phone === 1 &&
      idx.key.date === 1 &&
      idx.key.time_slot === 1
    );
    assert.ok(uniquePartial, 'unique partial index exists on phone + date + time_slot for Confirmed status');

    // Verify TokenBlocklist TTL index
    const tokenIndexes = await TokenBlocklist.collection.indexes();
    const ttlIndex = tokenIndexes.find((idx) => idx.key.expiresAt === 1 && idx.expireAfterSeconds === 0);
    assert.ok(ttlIndex, 'TTL index exists on TokenBlocklist.expiresAt with expireAfterSeconds: 0');
  } finally {
    await Appointment.deleteMany({});
    await TokenBlocklist.deleteMany({});
    await mongoose.disconnect();
  }
});

test('unique partial index rejects duplicate Confirmed appointments at MongoDB level', async () => {
  await mongoose.connect(MONGO_TEST_URI, { serverSelectionTimeoutMS: 5000 });

  try {
    await Appointment.deleteMany({});
    await ensureIndexes();

    const store = createMongoStore();

    // 1. First Confirmed appointment succeeds
    const appt1 = await store.createAppointment({
      name: 'First Caller', phone: '+91 99999 22222', date: '2026-06-24',
      time_slot: 'Morning 10:00', status: 'Confirmed', reason: 'Fever',
    });
    assert.ok(appt1._id, 'first Confirmed appointment created');

    // 2. Direct duplicate Confirmed appointment is rejected with E11000
    await assert.rejects(
      async () => {
        await Appointment.create({
          name: 'Duplicate Caller', phone: '+91 99999 22222', date: '2026-06-24',
          time_slot: 'Morning 10:00', status: 'Confirmed', reason: 'Cough',
        });
      },
      (err) => {
        return err.code === 11000 || (err.message && err.message.includes('E11000'));
      },
      'database-level unique index must reject duplicate Confirmed appointment with E11000'
    );

    // 3. Non-Confirmed appointment (e.g. Incomplete) for same slot is allowed by partial filter
    const incomplete = await store.createAppointment({
      name: 'Partial Caller', phone: '+91 99999 22222', date: '2026-06-24',
      time_slot: 'Morning 10:00', status: 'Incomplete', reason: 'Hung up',
    });
    assert.ok(incomplete._id, 'Incomplete status allowed for same slot');

    // 4. Confirmed appointment for different time_slot is allowed
    const otherSlot = await store.createAppointment({
      name: 'Evening Caller', phone: '+91 99999 22222', date: '2026-06-24',
      time_slot: 'Evening 17:00', status: 'Confirmed', reason: 'Checkup',
    });
    assert.ok(otherSlot._id, 'different time_slot allowed');
  } finally {
    await Appointment.deleteMany({});
    await mongoose.disconnect();
  }
});

test('server startup fails closed if index creation fails due to duplicates', async () => {
  await mongoose.connect(MONGO_TEST_URI, { serverSelectionTimeoutMS: 5000 });

  try {
    try { await Appointment.collection.dropIndexes(); } catch {}
    await Appointment.deleteMany({});

    // Seed duplicate Confirmed appointments into collection
    await Appointment.collection.insertMany([
      { name: 'Patient 1', phone: '+91 99999 33333', date: '2026-06-24', time_slot: 'Morning 10:00', status: 'Confirmed', createdAt: new Date() },
      { name: 'Patient 2', phone: '+91 99999 33333', date: '2026-06-24', time_slot: 'Morning 10:00', status: 'Confirmed', createdAt: new Date() },
    ]);
  } finally {
    await mongoose.disconnect();
  }

  // Spawn server with STORE=mongo
  const res = spawnSync(process.execPath, [path.join(__dirname, 'server.js')], {
    env: Object.assign({}, process.env, {
      PORT: '0',
      STORE: 'mongo',
      MONGODB_URI: MONGO_TEST_URI,
      TWILIO_VALIDATE_SIGNATURE: 'false',
    }),
    encoding: 'utf8',
    timeout: 10000,
  });

  assert.equal(res.status, 1, 'server must exit with status 1 on index check failure');
  assert.ok(
    res.stderr.includes('Index check failed') || res.stderr.includes('Duplicate Confirmed appointments found'),
    'stderr confirms index check failure: ' + res.stderr
  );

  // Clean up
  await mongoose.connect(MONGO_TEST_URI, { serverSelectionTimeoutMS: 5000 });
  await Appointment.deleteMany({});
  await mongoose.disconnect();
});
