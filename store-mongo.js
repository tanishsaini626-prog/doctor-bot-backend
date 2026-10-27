'use strict';
/* ==========================================================================
 * store-mongo.js - MongoDB implementation of the store used by conversation.js
 * ========================================================================== */

const mongoose = require('mongoose');
const { Clinic, Doctor, User, CallLog, Lead } = require('./models');

const AppointmentSchema = new mongoose.Schema({
  name: { type: String, default: 'Unknown' },
  phone: { type: String, index: true },
  date: String,               // 24/06/2026  (what the sheet shows)
  date_iso: String,           // 2026-06-24  (sortable)
  date_speech: String,        // "24 जून 2026"
  time_slot: String,          // "Morning 10:00"
  time_slot_display: String,  // "Morning 10:00"
  reason: String,
  booking_for: { type: String, default: 'Self' },
  status: {
    type: String,
    default: 'Confirmed',
    index: true,              // Confirmed | Incomplete | Emergency | Abandoned | Duplicate | Cancelled | Completed
  },
  priority: { type: String, default: 'Normal' },   // Normal | URGENT
  source: { type: String, default: 'voice-bot' },
  raw_text: String,
  call_sid: { type: String, index: true },
}, { timestamps: true });

// Unique partial index: prevents two Confirmed appointments for the same
// phone + date + time_slot at the database level. This is the atomic
// backstop that stops double-booking even across server instances.
AppointmentSchema.index(
  { phone: 1, date: 1, time_slot: 1 },
  { unique: true, partialFilterExpression: { status: 'Confirmed' } }
);

const SessionSchema = new mongoose.Schema({
  call_sid: { type: String, unique: true, index: true },
  phone: String,
  name: String, date: String, date_iso: String, date_speech: String,
  time_slot: String, time_slot_display: String, time_slot_speech: String,
  reason: String, booking_for: { type: String, default: 'Self' },
  attempt: { type: Number, default: 0 },
  asked_field: String,
  missing_count: Number,
  raw_text: String,
  status: { type: String, default: 'InProgress' },
  completed: { type: Boolean, default: false },
}, { timestamps: true });

// Token blocklist for persistent JWT revocation (survives restarts, shared across instances).
// expiresAt drives MongoDB TTL auto-deletion; application logic also checks expiry
// because TTL deletion is asynchronous and not immediate.
const TokenBlocklistSchema = new mongoose.Schema({
  jti: { type: String, unique: true, index: true },
  expiresAt: { type: Date, index: { expireAfterSeconds: 0 } },
}, { timestamps: true });

const Appointment = mongoose.model('Appointment', AppointmentSchema);
const CallSession = mongoose.model('CallSession', SessionSchema);
const TokenBlocklist = mongoose.model('TokenBlocklist', TokenBlocklistSchema);

/**
 * Ensure MongoDB indexes are created before accepting traffic.
 * - Detects existing duplicate Confirmed appointments that would block the unique partial index.
 * - Does NOT auto-cancel or modify any appointments; reports conflicts for manual resolution.
 * - Creates the unique partial index and the token blocklist TTL index.
 * Throws if duplicates exist or index creation/verification fails.
 */
async function ensureIndexes() {
  // 1. Detect existing duplicate Confirmed appointments before creating the unique index.
  const duplicates = await Appointment.aggregate([
    { $match: { status: 'Confirmed' } },
    {
      $group: {
        _id: { phone: '$phone', date: '$date', time_slot: '$time_slot' },
        count: { $sum: 1 },
        ids: { $push: '$_id' },
      },
    },
    { $match: { count: { $gt: 1 } } },
    { $limit: 10 },
  ]);

  if (duplicates.length > 0) {
    const detail = duplicates.map((d) =>
      `phone=${d._id.phone}, date=${d._id.date}, time_slot=${d._id.time_slot}, count=${d.count}`
    ).join('; ');
    throw new Error(
      'Duplicate Confirmed appointments found before creating unique index. ' +
      'Resolve manually before restarting. Duplicates: ' + detail
    );
  }

  // 2. Create indexes explicitly (not relying on auto-indexing on model init).
  await Appointment.createIndexes();
  await TokenBlocklist.createIndexes();

  // 3. Verify the unique partial index exists and is correct.
  const indexes = await Appointment.collection.indexes();
  const hasUniquePartial = indexes.some((idx) =>
    idx.unique === true &&
    idx.partialFilterExpression &&
    String(idx.partialFilterExpression.status) === 'Confirmed' &&
    idx.key.phone === 1 &&
    idx.key.date === 1 &&
    idx.key.time_slot === 1
  );
  if (!hasUniquePartial) {
    throw new Error('Unique partial index on appointments could not be verified after creation.');
  }
}

