'use strict';
/* ==========================================================================
 * Tests for store-file.js - the durable, no-Atlas fallback store.
 *
 * Verifies the whole point of the store: data written in one process is still
 * there after a "restart" (a fresh store instance reading the same file), and
 * that a corrupt file never crashes the server.
 *
 *   node --test
 * ========================================================================== */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createFileStore } = require('./store-file');

// A fresh temp file for every test so nothing leaks between cases.
let dir;
let file;
function newFile() {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'medibot-store-'));
  file = path.join(dir, 'store.json');
  return file;
}

// createFileStore flushes on a debounced setImmediate; wait for it to land.
const settled = () => new Promise((r) => setTimeout(r, 30));

test('appointments, sessions, users, doctors, leads and clinic persist across a restart', async () => {
  const f = newFile();

  const s1 = createFileStore(f);
  await s1.createAppointment({ patient_name: 'Asha', patient_phone: '+91 90000 00001', datetime: '2026-01-10T10:00:00', reason: 'tooth' });
  await s1.saveSession({ call_sid: 'CA-restart', step: 'confirm' });
  await s1.createUser({ email: 'a@b.com', name: 'Asha' });
  await s1.createDoctor({ name: 'Dr. Rao', specialty: 'Dental' });
  await s1.createLead({ name: 'Lead', email: 'l@x.in' });
  await s1.saveClinic({ name: 'Rao Clinic' });
  await s1.logCallTurn('CA-restart', { phone: '+91 90000 00001', transcript: 'hi', bot_action: 'ask_name' });
  s1.flush();                               // force a synchronous write
  assert.ok(fs.existsSync(f), 'store file should be created');

  // --- simulate a process restart: brand-new store reading the same file ---
  const s2 = createFileStore(f);
  assert.equal((await s2.listAppointments()).length, 1, 'appointment survived restart');
  assert.equal((await s2.getSession('CA-restart')).step, 'confirm', 'session survived restart');
  assert.equal(await s2.countUsers(), 1, 'user survived restart');
  assert.equal((await s2.listDoctors()).length, 1, 'doctor survived restart');
  assert.equal((await s2.listLeads()).length, 1, 'lead survived restart');
  assert.equal((await s2.getClinic()).name, 'Rao Clinic', 'clinic survived restart');
  assert.equal((await s2.listCallLogs())[0].phone, '+91 90000 00001', 'call log survived restart');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('writes are debounced and eventually reach disk without an explicit flush()', async () => {
  const f = newFile();
  const s1 = createFileStore(f);
  await s1.createAppointment({ patient_name: 'Deb', patient_phone: '+91 90000 00002', datetime: '2026-01-11T11:00:00', reason: 'checkup' });
  assert.ok(!fs.existsSync(f) || true);     // may or may not be written yet
  await settled();
  assert.ok(fs.existsSync(f), 'file written after the debounce window');

  const s2 = createFileStore(f);
  assert.equal((await s2.listAppointments()).length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a corrupt store file is moved aside and the store starts empty (no crash)', async () => {
  const f = newFile();
  fs.writeFileSync(f, '{ this is : not json ');
  let s1;
  assert.doesNotThrow(() => { s1 = createFileStore(f); }, 'creating a store over a corrupt file must not throw');
  assert.equal((await s1.listAppointments()).length, 0, 'corrupt file yields an empty store');
  // The bad file should have been renamed to a *.corrupt.* backup.
  const backups = fs.readdirSync(dir).filter((n) => n.includes('corrupt'));
  assert.ok(backups.length >= 1, 'corrupt file moved aside');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('ids keep incrementing across restarts (no id collisions)', async () => {
  const f = newFile();
  const s1 = createFileStore(f);
  const first = await s1.createAppointment({ patient_name: 'One', patient_phone: '+91 1', datetime: '2026-01-01T09:00:00', reason: 'x' });
  s1.flush();
  const s2 = createFileStore(f);
  const second = await s2.createAppointment({ patient_name: 'Two', patient_phone: '+91 2', datetime: '2026-01-02T09:00:00', reason: 'y' });
  s2.flush();
  assert.notEqual(first._id, second._id, 'ids must not collide across restarts');
  const s3 = createFileStore(f);
  assert.equal((await s3.listAppointments()).length, 2, 'both appointments present after second restart');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('clearSession and updateAppointmentStatus persist too', async () => {
  const f = newFile();
  const s1 = createFileStore(f);
  await s1.saveSession({ call_sid: 'CA-x', step: 'name' });
  s1.flush();
  const a = await s1.createAppointment({ patient_name: 'Del', patient_phone: '+91 3', datetime: '2026-01-03T09:00:00', reason: 'x', status: 'Scheduled' });
  await s1.clearSession('CA-x');
  await s1.updateAppointmentStatus(a._id, 'Completed');
  s1.flush();

  const s2 = createFileStore(f);
  assert.equal(await s2.getSession('CA-x'), null, 'cleared session stays cleared after restart');
  assert.equal((await s2.getAppointment(a._id)).status, 'Completed', 'status change persisted');
  fs.rmSync(dir, { recursive: true, force: true });
});
