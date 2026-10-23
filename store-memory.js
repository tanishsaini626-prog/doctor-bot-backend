'use strict';
/* ==========================================================================
 * store-memory.js - in-memory implementation of the same store interface as
 * store-mongo.js. Used for local runs, demos and tests when MongoDB Atlas is
 * not available (or its URI is still a placeholder).
 *
 * Data lives only while the process runs - restarting the server clears it.
 * ========================================================================== */

function createMemoryStore(options) {
  const appointments = [];
  const sessions = new Map();
  const users = [];
  const callLogs = new Map();
  const doctors = [];
  const leads = [];
  let clinic = null;
  let nextId = 1;
  const id = () => 'mem_' + (nextId++);

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
        clinic,
        nextId,
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
      if (snapshot.clinic !== undefined) clinic = snapshot.clinic;
      if (Number.isFinite(snapshot.nextId) && snapshot.nextId > nextId) nextId = snapshot.nextId;
    },

    // ---------------------------------------------------------- doctors
    async listDoctors() {
      return doctors.slice().sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))).map(clone);
    },

    async createDoctor(data) {
      const doc = Object.assign({
        _id: id(),
        specialty: 'General Physician',
        slot_minutes: 15,
        working_hours: DEFAULT_HOURS,
        holidays: [],
        active: true,
        createdAt: new Date().toISOString(),
      }, data);
      doctors.push(doc);
      return clone(doc);
    },

    async updateDoctor(docId, data) {
      const doc = doctors.find(d => d._id === docId);
      if (!doc) return null;
      Object.assign(doc, data, { updatedAt: new Date().toISOString() });
      return clone(doc);
    },

    async deleteDoctor(docId) {
      const i = doctors.findIndex(d => d._id === docId);
      if (i === -1) return false;
      doctors.splice(i, 1);
      return true;
    },

    // ----------------------------------------------------------- clinic
    async getClinic() {
      return clinic ? clone(clinic) : null;
    },

    async saveClinic(data) {
      clinic = Object.assign({
        _id: 'clinic_1',
        name: 'Dr. Sharma Clinic',
        phone: '',
        whatsapp_to: '',
        greeting_text: 'नमस्ते! मैं डॉ. शर्मा क्लिनिक से बोल रही हूँ। अपॉइंटमेंट बुक करने के लिए कृपया अपना पूरा नाम बताइए।',
        languages: ['hi-IN'],
        timezone: 'Asia/Kolkata',
        active: true,
        createdAt: (clinic && clinic.createdAt) || new Date().toISOString(),
      }, clinic || {}, data, { updatedAt: new Date().toISOString() });
      return clone(clinic);
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

    async listCallLogs({ limit = 100 } = {}) {
      return [...callLogs.values()]
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
      const existing = sessions.get(session.call_sid) || {};
      const merged = Object.assign({}, existing, session, {
        updatedAt: new Date().toISOString(),
        createdAt: existing.createdAt || new Date().toISOString(),
      });
      sessions.set(session.call_sid, merged);
      return clone(merged);
    },

    async clearSession(callSid) {
      if (callSid) sessions.delete(callSid);
    },

    async findDuplicate({ phone, date, time_slot }) {
      const hit = appointments.find(a => a.phone === phone && a.date === date && a.time_slot === time_slot && a.status === 'Confirmed');
      return clone(hit) || null;
    },

    async countBooked({ date, time_slot }) {
      return appointments.filter(a => a.date === date && a.time_slot === time_slot && a.status === 'Confirmed').length;
    },

    async createAppointment(data) {
      const doc = Object.assign({
        _id: id(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }, data);
      appointments.push(doc);
      return clone(doc);
    },

    async listAppointments({ status, q, date, limit = 200 } = {}) {
      const needle = (q || '').toLowerCase();
      return appointments
        .filter(a => (!status || a.status === status))
        .filter(a => (!date || a.date === date))
        .filter(a => !needle ||
          (a.name || '').toLowerCase().includes(needle) ||
          (a.phone || '').includes(needle) ||
          (a.reason || '').toLowerCase().includes(needle))
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
        .slice(0, Math.min(Number(limit) || 200, 500))
        .map(clone);
    },

    async getAppointment(apptId) {
      return clone(appointments.find(a => a._id === apptId)) || null;
    },

    async updateAppointmentStatus(apptId, status) {
      const doc = appointments.find(a => a._id === apptId);
      if (!doc) return null;
      doc.status = status;
      doc.updatedAt = new Date().toISOString();
      return clone(doc);
    },

    async deleteAppointment(apptId) {
      const idx = appointments.findIndex(a => a._id === apptId);
      if (idx === -1) return false;
      appointments.splice(idx, 1);
      return true;
    },

    async stats() {
      const count = (s) => appointments.filter(a => a.status === s).length;
      const today = new Date().toLocaleDateString('en-IN');
      return {
        total: appointments.length,
        confirmed: count('Confirmed'),
        incomplete: count('Incomplete'),
        emergency: count('Emergency'),
        abandoned: count('Abandoned'),
        today: appointments.filter(a => a.date === today).length,
      };
    },

    // ------------------------------------------------------------- leads
    async createLead(data) {
      const doc = Object.assign({
        _id: id(),
        name: '',
        clinic: '',
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
      leads.push(doc);
      return clone(doc);
    },

    async listLeads({ limit = 200 } = {}) {
      return leads.slice()
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
        .slice(0, Math.min(Number(limit) || 200, 500))
        .map(clone);
    },
  };
}

module.exports = { createMemoryStore };