/** Run a function inside a MongoDB transaction. Aborts and re-throws on error. */
async function withTransaction(fn) {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const result = await fn(session);
    await session.commitTransaction();
    return result;
  } catch (err) {
    try { await session.abortTransaction(); } catch { /* ignore abort errors */ }
    throw err;
  } finally {
    session.endSession();
  }
}

function createMongoStore({ maxPerSlot = 0 } = {}) {
  return {
    // ---------------------------------------------------------- doctors
    async listDoctors() {
      return Doctor.find({}).sort({ createdAt: 1 }).lean();
    },

    async getDoctor(docId) {
      if (!docId) return null;
      return Doctor.findById(docId).lean();
    },

    async createDoctor(data) {
      return (await Doctor.create(data)).toObject();
    },

    async updateDoctor(docId, data) {
      return Doctor.findByIdAndUpdate(docId, { $set: data }, { new: true }).lean();
    },

    async deleteDoctor(docId) {
      const removed = await Doctor.findByIdAndDelete(docId);
      return !!removed;
    },

    // ----------------------------------------------------------- clinic
    // One clinic document per install for now; multi-clinic adds a clinicId.
    async getClinic() {
      return Clinic.findOne({}).sort({ createdAt: 1 }).lean();
    },

    async saveClinic(data) {
      const existing = await Clinic.findOne({}).sort({ createdAt: 1 });
      if (existing) {
        return Clinic.findByIdAndUpdate(existing._id, { $set: data }, { new: true }).lean();
      }
      return (await Clinic.create(data)).toObject();
    },

    // ------------------------------------------------------------- users
    async countUsers() {
      return User.countDocuments({});
    },

    async findUserByEmail(email) {
      return User.findOne({ email: String(email).toLowerCase() }).lean();
    },

    async createUser(data) {
      return (await User.create(data)).toObject();
    },

    async updateUserPassword(userId, password_hash) {
      return User.findByIdAndUpdate(userId, { $set: { password_hash } }, { new: true }).lean();
    },

    // ---------------------------------------------------------- call logs
    async logCallTurn(callSid, turn) {
      if (!callSid) return null;
      return CallLog.findOneAndUpdate(
        { call_sid: callSid },
        {
          $set: {
            ...(turn.phone !== undefined ? { phone: turn.phone } : {}),
            ...(turn.status ? { status: turn.status } : {}),
          },
          $push: {
            ...(turn.transcript !== undefined || turn.bot_action !== undefined ? {
              turns: {
                at: new Date(),
                transcript: turn.transcript || '',
                bot_action: turn.bot_action || '',
              },
            } : {}),
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      ).lean();
    },

    async listCallLogs({ limit = 100 } = {}) {
      return CallLog.find({}).sort({ createdAt: -1 }).limit(Math.min(Number(limit) || 100, 500)).lean();
    },

    async getSession(callSid) {
      if (!callSid) return null;
      return CallSession.findOne({ call_sid: callSid }).lean();
    },

    async saveSession(session) {
      if (!session || !session.call_sid) return null;
      return CallSession.findOneAndUpdate(
        { call_sid: session.call_sid },
        { $set: session },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      ).lean();
    },

    async clearSession(callSid) {
      if (!callSid) return;
      await CallSession.deleteOne({ call_sid: callSid });
    },

    async findDuplicate({ phone, date, time_slot }) {
      return Appointment.findOne({ phone, date, time_slot, status: 'Confirmed' }).sort({ _id: -1 }).lean();
    },

    async countBooked({ date, time_slot }) {
      return Appointment.countDocuments({ date, time_slot, status: 'Confirmed' });
    },

    async createAppointment(data) {
      return (await Appointment.create(data)).toObject();
    },

    /** Atomically check duplicate + slot cap then create. Returns {ok, appointment} or {ok:false, reason}. */
    async createAppointmentIfAvailable(data, maxPerSlot) {
      return withTransaction(async (session) => {
        // 1. Duplicate check inside the transaction
        const existing = await Appointment.findOne({
          phone: data.phone,
          date: data.date,
          time_slot: data.time_slot,
          status: 'Confirmed',
        }).session(session).lean();
        if (existing) {
          return { ok: false, reason: 'duplicate' };
        }

        // 2. Slot cap check inside the transaction
        if (maxPerSlot > 0) {
          const booked = await Appointment.countDocuments({
            date: data.date,
            time_slot: data.time_slot,
            status: 'Confirmed',
          }).session(session);
          if (booked >= maxPerSlot) {
            return { ok: false, reason: 'slot_full' };
          }
        }

        // 3. Create inside the transaction
        const doc = await Appointment.create([data], { session });
        return { ok: true, appointment: doc[0].toObject() };
      });
    },

    async listAppointments({ status, q, date, limit = 200 } = {}) {
      const filter = {};
      if (status) filter.status = status;
      if (date) filter.date = date;
      if (q) {
        const rx = new RegExp(String(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        filter.$or = [{ name: rx }, { phone: rx }, { reason: rx }];
      }
      return Appointment.find(filter).sort({ createdAt: -1 }).limit(Math.min(Number(limit) || 200, 500)).lean();
    },

    async getAppointment(id) {
      return Appointment.findById(id).lean();
    },

    async updateAppointmentStatus(id, status) {
      return Appointment.findByIdAndUpdate(id, { $set: { status } }, { new: true }).lean();
    },

    async deleteAppointment(id) {
      const removed = await Appointment.findByIdAndDelete(id);
      return !!removed;
    },

    async stats() {
      const [total, confirmed, incomplete, emergency, abandoned, today] = await Promise.all([
        Appointment.countDocuments({}),
        Appointment.countDocuments({ status: 'Confirmed' }),
        Appointment.countDocuments({ status: 'Incomplete' }),
        Appointment.countDocuments({ status: 'Emergency' }),
        Appointment.countDocuments({ status: 'Abandoned' }),
        Appointment.countDocuments({ date: new Date().toLocaleDateString('en-IN') }),
      ]);
      return { total, confirmed, incomplete, emergency, abandoned, today };
    },

    // ------------------------------------------------------------- leads
    async createLead(data) {
      return (await Lead.create(data)).toObject();
    },

    async listLeads({ limit = 200 } = {}) {
      return Lead.find({}).sort({ createdAt: -1 }).limit(Math.min(Number(limit) || 200, 500)).lean();
    },

    // ------------------------------------------------------------- token blocklist (persistent revocation)
    async createTokenBlocklist(jti, expiresAt) {
      if (!jti) return;
      await TokenBlocklist.updateOne(
        { jti },
        { $set: { jti, expiresAt: new Date(expiresAt) } },
        { upsert: true }
      );
    },

    async isTokenBlocked(jti) {
      if (!jti) return false;
      const doc = await TokenBlocklist.findOne({ jti }).lean();
      if (!doc) return false;
      if (doc.expiresAt && new Date() >= new Date(doc.expiresAt)) {
        return false;
      }
      return true;
    },

    async clearExpiredTokenBlocklist() {
      await TokenBlocklist.deleteMany({ expiresAt: { $lt: new Date() } });
    },
  };
}

module.exports = { createMongoStore, ensureIndexes, Appointment, CallSession, TokenBlocklist, Clinic, Doctor, User, CallLog, Lead };
