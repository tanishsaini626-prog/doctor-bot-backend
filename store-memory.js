'use strict';
/* ==========================================================================
 * store-memory.js - in-memory implementation of the same store interface as
 * store-mongo.js. Used for local runs, demos and tests when MongoDB Atlas is
 * not available (or its URI is still a placeholder).
 *
 * Data lives only while the process runs - restarting the server clears it.
 * ========================================================================== */

const { normalizePhone } = require('./phone');
const { DEFAULT_PLANS } = require('./models');

function createMemoryStore(options) {
  const appointments = [];
  const sessions = new Map();
  const users = [];
  const callLogs = new Map();
  const doctors = [];
  const leads = [];
  const clinics = new Map();        // clinicId -> clinicDoc
  const plans = new Map();          // planId -> planDoc
  const clinicUsages = new Map();   // `${clinicId}:${billingMonth}` -> usageDoc
  const usageEvents = new Map();    // eventId -> eventDoc (idempotency ledger)
  const checkoutSessions = new Map(); // sessionId -> sessionDoc
  const paymentEvents = new Map();    // eventId -> paymentEventDoc
  const invoices = new Map();         // invoiceNumber -> invoiceDoc
  let clinic = null;
  let nextId = 1;
  const id = () => 'mem_' + (nextId++);
  const tokenBlocklist = new Map(); // jti -> { expiresAt: Date }
  // Clinic-scoped: key = `clinic-${clinic}||'default':ip-${ip}`
  const loginRateLimit = new Map(); // ip -> { count, reset, clinic }
  const failedLogins = new Map();   // email -> { count, lockedUntil, clinic }

  // Seed default subscription plans
  if (Array.isArray(DEFAULT_PLANS)) {
    for (const p of DEFAULT_PLANS) {
      plans.set(p.plan_id, JSON.parse(JSON.stringify(p)));
    }
  }

  // Track clinic for the store instance if provided
  if (options && options.clinic) clinic = options.clinic;

  // Process-local async mutex. The memory and file stores are single-instance
  // (single process), so a process-local lock is sufficient to make
  // check-then-create atomic within that instance.
  let _busy = false;
  const _waiters = [];
  async function withLock(fn) {
    if (_busy) {
      await new Promise(resolve => _waiters.push(resolve));
    }
    _busy = true;
    try {
      return await fn();
    } finally {
      _busy = false;
      if (_waiters.length) _waiters.shift()();
    }
  }

  const maxPerSlot = (options && options.maxPerSlot != null) ? options.maxPerSlot : 0;

  const clone = (doc) => (doc ? JSON.parse(JSON.stringify(doc)) : doc);

  const DEFAULT_HOURS = [
    { day: 1, start: '09:00', end: '21:00' },
    { day: 2, start: '09:00', end: '21:00' },
    { day: 3, start: '09:00', end: '21:00' },
    { day: 4, start: '09:00', end: '21:00' },
    { day: 5, start: '09:00', end: '21:00' },
    { day: 6, start: '09:00', end: '21:00' },
  ];

  return {
    kind: 'memory',
    appointments,            // exposed for tests
    users,                   // exposed for tests
    doctors,                 // exposed for tests
    leads,                   // exposed for tests
    plans,                   // exposed for tests
    clinicUsages,            // exposed for tests
    usageEvents,             // exposed for tests
    checkoutSessions,        // exposed for tests
    paymentEvents,           // exposed for tests
    invoices,                // exposed for tests
    clinics,                 // exposed for tests

    // --------------------------------------------- persistence seams
    // Used by store-file.js to persist state to disk without duplicating any
    // of the logic above. Not part of the Twilio/API surface.
    __snapshot() {
      return {
        appointments,
        sessions: [...sessions.entries()],   // Map -> array of [key, value]
        users,
        callLogs: [...callLogs.entries()],
        doctors,
        leads,
        clinics: [...clinics.entries()],
        plans: [...plans.entries()],
        clinicUsages: [...clinicUsages.entries()],
        usageEvents: [...usageEvents.entries()],
        checkoutSessions: [...checkoutSessions.entries()],
        paymentEvents: [...paymentEvents.entries()],
        invoices: [...invoices.entries()],
        clinic,
        nextId,
        tokenBlocklist: [...tokenBlocklist.entries()],
        loginRateLimit: [...loginRateLimit.entries()],
        failedLogins: [...failedLogins.entries()],
      };
    },

    __hydrate(snapshot) {
      if (!snapshot || typeof snapshot !== 'object') return;
      if (Array.isArray(snapshot.appointments)) appointments.splice(0, appointments.length, ...snapshot.appointments);
      if (Array.isArray(snapshot.sessions)) {
        sessions.clear();
        for (const [k, v] of snapshot.sessions) sessions.set(k, v);
      }
      if (Array.isArray(snapshot.users)) users.splice(0, users.length, ...snapshot.users);
      if (Array.isArray(snapshot.callLogs)) {
        callLogs.clear();
        for (const [k, v] of snapshot.callLogs) callLogs.set(k, v);
      }
      if (Array.isArray(snapshot.doctors)) doctors.splice(0, doctors.length, ...snapshot.doctors);
      if (Array.isArray(snapshot.leads)) leads.splice(0, leads.length, ...snapshot.leads);
      if (Array.isArray(snapshot.clinics)) {
        clinics.clear();
        for (const [k, v] of snapshot.clinics) clinics.set(k, v);
      } else if (snapshot.clinic && typeof snapshot.clinic === 'object') {
        const legacyId = snapshot.clinic._id || 'clinic_1';
        clinics.set(String(legacyId), snapshot.clinic);
      }
      if (Array.isArray(snapshot.plans)) {
        plans.clear();
        for (const [k, v] of snapshot.plans) plans.set(k, v);
      }
      if (Array.isArray(snapshot.clinicUsages)) {
        clinicUsages.clear();
        for (const [k, v] of snapshot.clinicUsages) clinicUsages.set(k, v);
      }
      if (Array.isArray(snapshot.usageEvents)) {
        usageEvents.clear();
        for (const [k, v] of snapshot.usageEvents) usageEvents.set(k, v);
      }
      if (Array.isArray(snapshot.checkoutSessions)) {
        checkoutSessions.clear();
        for (const [k, v] of snapshot.checkoutSessions) checkoutSessions.set(k, v);
      }
      if (Array.isArray(snapshot.paymentEvents)) {
        paymentEvents.clear();
        for (const [k, v] of snapshot.paymentEvents) paymentEvents.set(k, v);
      }
      if (Array.isArray(snapshot.invoices)) {
        invoices.clear();
        for (const [k, v] of snapshot.invoices) invoices.set(k, v);
      }
      if (snapshot.clinic !== undefined) clinic = snapshot.clinic;
      if (Number.isFinite(snapshot.nextId) && snapshot.nextId > nextId) nextId = snapshot.nextId;
      if (Array.isArray(snapshot.tokenBlocklist)) {
        tokenBlocklist.clear();
        for (const [k, v] of snapshot.tokenBlocklist) tokenBlocklist.set(k, v);
      }
      if (Array.isArray(snapshot.loginRateLimit)) {
        loginRateLimit.clear();
        for (const [k, v] of snapshot.loginRateLimit) loginRateLimit.set(k, v);
      }
      if (Array.isArray(snapshot.failedLogins)) {
        failedLogins.clear();
        for (const [k, v] of snapshot.failedLogins) failedLogins.set(k, v);
      }
    },

    // ---------------------------------------------------------- doctors
    async listDoctors(arg1) {
      let clinic;
      if (arg1 && typeof arg1 === 'object' && !Array.isArray(arg1)) {
        clinic = arg1.clinic;
      } else if (typeof arg1 === 'string') {
        clinic = arg1;
      }
      if (!clinic) {
        throw new Error('clinic is required for listDoctors');
      }
      return doctors.filter(d => d.clinic === clinic).slice().sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))).map(clone);
    },

    async getDoctor(arg1, arg2) {
      let id, clinic;
      if (arg1 && typeof arg1 === 'object' && !Array.isArray(arg1)) {
        id = arg1._id || arg1.id;
        clinic = arg1.clinic || (arg2 && arg2.clinic);
      } else {
        id = arg1;
        clinic = (arg2 && typeof arg2 === 'object') ? arg2.clinic : arg2;
      }
      if (!clinic) {
        throw new Error('clinic is required for getDoctor');
      }
      if (!id) return null;
      return clone(doctors.find(d => d._id === id && d.clinic === clinic)) || null;
    },

    async createDoctor(data, opts) {
      const clinic = (opts && typeof opts === 'object') ? opts.clinic : (opts || (data && data.clinic));
      if (!clinic) {
        throw new Error('clinic is required for createDoctor');
      }
      const doc = Object.assign({
        _id: id(),
        specialty: 'General Physician',
        slot_minutes: 15,
        working_hours: DEFAULT_HOURS,
        holidays: [],
        active: true,
        createdAt: new Date().toISOString(),
        clinic,
      }, data);
      doctors.push(doc);
      return clone(doc);
    },

    async createDoctorIfWithinLimit(data, opts = {}) {
      const clinic = (opts && typeof opts === 'object') ? opts.clinic : (opts || (data && data.clinic));
      if (!clinic) {
        throw new Error('clinic is required for createDoctorIfWithinLimit');
      }
      const maxDoctors = (opts && opts.maxDoctors != null) ? Number(opts.maxDoctors) : Infinity;
      const enforce = !!(opts && opts.enforce);
      const isActiveNew = data.active !== false;

      return withLock(async () => {
        const currentCount = doctors.filter(d => String(d.clinic) === String(clinic) && d.active !== false).length;
        if (enforce && isActiveNew && currentCount >= maxDoctors) {
          return { ok: false, reason: 'quota_exceeded', currentUsage: currentCount, limit: maxDoctors };
        }
        const doc = Object.assign({
          _id: id(),
          specialty: 'General Physician',
          slot_minutes: 15,
          working_hours: DEFAULT_HOURS,
          holidays: [],
          active: true,
          createdAt: new Date().toISOString(),
          clinic,
        }, data, { clinic });
        doctors.push(doc);
        return { ok: true, doctor: clone(doc), currentUsage: currentCount, limit: maxDoctors };
      });
    },

    async updateDoctor(docId, data, opts) {
      const clinic = (opts && typeof opts === 'object') ? opts.clinic : opts;
      if (!clinic) {
        throw new Error('clinic is required for updateDoctor');
      }
      const doc = doctors.find(d => d._id === docId && d.clinic === clinic);
      if (!doc) return null;
      Object.assign(doc, data, { updatedAt: new Date().toISOString() });
      return clone(doc);
    },

    async updateDoctorIfWithinLimit(docId, data, opts = {}) {
      const clinic = (opts && typeof opts === 'object') ? opts.clinic : opts;
      if (!clinic) {
        throw new Error('clinic is required for updateDoctorIfWithinLimit');
      }
      const maxDoctors = (opts && opts.maxDoctors != null) ? Number(opts.maxDoctors) : Infinity;
      const enforce = !!(opts && opts.enforce);

      return withLock(async () => {
        const doc = doctors.find(d => String(d._id) === String(docId) && String(d.clinic) === String(clinic));
        if (!doc) {
          return { ok: false, reason: 'not_found' };
        }
        const isReactivating = doc.active === false && data.active === true;
        if (isReactivating) {
          const currentCount = doctors.filter(d => String(d.clinic) === String(clinic) && d.active !== false).length;
          if (enforce && currentCount >= maxDoctors) {
            return { ok: false, reason: 'quota_exceeded', currentUsage: currentCount, limit: maxDoctors };
          }
          Object.assign(doc, data, { updatedAt: new Date().toISOString() });
          return { ok: true, doctor: clone(doc), currentUsage: currentCount, limit: maxDoctors, reactivated: true };
        }
        Object.assign(doc, data, { updatedAt: new Date().toISOString() });
        return { ok: true, doctor: clone(doc), reactivated: false };
      });
    },

    async deleteDoctor(docId, opts) {
      const clinic = (opts && typeof opts === 'object') ? opts.clinic : opts;
      if (!clinic) {
        throw new Error('clinic is required for deleteDoctor');
      }
      const i = doctors.findIndex(d => d._id === docId && d.clinic === clinic);
      if (i === -1) return false;
      doctors.splice(i, 1);
      return true;
    },

    // ----------------------------------------------------------- clinic
    setClinic(c) {
      clinic = c;
    },

    async getClinic(arg1) {
      const clinicId = (arg1 && typeof arg1 === 'object') ? (arg1.clinic || arg1._id) : arg1;
      if (!clinicId) {
        if (clinic && clinics.size <= 1) return clone(clinic);
        if (clinics.size === 1) return clone(clinics.values().next().value);
        if (clinics.size === 0) return null;
        throw new Error('clinic is required for getClinic');
      }
      const key = String(clinicId);
      const doc = clinics.get(key) || (clinic && (clinic._id === key || clinic === key) ? clinic : null);
      if (doc && (!doc.subscription || !doc.subscription.trial_ends_at)) {
        doc.subscription = {
          status: 'trial',
          plan_id: 'starter_1499',
          trial_ends_at: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
          current_period_start: new Date().toISOString(),
          current_period_end: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
          payment_provider: 'mock',
          customer_id: '',
          subscription_id: '',
          cancel_at_period_end: false,
          canceled_at: null,
        };
        clinics.set(key, doc);
        if (clinic && (clinic._id === key || clinic === key)) clinic = doc;
      }
      return doc ? clone(doc) : null;
    },

    async saveClinic(data, opts) {
      const clinicId = (opts && typeof opts === 'object') ? (opts.clinic || opts._id) : (opts || (data && (data.clinic || data._id)));
      let key;
      if (!clinicId) {
        if (clinics.size === 0 && opts === undefined) {
          key = 'clinic_1';
        } else if (clinic && clinic._id && clinics.size <= 1 && opts === undefined) {
          key = String(clinic._id);
        } else {
          throw new Error('clinic is required for saveClinic');
        }
      } else {
        key = String(clinicId);
      }
      const existing = clinics.get(key) || (clinic && (clinic._id === key || clinic === key) ? clinic : null);
      if (!existing && !(opts && opts.create) && key !== 'clinic_1') {
        // Prevent accidental creation when an unknown clinic ID is supplied
        return null;
      }
      const defaultSub = {
        status: 'trial',
        plan_id: 'starter_1499',
        trial_ends_at: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
        current_period_start: new Date().toISOString(),
        current_period_end: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
        payment_provider: 'mock',
        customer_id: '',
        subscription_id: '',
        cancel_at_period_end: false,
        canceled_at: null,
      };
      const base = existing || {
        _id: key,
        name: 'Dr. Sharma Clinic',
        phone: '',
        whatsapp_to: '',
        greeting_text: 'नमस्ते! मैं डॉ. शर्मा क्लिनिक से बोल रही हूँ। अपॉइंटमेंट बुक करने के लिए कृपया अपना पूरा नाम बताइए।',
        languages: ['hi-IN'],
        timezone: 'Asia/Kolkata',
        active: true,
        subscription: defaultSub,
        createdAt: new Date().toISOString(),
      };
      const subMerged = Object.assign({}, base.subscription || defaultSub, data && data.subscription);
      const doc = Object.assign({}, base, data, {
        _id: key,
        subscription: subMerged,
        updatedAt: new Date().toISOString(),
      });
      clinics.set(key, doc);
      if (!clinic || clinic._id === key) clinic = doc;
      return clone(doc);
    },

    async resolveClinicByPhone(phone) {
      const norm = normalizePhone(phone);
      if (!norm) return { ok: false, reason: 'unknown', clinic: null };
      const allClinics = [...clinics.values()];
      if (allClinics.length === 0 && clinic && clinic.phone) {
        allClinics.push(clinic);
      }
      const matches = allClinics.filter(c => normalizePhone(c.phone) === norm);
      if (matches.length === 0) {
        return { ok: false, reason: 'unknown', clinic: null };
      }
      if (matches.length > 1) {
        return { ok: false, reason: 'ambiguous', count: matches.length, clinic: null };
      }
      const match = matches[0];
      if (match.active === false) {
        return { ok: false, reason: 'inactive', clinic: clone(match) };
      }
      return { ok: true, clinic: clone(match) };
    },

    async getClinicByPhone(phone, opts = {}) {
      const res = await this.resolveClinicByPhone(phone);
      if (!res.ok) {
        if (res.reason === 'ambiguous') {
          throw new Error('Ambiguous clinic phone number: multiple clinics match');
        }
        if (res.reason === 'inactive' && opts.includeInactive) {
          return res.clinic;
        }
        return null;
      }
      return res.clinic;
    },

    async deleteClinic(arg1) {
      const clinicId = (arg1 && typeof arg1 === 'object') ? (arg1.clinic || arg1._id) : arg1;
      if (!clinicId) return false;
      const key = String(clinicId);
      const existed = clinics.delete(key);
      if (clinic && (clinic._id === key || clinic === key)) {
        clinic = null;
      }
      return existed;
    },

    async listClinics(opts = {}) {
      const all = [...clinics.values()];
      if (all.length === 0 && clinic) {
        all.push(clinic);
      }
      const limit = Number(opts && opts.limit) || 200;
      return all.slice()
        .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
        .slice(0, Math.min(limit, 500))
        .map(clone);
    },

    // ------------------------------------------------------------- users
    async countUsers() { return users.length; },

    async findUserByEmail(email) {
      return clone(users.find(u => u.email === String(email).toLowerCase())) || null;
    },

    async createUser(data) {
      const doc = Object.assign({
        _id: id(),
        clinic: null,
        name: '',
        role: 'receptionist',
        active: true,
        createdAt: new Date().toISOString(),
      }, data);
      users.push(doc);
      return clone(doc);
    },

    async updateUserPassword(userId, password_hash) {
      const user = users.find(u => u._id === userId);
      if (!user) return null;
      user.password_hash = password_hash;
      return clone(user);
    },

    // ---------------------------------------------------------- call logs
    async logCallTurn(callSid, turn) {
      if (!callSid) return null;
      let log = callLogs.get(callSid);
      if (!log) {
        log = { _id: id(), call_sid: callSid, clinic: null, phone: '', status: 'in-progress', turns: [], createdAt: new Date().toISOString() };
        callLogs.set(callSid, log);
      }
      if (turn.phone !== undefined) log.phone = turn.phone;
      // Cross-clinic write protection: if call log already belongs to another clinic,
      // prevent reassigning ownership or modifying another clinic's call log.
      if (log.clinic && turn.clinic && String(log.clinic) !== String(turn.clinic)) {
        return clone(log);
      }
      if (turn.clinic !== undefined && turn.clinic !== null) log.clinic = turn.clinic;
      if (turn.status) log.status = turn.status;
      if (turn.transcript !== undefined || turn.bot_action !== undefined) {
        log.turns.push({
          at: new Date().toISOString(),
          transcript: turn.transcript || '',
          bot_action: turn.bot_action || '',
        });
      }
      return clone(log);
    },

    async listCallLogs(arg1, arg2) {
      let clinic, opts;
      if (arg1 && typeof arg1 === 'object' && !Array.isArray(arg1)) {
        clinic = arg1.clinic;
        opts = arg1;
      } else if (typeof arg1 === 'string') {
        clinic = arg1;
        opts = arg2 || {};
      }
      if (!clinic) {
        throw new Error('clinic is required for listCallLogs');
      }
      const { limit = 100 } = opts || {};
      return [...callLogs.values()]
        .filter(l => l.clinic === clinic)
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
        .slice(0, Math.min(Number(limit) || 100, 500))
        .map(clone);
    },

    async getSession(callSid) {
      if (!callSid) return null;
      return clone(sessions.get(callSid)) || null;
    },

    async saveSession(session) {
      if (!session || !session.call_sid) return null;
      const existing = sessions.get(session.call_sid);
      if (existing && existing.clinic && session.clinic && String(existing.clinic) !== String(session.clinic)) {
        const err = new Error('Call session already exists for a different clinic');
        err.code = 'SESSION_CLINIC_CONFLICT';
        throw err;
      }
      const merged = Object.assign({}, existing || {}, session, {
        updatedAt: new Date().toISOString(),
        createdAt: (existing && existing.createdAt) || new Date().toISOString(),
      });
      sessions.set(session.call_sid, merged);
      return clone(merged);
    },

    async clearSession(callSid) {
      if (callSid) sessions.delete(callSid);
    },

    async findDuplicate({ phone, date, time_slot, clinic }) {
      if (!clinic) {
        throw new Error('clinic is required for findDuplicate');
      }
      const hit = appointments.find(a => a.phone === phone && a.date === date && a.time_slot === time_slot && a.status === 'Confirmed' && a.clinic === clinic);
      return clone(hit) || null;
    },

    async countBooked({ date, time_slot, clinic }) {
      if (!clinic) {
        throw new Error('clinic is required for countBooked');
      }
      return appointments.filter(a => a.date === date && a.time_slot === time_slot && a.status === 'Confirmed' && a.clinic === clinic).length;
    },

    async createAppointment(data) {
      if (!data || !data.clinic) {
        throw new Error('clinic is required for createAppointment');
      }
      const doc = Object.assign({
        _id: id(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }, data);
      appointments.push(doc);
      return clone(doc);
    },

    /** Atomically check duplicate + slot cap then create (process-local lock).
     * Returns {ok, appointment} or {ok:false, reason}. */
    async createAppointmentIfAvailable(data, maxPerSlotArg) {
      if (!data || !data.clinic) {
        throw new Error('clinic is required for createAppointmentIfAvailable');
      }
      const clinic = data.clinic;
      return withLock(async () => {
        const cap = maxPerSlotArg != null ? maxPerSlotArg : maxPerSlot;

        // 1. Duplicate check inside the lock
        const existing = appointments.find(
          a => a.phone === data.phone && a.date === data.date && a.time_slot === data.time_slot && a.status === 'Confirmed' && a.clinic === clinic
        );
        if (existing) {
          return { ok: false, reason: 'duplicate' };
        }

        if (data.call_sid) {
          const sidMatch = appointments.find(
            a => a.call_sid === data.call_sid && a.status === 'Confirmed'
          );
          if (sidMatch) {
            return { ok: false, reason: 'duplicate' };
          }
        }

        // 2. Slot cap check inside the lock
        if (cap > 0) {
          const booked = appointments.filter(
            a => a.date === data.date && a.time_slot === data.time_slot && a.status === 'Confirmed' && a.clinic === clinic
          ).length;
          if (booked >= cap) {
            return { ok: false, reason: 'slot_full' };
          }
        }

        // 3. Create inside the lock
        const doc = Object.assign({
          _id: id(),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }, data);
        appointments.push(doc);
        return { ok: true, appointment: clone(doc) };
      });
    },

    async listAppointments(arg1, arg2) {
      let clinic, opts;
      if (arg1 && typeof arg1 === 'object' && !Array.isArray(arg1)) {
        clinic = arg1.clinic;
        opts = arg1;
      } else if (typeof arg1 === 'string') {
        clinic = arg1;
        opts = arg2 || {};
      }
      if (!clinic) {
        throw new Error('clinic is required for listAppointments');
      }
      const { status, q, date, call_sid, limit = 200 } = opts || {};
      const needle = (q || '').toLowerCase();
      return appointments
        .filter(a => a.clinic === clinic)
        .filter(a => (!status || a.status === status))
        .filter(a => (!date || a.date === date))
        .filter(a => (!call_sid || a.call_sid === call_sid))
        .filter(a => !needle ||
          (a.name || '').toLowerCase().includes(needle) ||
          (a.phone || '').includes(needle) ||
          (a.reason || '').toLowerCase().includes(needle))
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
        .slice(0, Math.min(Number(limit) || 200, 500))
        .map(clone);
    },

    async getAppointment(arg1, arg2) {
      let id, clinic;
      if (arg1 && typeof arg1 === 'object' && !Array.isArray(arg1)) {
        id = arg1._id || arg1.id;
        clinic = arg1.clinic || (arg2 && arg2.clinic);
      } else {
        id = arg1;
        clinic = (arg2 && typeof arg2 === 'object') ? arg2.clinic : arg2;
      }
      if (!clinic) {
        throw new Error('clinic is required for getAppointment');
      }
      return clone(appointments.find(a => a._id === id && a.clinic === clinic)) || null;
    },

    async updateAppointmentStatus(apptId, status, opts) {
      const clinic = (opts && typeof opts === 'object') ? opts.clinic : opts;
      if (!clinic) {
        throw new Error('clinic is required for updateAppointmentStatus');
      }
      const doc = appointments.find(a => a._id === apptId && a.clinic === clinic);
      if (!doc) return null;
      if (doc.status === status) return clone(doc);
      if (maxPerSlot > 0 && doc.status !== 'Confirmed' && status === 'Confirmed') {
        const count = appointments.filter(a => a.clinic === clinic && a.date === doc.date && a.time_slot === doc.time_slot && a.status === 'Confirmed').length;
        if (count >= maxPerSlot) {
          const err = new Error('This time slot is already full');
          err.code = 'SLOT_FULL';
          throw err;
        }
      }
      doc.status = status;
      doc.updatedAt = new Date().toISOString();
      return clone(doc);
    },

    async deleteAppointment(apptId, opts) {
      const clinic = (opts && typeof opts === 'object') ? opts.clinic : opts;
      if (!clinic) {
        throw new Error('clinic is required for deleteAppointment');
      }
      const idx = appointments.findIndex(a => a._id === apptId && a.clinic === clinic);
      if (idx === -1) return false;
      appointments.splice(idx, 1);
      return true;
    },

    async stats(arg1) {
      let clinic;
      if (arg1 && typeof arg1 === 'object' && !Array.isArray(arg1)) {
        clinic = arg1.clinic;
      } else if (typeof arg1 === 'string') {
        clinic = arg1;
      }
      if (!clinic) {
        throw new Error('clinic is required for stats');
      }
      const scoped = appointments.filter(a => a.clinic === clinic);
      const count = (s) => scoped.filter(a => a.status === s).length;
      const today = new Date().toLocaleDateString('en-IN');
      return {
        total: scoped.length,
        confirmed: count('Confirmed'),
        incomplete: count('Incomplete'),
        emergency: count('Emergency'),
        abandoned: count('Abandoned'),
        today: scoped.filter(a => a.date === today).length,
      };
    },

    // ------------------------------------------------------------- leads
    async createLead(data, opts) {
      const scope = (data && data.scope) || (opts && opts.scope) || (data && data.clinic ? 'clinic' : 'platform');
      const clinic = scope === 'clinic'
        ? ((opts && typeof opts === 'object') ? opts.clinic : (opts || (data && data.clinic)))
        : null;
      if (scope === 'clinic' && !clinic) {
        throw new Error('clinic is required for createLead');
      }
      const clinic_name = (data && data.clinic_name) || (typeof data?.clinic === 'string' && scope === 'platform' ? data.clinic : '');
      const doc = Object.assign({
        _id: id(),
        name: '',
        clinic_name: clinic_name,
        clinic: clinic,
        scope: scope,
        phone: '',
        email: '',
        message: '',
        source: 'landing',
        consent: false,
        ip: '',
        user_agent: '',
        status: 'new',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }, data);
      doc.clinic = clinic;
      doc.clinic_name = clinic_name;
      doc.scope = scope;
      leads.push(doc);
      return clone(doc);
    },

    async listLeads(arg1, arg2) {
      let clinic, opts;
      if (arg1 && typeof arg1 === 'object' && !Array.isArray(arg1)) {
        clinic = arg1.clinic;
        opts = arg1;
      } else if (typeof arg1 === 'string') {
        clinic = arg1;
        opts = arg2 || {};
      }
      if (!clinic) {
        throw new Error('clinic is required for listLeads');
      }
      const { limit = 200 } = opts || {};
      return leads.slice()
        .filter(l => l.clinic === clinic)
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
        .slice(0, Math.min(Number(limit) || 200, 500))
        .map(clone);
    },

    async listPlatformLeads(opts = {}) {
      const { limit = 200 } = opts || {};
      return leads.slice()
        .filter(l => {
          if (l.scope === 'platform') return true;
          if (!l.scope && (typeof l.clinic === 'string' || !l.clinic)) return true;
          return false;
        })
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
        .slice(0, Math.min(Number(limit) || 200, 500))
        .map(l => {
          const doc = clone(l);
          const isLegacyString = typeof doc.clinic === 'string';
          if (isLegacyString) {
            doc.clinic_name = doc.clinic_name || doc.clinic;
            doc.clinic = null;
            doc.scope = 'platform';
          }
          return doc;
        });
    },

    // ------------------------------------------------------------- token blocklist (in-memory fallback)
    async createTokenBlocklist(jti, expiresAt) {
      if (!jti) return;
      tokenBlocklist.set(jti, { expiresAt: new Date(expiresAt) });
    },

    async isTokenBlocked(jti) {
      if (!jti) return false;
      const entry = tokenBlocklist.get(jti);
      if (!entry) return false;
      // Application-level expiry check: TTL cleanup is async, don't rely on it.
      if (new Date() >= entry.expiresAt) {
        tokenBlocklist.delete(jti);
        return false;
      }
      return true;
    },

    async clearExpiredTokenBlocklist() {
      const now = new Date();
      for (const [jti, entry] of tokenBlocklist.entries()) {
        if (now >= entry.expiresAt) tokenBlocklist.delete(jti);
      }
    },

    // ------------------------------------------------------------- login protection (in-memory)
    // Per-IP rate limiting and per-account lockout. Guarded by withLock for
    // atomic check-then-update within a single instance.
    async checkLoginRateLimit(ip, opts = {}) {
      const max = Number(opts.max || 15);
      const windowMs = Number(opts.windowMs || 60000);
      const clinicKey = opts.clinic || 'default';
      return withLock(async () => {
        const now = Date.now();
        const rateKey = `clinic-${clinicKey}:ip-${ip}`;
        const entry = loginRateLimit.get(rateKey);
        if (!entry) {
          loginRateLimit.set(rateKey, { count: 1, reset: now + windowMs, clinic: clinicKey });
          return { allowed: true, remaining: max - 1 };
        }
        if (now >= entry.reset) {
          entry.count = 1;
          entry.reset = now + windowMs;
          return { allowed: true, remaining: max - 1 };
        }
        if (entry.count >= max) {
          return { allowed: false, remaining: 0, resetAt: entry.reset };
        }
        entry.count += 1;
        return { allowed: true, remaining: max - entry.count };
      });
    },

    async isAccountLocked(email, opts = {}) {
      const maxAttempts = Number(opts.maxAttempts || 5);
      const lockoutWindowMs = Number(opts.lockoutWindowMs || 900000);
      const clinicKey = opts.clinic || 'default';
      return withLock(async () => {
        const entry = failedLogins.get(`clinic-${clinicKey}:email-${email}`);
        if (!entry || !entry.lockedUntil) return { locked: false };
        const now = Date.now();
        if (now >= entry.lockedUntil) {
          failedLogins.delete(`clinic-${clinicKey}:email-${email}`);
          return { locked: false };
        }
        return { locked: true, lockedUntil: entry.lockedUntil };
      });
    },

    async recordLoginFailure(email, opts = {}) {
      const maxAttempts = Number(opts.maxAttempts || 5);
      const lockoutWindowMs = Number(opts.lockoutWindowMs || 900000);
      const clinicKey = opts.clinic || 'default';
      return withLock(async () => {
        const now = Date.now();
        const entry = failedLogins.get(`clinic-${clinicKey}:email-${email}`) || { count: 0, lockedUntil: 0 };
        entry.count += 1;
        if (entry.count >= maxAttempts) {
          entry.lockedUntil = now + lockoutWindowMs;
        }
        failedLogins.set(`clinic-${clinicKey}:email-${email}`, entry);
        return {
          count: entry.count,
          locked: entry.count >= maxAttempts,
          lockedUntil: entry.lockedUntil,
        };
      });
    },

    async resetLoginFailure(email, opts = {}) {
      const clinicKey = opts.clinic || 'default';
      return withLock(async () => {
        failedLogins.delete(`clinic-${clinicKey}:email-${email}`);
      });
    },

    // ------------------------------------------------------------- subscription plans (memory)
    async createSubscriptionPlan(data) {
      if (!data || !data.plan_id) {
        throw new Error('plan_id is required for createSubscriptionPlan');
      }
      const planId = String(data.plan_id).toLowerCase().trim();
      if (plans.has(planId)) {
        const err = new Error('Subscription plan already exists: ' + planId);
        err.code = 11000;
        throw err;
      }
      const price = Number(data.price_inr != null ? data.price_inr : 1499);
      if (isNaN(price) || price < 0) {
        throw new Error('price_inr must be a non-negative number');
      }
      const doc = Object.assign({
        plan_id: planId,
        name: data.name || planId,
        price_inr: price,
        billing_interval: data.billing_interval || 'month',
        included_call_minutes: Number(data.included_call_minutes != null ? data.included_call_minutes : 350),
        included_bookings: Number(data.included_bookings != null ? data.included_bookings : 150),
        max_doctors: Number(data.max_doctors != null ? data.max_doctors : 2),
        features: Array.isArray(data.features) ? data.features.slice() : ['hindi_voice', 'whatsapp_alerts', 'analytics'],
        active: data.active !== false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }, data, { plan_id: planId });
      plans.set(planId, doc);
      return clone(doc);
    },

    async getSubscriptionPlan(planId) {
      if (!planId) return null;
      const key = String(planId).toLowerCase().trim();
      const doc = plans.get(key);
      return doc ? clone(doc) : null;
    },

    async listSubscriptionPlans(opts = {}) {
      const activeOnly = opts.activeOnly !== false;
      const list = [...plans.values()]
        .filter(p => !activeOnly || p.active !== false)
        .sort((a, b) => Number(a.price_inr || 0) - Number(b.price_inr || 0));
      return list.map(clone);
    },

    async updateSubscriptionPlan(planId, patch = {}) {
      if (!planId) return null;
      const key = String(planId).toLowerCase().trim();
      const existing = plans.get(key);
      if (!existing) return null;
      const updated = Object.assign({}, existing, patch, {
        plan_id: key, // plan_id is immutable
        updatedAt: new Date().toISOString(),
      });
      plans.set(key, updated);
      return clone(updated);
    },

    // ------------------------------------------------------------- clinic subscription (memory)
    async getClinicSubscription(arg1) {
      const clinicId = (arg1 && typeof arg1 === 'object') ? (arg1.clinic || arg1._id) : arg1;
      if (!clinicId) {
        throw new Error('clinic is required for getClinicSubscription');
      }
      const clinicDoc = await this.getClinic(clinicId);
      if (!clinicDoc) return null;
      const sub = clone(clinicDoc.subscription) || {
        status: 'trial',
        plan_id: 'starter_1499',
        trial_ends_at: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
        current_period_start: new Date().toISOString(),
        current_period_end: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
        payment_provider: 'mock',
        customer_id: '',
        subscription_id: '',
        cancel_at_period_end: false,
        canceled_at: null,
      };
      return {
        clinic_id: clinicDoc._id,
        clinic_name: clinicDoc.name,
        active: clinicDoc.active !== false,
        subscription: sub,
      };
    },

    async updateClinicSubscription(clinicId, patch = {}) {
      if (!clinicId) {
        throw new Error('clinic is required for updateClinicSubscription');
      }
      const key = String((clinicId && clinicId.clinic) || (clinicId && clinicId._id) || clinicId);
      const existing = clinics.get(key) || (clinic && (clinic._id === key || clinic === key) ? clinic : null);
      if (!existing) return null;

      const currentSub = existing.subscription || {
        status: 'trial',
        plan_id: 'starter_1499',
        trial_ends_at: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
        current_period_start: new Date().toISOString(),
        current_period_end: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
        payment_provider: 'mock',
        customer_id: '',
        subscription_id: '',
        cancel_at_period_end: false,
        canceled_at: null,
      };

      const mergedSub = Object.assign({}, currentSub, patch);
      existing.subscription = mergedSub;
      existing.updatedAt = new Date().toISOString();
      clinics.set(key, existing);
      if (clinic && (clinic._id === key || clinic === key)) clinic = existing;
      return {
        clinic_id: existing._id,
        clinic_name: existing.name,
        active: existing.active !== false,
        subscription: clone(mergedSub),
      };
    },

    // ------------------------------------------------------------- clinic usage (memory)
    async getOrCreateClinicUsage(clinicId, billingMonth) {
      if (!clinicId) {
        throw new Error('clinic is required for getOrCreateClinicUsage');
      }
      if (!billingMonth || !/^\d{4}-(0[1-9]|1[0-2])$/.test(String(billingMonth).trim())) {
        throw new Error('Valid billing_month (YYYY-MM) is required for getOrCreateClinicUsage');
      }
      const cKey = String((clinicId && clinicId.clinic) || (clinicId && clinicId._id) || clinicId);
      const mKey = String(billingMonth).trim();
      const usageKey = `${cKey}:${mKey}`;

      return withLock(async () => {
        let entry = clinicUsages.get(usageKey);
        if (!entry) {
          entry = {
            _id: id(),
            clinic: cKey,
            billing_month: mKey,
            call_count: 0,
            call_minutes: 0,
            booking_count: 0,
            whatsapp_count: 0,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };
          clinicUsages.set(usageKey, entry);
        }
        return clone(entry);
      });
    },

    async recordClinicUsage(clinicId, billingMonth, increments = {}, opts = {}) {
      if (!clinicId) {
        throw new Error('clinic is required for recordClinicUsage');
      }
      if (!billingMonth || !/^\d{4}-(0[1-9]|1[0-2])$/.test(String(billingMonth).trim())) {
        throw new Error('Valid billing_month (YYYY-MM) is required for recordClinicUsage');
      }
      const cKey = String((clinicId && clinicId.clinic) || (clinicId && clinicId._id) || clinicId);
      const mKey = String(billingMonth).trim();
      const usageKey = `${cKey}:${mKey}`;

      const rawEventId = (opts && opts.eventId) || (increments && increments.event_id) || null;
      const eventId = rawEventId ? String(rawEventId).trim() : null;
      const eventType = (opts && opts.eventType) || (increments && increments.event_type) || 'other';
      const skipCounterIncrement = !!(opts && opts.skipCounterIncrement);

      return withLock(async () => {
        let entry = clinicUsages.get(usageKey);
        if (!entry) {
          entry = {
            _id: id(),
            clinic: cKey,
            billing_month: mKey,
            call_count: 0,
            call_minutes: 0,
            booking_count: 0,
            whatsapp_count: 0,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };
          clinicUsages.set(usageKey, entry);
        }

        if (eventId) {
          if (usageEvents.has(eventId)) {
            return Object.assign(clone(entry), { duplicate: true });
          }
          const sanitizedInc = {};
          for (const field of ['call_count', 'call_minutes', 'booking_count', 'whatsapp_count']) {
            const parsed = Number(increments[field]);
            sanitizedInc[field] = (Number.isFinite(parsed) && parsed > 0) ? Math.floor(parsed) : 0;
          }
          usageEvents.set(eventId, {
            event_id: eventId,
            clinic: cKey,
            billing_month: mKey,
            event_type: eventType,
            increments: sanitizedInc,
            createdAt: new Date().toISOString(),
          });
          if (skipCounterIncrement) {
            return clone(entry);
          }
        }

        for (const field of ['call_count', 'call_minutes', 'booking_count', 'whatsapp_count']) {
          if (increments[field] != null) {
            const parsed = Number(increments[field]);
            const val = (Number.isFinite(parsed) && parsed > 0) ? Math.floor(parsed) : 0;
            entry[field] = Math.max(0, (entry[field] || 0) + val);
          }
        }
        entry.updatedAt = new Date().toISOString();
        clinicUsages.set(usageKey, entry);
        return clone(entry);
      });
    },

    async hasUsageEvent(eventId) {
      if (!eventId) return false;
      return usageEvents.has(String(eventId).trim());
    },

    async reserveBookingQuota(clinicId, billingMonth, limit) {
      if (!clinicId) {
        throw new Error('clinic is required for reserveBookingQuota');
      }
      if (!billingMonth || !/^\d{4}-(0[1-9]|1[0-2])$/.test(String(billingMonth).trim())) {
        throw new Error('Valid billing_month (YYYY-MM) is required for reserveBookingQuota');
      }
      const cKey = String((clinicId && clinicId.clinic) || (clinicId && clinicId._id) || clinicId);
      const mKey = String(billingMonth).trim();
      const usageKey = `${cKey}:${mKey}`;
      const maxLimit = Number(limit);
      if (!Number.isFinite(maxLimit) || maxLimit < 0) {
        return { allowed: true, currentUsage: 0, limit: Infinity };
      }

      return withLock(async () => {
        let entry = clinicUsages.get(usageKey);
        if (!entry) {
          entry = {
            _id: id(),
            clinic: cKey,
            billing_month: mKey,
            call_count: 0,
            call_minutes: 0,
            booking_count: 0,
            whatsapp_count: 0,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };
          clinicUsages.set(usageKey, entry);
        }
        if ((entry.booking_count || 0) >= maxLimit) {
          return { allowed: false, currentUsage: entry.booking_count || 0, limit: maxLimit };
        }
        entry.booking_count = (entry.booking_count || 0) + 1;
        entry.updatedAt = new Date().toISOString();
        clinicUsages.set(usageKey, entry);
        return { allowed: true, currentUsage: entry.booking_count, limit: maxLimit };
      });
    },

    async releaseBookingQuota(clinicId, billingMonth) {
      if (!clinicId || !billingMonth) return;
      const cKey = String((clinicId && clinicId.clinic) || (clinicId && clinicId._id) || clinicId);
      const mKey = String(billingMonth).trim();
      const usageKey = `${cKey}:${mKey}`;
      return withLock(async () => {
        const entry = clinicUsages.get(usageKey);
        if (entry && (entry.booking_count || 0) > 0) {
          entry.booking_count = Math.max(0, entry.booking_count - 1);
          entry.updatedAt = new Date().toISOString();
          clinicUsages.set(usageKey, entry);
        }
      });
    },

    async getClinicUsage(clinicId, billingMonth) {
      if (!clinicId) {
        throw new Error('clinic is required for getClinicUsage');
      }
      if (!billingMonth) return null;
      const cKey = String((clinicId && clinicId.clinic) || (clinicId && clinicId._id) || clinicId);
      const mKey = String(billingMonth).trim();
      const usageKey = `${cKey}:${mKey}`;
      const entry = clinicUsages.get(usageKey);
      if (!entry || String(entry.clinic) !== cKey) return null;
      return clone(entry);
    },

    async listClinicUsage(clinicId, opts = {}) {
      if (!clinicId) {
        throw new Error('clinic is required for listClinicUsage');
      }
      const cKey = String((clinicId && clinicId.clinic) || (clinicId && clinicId._id) || clinicId);
      const { limit = 24 } = opts;
      const list = [...clinicUsages.values()]
        .filter(u => String(u.clinic) === cKey)
        .sort((a, b) => String(b.billing_month).localeCompare(String(a.billing_month)))
        .slice(0, Math.min(Number(limit) || 24, 120));
      return list.map(clone);
    },

    // ------------------------------------------------------------- billing: checkout sessions, payment events & invoices (memory)
    async createCheckoutSession(data) {
      if (!data || !data.session_id || !data.clinic) {
        throw new Error('session_id and clinic are required for createCheckoutSession');
      }
      const key = String(data.session_id).trim();
      return withLock(async () => {
        if (checkoutSessions.has(key)) {
          throw new Error('Checkout session already exists');
        }
        const doc = Object.assign({
          _id: id(),
          currency: 'INR',
          provider: 'mock',
          status: 'pending',
          transaction_ref: '',
          is_test: true,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }, data, {
          session_id: key,
          clinic: String(data.clinic),
        });
        checkoutSessions.set(key, doc);
        return clone(doc);
      });
    },

    async getCheckoutSession(sessionId, opts = {}) {
      if (!sessionId) return null;
      const doc = checkoutSessions.get(String(sessionId).trim());
      if (!doc) return null;
      if (opts && opts.clinic && String(doc.clinic) !== String(opts.clinic)) return null;
      return clone(doc);
    },

    async updateCheckoutSession(sessionId, patch = {}) {
      if (!sessionId) return null;
      const key = String(sessionId).trim();
      return withLock(async () => {
        const existing = checkoutSessions.get(key);
        if (!existing) return null;
        const updated = Object.assign({}, existing, patch, { updatedAt: new Date().toISOString() });
        checkoutSessions.set(key, updated);
        return clone(updated);
      });
    },

    async listCheckoutSessions(clinicId, opts = {}) {
      if (!clinicId) throw new Error('clinic is required for listCheckoutSessions');
      const cKey = String((clinicId && clinicId.clinic) || (clinicId && clinicId._id) || clinicId);
      const { limit = 50 } = opts;
      return [...checkoutSessions.values()]
        .filter(s => String(s.clinic) === cKey)
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
        .slice(0, Math.min(Number(limit) || 50, 200))
        .map(clone);
    },

    async recordPaymentEvent(eventData) {
      if (!eventData || !eventData.event_id || !eventData.clinic) {
        throw new Error('event_id and clinic are required for recordPaymentEvent');
      }
      const key = String(eventData.event_id).trim();
      return withLock(async () => {
        if (paymentEvents.has(key)) {
          return { recorded: false, duplicate: true };
        }
        const doc = Object.assign({
          _id: id(),
          processed_at: new Date().toISOString(),
          createdAt: new Date().toISOString(),
        }, eventData, {
          event_id: key,
          clinic: String(eventData.clinic),
        });
        paymentEvents.set(key, doc);
        return { recorded: true, duplicate: false, event: clone(doc) };
      });
    },

    async hasPaymentEvent(eventId) {
      if (!eventId) return false;
      return paymentEvents.has(String(eventId).trim());
    },

    async createInvoice(data) {
      if (!data || !data.invoice_number || !data.clinic) {
        throw new Error('invoice_number and clinic are required for createInvoice');
      }
      const key = String(data.invoice_number).trim();
      return withLock(async () => {
        if (invoices.has(key)) {
          throw new Error('Invoice number already exists');
        }
        const doc = Object.assign({
          _id: id(),
          currency: 'INR',
          status: 'open',
          is_test_invoice: false,
          issued_at: new Date().toISOString(),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }, data, {
          invoice_number: key,
          clinic: String(data.clinic),
        });
        invoices.set(key, doc);
        return clone(doc);
      });
    },

    async getInvoice(invoiceIdOrNumber, opts = {}) {
      const clinic = (opts && typeof opts === 'object') ? opts.clinic : opts;
      if (!clinic) {
        throw new Error('clinic is required for getInvoice');
      }
      if (!invoiceIdOrNumber) return null;
      const key = String(invoiceIdOrNumber).trim();
      const cKey = String(clinic);
      const byNum = invoices.get(key);
      if (byNum && String(byNum.clinic) === cKey) return clone(byNum);
      for (const inv of invoices.values()) {
        if (String(inv.clinic) === cKey && (String(inv._id) === key || String(inv.invoice_number) === key)) {
          return clone(inv);
        }
      }
      return null;
    },

    async listInvoices(clinicId, opts = {}) {
      if (!clinicId) {
        throw new Error('clinic is required for listInvoices');
      }
      const cKey = String((clinicId && clinicId.clinic) || (clinicId && clinicId._id) || clinicId);
      const { limit = 50 } = opts;
      return [...invoices.values()]
        .filter(inv => String(inv.clinic) === cKey)
        .sort((a, b) => String(b.issued_at || b.createdAt).localeCompare(String(a.issued_at || a.createdAt)))
        .slice(0, Math.min(Number(limit) || 50, 200))
        .map(clone);
    },
  };
}

module.exports = { createMemoryStore };
