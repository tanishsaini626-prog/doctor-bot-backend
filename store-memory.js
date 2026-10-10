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
  let nextId = 1;
  const id = () => 'mem_' + (nextId++);

  const clone = (doc) => (doc ? JSON.parse(JSON.stringify(doc)) : doc);

  return {
    kind: 'memory',
    appointments,            // exposed for tests

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
  };
}

module.exports = { createMemoryStore };
