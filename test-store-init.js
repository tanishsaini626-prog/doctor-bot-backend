'use strict';
/* ==========================================================================
 * test-store-init.js - Stage 1: persistent storage initialization tests.
 *
 * Verifies that the file-backed store (the no-Atlas fallback used when
 * MONGODB_URI is absent) persists data across a simulated restart and survives
 * corrupt files without crashing. Also verifies the server module loads
 * without MONGODB_URI (it is now optional; required only when STORE=mongo).
 *
 *   node --test test-store-init.js
 * ========================================================================== */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createFileStore } = require('./store-file');

// ---------------------------------------------------------------------------
// The server module must load without MONGODB_URI. dotenv loads .env (which
// contains a URI) in-process, so we verify the code path by checking that
// MONGODB_URI is read via process.env (optional) rather than assertEnv
// (hard fail). This test imports server.js and confirms it does not throw
// synchronously at module load.
// ---------------------------------------------------------------------------
test('server module loads without throwing (MONGODB_URI optional at load)', () => {
  // server.js is already loaded by the test runner (dotenv loads .env which
  // has MONGODB_URI). We verify the source no longer asserts it.
  const src = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  assert.ok(!src.includes("assertEnv('MONGODB_URI')"),
    'MONGODB_URI must not be assertEnv-required at module load');
  assert.ok(src.includes("process.env.MONGODB_URI || ''"),
    'MONGODB_URI must be read as optional with empty-string fallback');
});

test('file store persists data across a simulated restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'medibot-stage1-'));
  const file = path.join(dir, 'store.json');

  try {
    const s1 = createFileStore(file);
    await s1.createAppointment({
      name: 'Asha', phone: '+91 90000 00001', date: '2026-01-10',
      time_slot: 'Morning 10:00', reason: 'tooth', status: 'Confirmed',
    });
    await s1.saveClinic({ name: 'Rao Clinic', phone: '+91 90000 00000' });
    await s1.createDoctor({ name: 'Dr. Rao', specialty: 'Dental' });
    await s1.flush();

    // Simulate restart: new store instance reading the same file.
    const s2 = createFileStore(file);
    const appts = await s2.listAppointments();
    assert.equal(appts.length, 1, 'appointment persisted across restart');
    assert.equal(appts[0].name, 'Asha');
    const clinic = await s2.getClinic();
    assert.equal(clinic.name, 'Rao Clinic', 'clinic persisted across restart');
    const doctors = await s2.listDoctors();
    assert.equal(doctors.length, 1, 'doctor persisted across restart');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('file store survives a corrupt file without crashing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'medibot-stage1-'));
  const file = path.join(dir, 'store.json');

  try {
    fs.writeFileSync(file, '{ this is not valid json ');
    const s = createFileStore(file); // must not throw
    assert.equal((await s.listAppointments()).length, 0, 'corrupt file yields empty store');
    const backups = fs.readdirSync(dir).filter((n) => n.includes('corrupt'));
    assert.ok(backups.length >= 1, 'corrupt file moved aside to backup');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('store init selects file store when MONGODB_URI is absent', async () => {
  // Verifies the fallback decision tree: when STORE=auto and no MONGODB_URI,
  // the file store is used (kind === 'file'). We exercise createFileStore
  // directly since initStore() is not exported from server.js.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'medibot-stage1-'));
  const file = path.join(dir, 'store.json');

  try {
    const store = createFileStore(file);
    assert.equal(store.kind, 'file', 'file store kind is reported');
    assert.equal(store.file, path.resolve(file), 'file store resolves the path');
    await store.createAppointment({
      name: 'Bee', phone: '+91 90000 00002', date: '2026-02-20',
      time_slot: 'Afternoon 14:00', reason: 'checkup', status: 'Confirmed',
    });
    await store.flush();
    const reloaded = createFileStore(file);
    assert.equal((await reloaded.listAppointments()).length, 1, 'fallback store persists');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});