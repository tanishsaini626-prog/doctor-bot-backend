'use strict';
/* ==========================================================================
 * store-file.js - durable file-backed store.
 *
 * Wraps the in-memory store (so all existing tested logic is reused) and
 * persists every change to a JSON file on disk using an atomic
 * temp-write + rename. This removes the "data lost on restart" problem for
 * local runs and single-instance servers *without* requiring MongoDB Atlas.
 *
 * Use when:
 *   - you have not set up Atlas yet,
 *   - you are running a single instance (a VPS, one Docker container, etc).
 * Do NOT rely on it for horizontally-scaled / multi-instance deployments - the
 * file lives on one machine's disk, so use MongoDB (STORE=mongo) for that.
 *
 * Selected via STORE=file, or automatically when STORE=auto and no
 * MONGODB_URI is configured (unless STORE=memory is requested).
 * ========================================================================== */

const fs = require('fs');
const path = require('path');
const { createMemoryStore } = require('./store-memory');

// Methods that change state and therefore must trigger a flush to disk.
const MUTATING = new Set([
  'saveSession', 'clearSession', 'createAppointment', 'updateAppointmentStatus', 'deleteAppointment',
  'createUser', 'updateUserPassword', 'logCallTurn',
  'createDoctor', 'updateDoctor', 'deleteDoctor', 'saveClinic', 'createLead',
  'createTokenBlocklist',
]);

function createFileStore(filePath, options = {}) {
  const resolved = path.resolve(filePath);
  const inner = createMemoryStore(options);

  // ---- load existing state (if the file exists and parses) ---------------
  try {
    if (fs.existsSync(resolved)) {
      const raw = fs.readFileSync(resolved, 'utf8');
      inner.__hydrate(JSON.parse(raw));
    }
  } catch (err) {
    // Never crash boot because of a corrupt/absent file - just start fresh and
    // keep a copy of the bad file so nothing is silently destroyed.
    console.error('store-file: could not read ' + resolved + ' (' + err.message + ')');
    try {
      const backup = resolved + '.corrupt.' + Date.now();
      if (fs.existsSync(resolved)) fs.renameSync(resolved, backup);
      console.error('store-file: moved unreadable file aside to ' + backup);
    } catch (_) { /* best effort */ }
  }

  // ---- atomic, debounced writer ------------------------------------------
  let writing = false;
  let pending = false;
  function flushSync() {
    try {
      const dir = path.dirname(resolved);
      fs.mkdirSync(dir, { recursive: true });
      const tmp = resolved + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(inner.__snapshot()));
      fs.renameSync(tmp, resolved);          // atomic on POSIX and Windows
    } catch (err) {
      console.error('store-file: failed to persist ' + resolved + ': ' + err.message);
    }
  }
  function scheduleFlush() {
    if (writing) { pending = true; return; }
    writing = true;
    // Coalesce a burst of writes into one disk hit, then flush.
    setImmediate(() => {
      writing = false;
      flushSync();
      if (pending) { pending = false; scheduleFlush(); }
    });
  }

  // ---- wrap the delegated interface --------------------------------------
  const store = { kind: 'file', file: resolved, flush: flushSync };
  for (const key of Object.keys(inner)) {
    if (typeof inner[key] !== 'function') continue;         // skip __snapshot/__hydrate/kind
    if (key === '__snapshot' || key === '__hydrate') continue;
    store[key] = async (...args) => {
      const result = await inner[key](...args);
      if (MUTATING.has(key)) scheduleFlush();
      return result;
    };
  }

  // Expose test seams (arrays shared with the inner store, as in memory store).
  store.appointments = inner.appointments;
  store.users = inner.users;
  store.doctors = inner.doctors;
  store.leads = inner.leads;

  return store;
}

module.exports = { createFileStore };
