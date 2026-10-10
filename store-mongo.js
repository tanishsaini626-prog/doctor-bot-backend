'use strict';
/* ==========================================================================
 * store-mongo.js - MongoDB implementation of the store used by conversation.js
 * ========================================================================== */

const mongoose = require('mongoose');
const { Clinic, Doctor, User, CallLog } = require('./models');

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

const Appointment = mongoose.model('Appointment', AppointmentSchema);
const CallSession = mongoose.model('CallSession', SessionSchema);

function createMongoStore() {
  return {
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
  };
}

module.exports = { createMongoStore, Appointment, CallSession, Clinic, Doctor, User, CallLog };
