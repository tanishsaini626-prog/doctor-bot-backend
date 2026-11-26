'use strict';
/* ==========================================================================
 * store-mongo.js - MongoDB implementation of the store used by conversation.js
 * ========================================================================== */

const mongoose = require('mongoose');
const { Clinic, Doctor, User, CallLog, Lead, SubscriptionPlan, ClinicUsage, UsageEvent, Invoice, CheckoutSession, PaymentEvent, DEFAULT_PLANS } = require('./models');
const { normalizePhone } = require('./phone');

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
  call_sid: { type: String },
  doctorId: { type: mongoose.Schema.Types.Mixed },
  doctor_name: { type: String },
}, { timestamps: true });

// NEW: clinic field for tenant isolation — must be defined before index
AppointmentSchema.add({
  clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', index: true },
});

// Unique partial index: prevents two Confirmed appointments for the same
// phone + date + time_slot + clinic at the database level. This is the atomic
// backstop that stops double-booking even across server instances.
// Index keys include clinic so the uniqueness constraint is per-clinic:
// a confirmed appointment in Clinic A cannot share the same phone/date/slot
// as a confirmed appointment in Clinic B.
AppointmentSchema.index(
  { phone: 1, date: 1, time_slot: 1, clinic: 1 },
  { unique: true, partialFilterExpression: { status: 'Confirmed', clinic: { $exists: true } } }
);

// F-02: Unique partial index on call_sid for Confirmed appointments.
// Ensures that one call_sid cannot book multiple confirmed appointments across
// independent processes, enforcing atomic idempotency at the database level.
AppointmentSchema.index(
  { call_sid: 1 },
  { name: 'unique_confirmed_call_sid', unique: true, partialFilterExpression: { status: 'Confirmed', call_sid: { $exists: true, $type: 'string' } } }
);

const SessionSchema = new mongoose.Schema({
  call_sid: { type: String, unique: true, index: true },
  phone: String,
  to: String,
  clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', index: true },
  verified: { type: Boolean, default: false },
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

// F-01: Dedicated slot capacity reservation collection.
// Provides database-level atomic conditional capacity reservation across
// independent Node.js processes, without relying on in-memory locks.
const SlotReservationSchema = new mongoose.Schema({
  _id: { type: String }, // `${clinic}:${date}:${time_slot}`
  clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', index: true },
  date: { type: String, index: true },
  time_slot: { type: String, index: true },
  booked: { type: Number, default: 0 },
}, { timestamps: true });

const SlotReservation = mongoose.models.SlotReservation || mongoose.model('SlotReservation', SlotReservationSchema);

// Token blocklist for persistent JWT revocation (survives restarts, shared across instances).
// expiresAt drives MongoDB TTL auto-deletion; application logic also checks expiry
// because TTL deletion is asynchronous and not immediate.
const TokenBlocklistSchema = new mongoose.Schema({
  jti: { type: String, unique: true, index: true },
  expiresAt: { type: Date, index: { expireAfterSeconds: 0 } },
}, { timestamps: true });

// Login protection: per-IP rate limiting and per-account lockout.
// key is "rate:ip:<ip>" or "lock:email:<email>".
// count tracks attempts; windowStart anchors the rate-limit window;
// lockedUntil is set when lockout threshold is reached.
// expiresAt drives MongoDB TTL auto-deletion; application logic also checks
// expiry because TTL deletion is asynchronous and not immediate.
const LoginAttemptSchema = new mongoose.Schema({
  key: { type: String, unique: true, index: true },
  count: { type: Number, default: 0 },
  windowStart: { type: Date },
  lockedUntil: { type: Date },
  expiresAt: { type: Date, index: { expireAfterSeconds: 0 } },
}, { timestamps: true });

const Appointment = mongoose.model('Appointment', AppointmentSchema);
const CallSession = mongoose.model('CallSession', SessionSchema);
const TokenBlocklist = mongoose.model('TokenBlocklist', TokenBlocklistSchema);
const LoginAttempt = mongoose.model('LoginAttempt', LoginAttemptSchema);

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
        _id: { phone: '$phone', date: '$date', time_slot: '$time_slot', clinic: '$clinic' },
        count: { $sum: 1 },
        ids: { $push: '$_id' },
      },
    },
    { $match: { count: { $gt: 1 } } },
    { $limit: 10 },
  ]);

  if (duplicates.length > 0) {
    const detail = duplicates.map((d) =>
      `phone=${d._id.phone}, date=${d._id.date}, time_slot=${d._id.time_slot}, clinic=${d._id.clinic}, count=${d.count}`
    ).join('; ');
    throw new Error(
      'Duplicate Confirmed appointments found before creating unique index. ' +
      'Resolve manually before restarting. Duplicates: ' + detail
    );
  }

  // 1b. Detect existing duplicate Confirmed call_sids before creating index
  const sidDuplicates = await Appointment.aggregate([
    { $match: { status: 'Confirmed', call_sid: { $exists: true, $type: 'string', $ne: '' } } },
    { $group: { _id: '$call_sid', count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
    { $limit: 10 },
  ]);

  if (sidDuplicates.length > 0) {
    const detail = sidDuplicates.map(d => `call_sid=${d._id}, count=${d.count}`).join('; ');
    throw new Error(
      'Duplicate Confirmed call_sid found before creating unique index. ' +
      'Resolve manually before restarting. Duplicates: ' + detail
    );
  }

  // 1c. Detect existing duplicate active clinic phone numbers before creating index
  const clinicPhoneDuplicates = await Clinic.aggregate([
    { $match: { active: true, phone: { $exists: true, $type: 'string', $gt: '' } } },
    { $group: { _id: '$phone', count: { $sum: 1 }, ids: { $push: '$_id' } } },
    { $match: { count: { $gt: 1 } } },
    { $limit: 10 },
  ]);

  if (clinicPhoneDuplicates.length > 0) {
    const detail = clinicPhoneDuplicates.map(d => `phone=${d._id}, count=${d.count}, clinicIds=${d.ids.join(',')}`).join('; ');
    throw new Error(
      'Duplicate active clinic phone numbers found before creating unique index. ' +
      'Resolve manually before restarting. Duplicates: ' + detail
    );
  }

  // Drop legacy non-unique call_sid index if present to avoid name conflict with unique partial index
  try {
    const existingIdxs = await Appointment.collection.indexes();
    const legacyIdx = existingIdxs.find(idx => idx.name === 'call_sid_1' && !idx.unique);
    if (legacyIdx) {
      await Appointment.collection.dropIndex('call_sid_1');
    }
  } catch (_) {}

  // 2. Create indexes explicitly (not relying on auto-indexing on model init).
  await Appointment.createIndexes();
  await TokenBlocklist.createIndexes();
  await SlotReservation.createIndexes();
  await CallSession.createIndexes();
  await Clinic.createIndexes();
  await SubscriptionPlan.createIndexes();
  await ClinicUsage.createIndexes();
  try {
    const ueIdxs = await UsageEvent.collection.indexes();
    if (ueIdxs.some(i => i.name === 'event_id_1')) {
      await UsageEvent.collection.dropIndex('event_id_1');
    }
  } catch (_) {}
  await UsageEvent.createIndexes();
  await Invoice.createIndexes();
  await CheckoutSession.createIndexes();
  await PaymentEvent.createIndexes();

  // Seed default subscription plans if collection is empty
  const planCount = await SubscriptionPlan.countDocuments();
  if (planCount === 0 && Array.isArray(DEFAULT_PLANS)) {
    for (const plan of DEFAULT_PLANS) {
      try {
        await SubscriptionPlan.create(plan);
      } catch (_) {}
    }
  }

  // 3. Verify the unique partial index exists and is correct.
  const indexes = await Appointment.collection.indexes();
  const hasUniquePartial = indexes.some((idx) =>
    idx.unique === true &&
    idx.partialFilterExpression &&
    String(idx.partialFilterExpression.status) === 'Confirmed' &&
    idx.partialFilterExpression.clinic !== undefined &&
    idx.key.phone === 1 &&
    idx.key.date === 1 &&
    idx.key.time_slot === 1 &&
    idx.key.clinic === 1
  );
  if (!hasUniquePartial) {
    throw new Error('Unique partial index on appointments could not be verified after creation.');
  }

  const hasCallSidIndex = indexes.some((idx) =>
    idx.unique === true &&
    idx.partialFilterExpression &&
    String(idx.partialFilterExpression.status) === 'Confirmed' &&
    idx.key.call_sid === 1
  );
  if (!hasCallSidIndex) {
    throw new Error('Unique partial index on appointments call_sid could not be verified after creation.');
  }

  const clinicIndexes = await Clinic.collection.indexes();
  const hasClinicPhoneIndex = clinicIndexes.some((idx) =>
    idx.unique === true &&
    idx.partialFilterExpression &&
    idx.partialFilterExpression.active === true &&
    idx.key.phone === 1
  );
  if (!hasClinicPhoneIndex) {
    throw new Error('Unique partial index on clinic phone could not be verified after creation.');
  }
}

/** Run a function inside a MongoDB transaction. Fails closed safely if transactions are unsupported or fail.
 * Retries on transient transaction errors (LockTimeout, WriteConflict) up to maxRetries.
 */
async function withTransaction(fn, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    let session = null;
    try {
      session = await mongoose.startSession();
      session.startTransaction();
    } catch (startErr) {
      if (session) {
        try { await session.endSession(); } catch {}
        session = null;
      }
      const err = new Error(`Transaction start failed: ${startErr.message}`);
      err.code = 'TRANSACTION_FAILED';
      err.cause = startErr;
      throw err;
    }

    try {
      const result = await fn(session);
      await session.commitTransaction();
      return result;
    } catch (err) {
      try { await session.abortTransaction(); } catch { /* ignore abort errors */ }

      // Check if the error is transient (e.g. LockTimeout, WriteConflict) and eligible for retry
      const isTransient = (err.errorLabels && (err.errorLabels.includes('TransientTransactionError') || (typeof err.errorLabels.has === 'function' && err.errorLabels.has('TransientTransactionError')))) ||
                          (typeof err.hasErrorLabel === 'function' && err.hasErrorLabel('TransientTransactionError')) ||
                          err.code === 24 || // LockTimeout
                          err.code === 112;  // WriteConflict

      if (isTransient && attempt < maxRetries) {
        if (session) {
          try { await session.endSession(); } catch {}
          session = null;
        }
        await new Promise(resolve => setTimeout(resolve, 25 * attempt));
        continue;
      }

      if (err && (err.code === 11000 || (err.message && err.message.includes('E11000')))) {
        throw err; // preserve duplicate key error for upstream duplicate handlers
      }
      if (!err.code || err.code === 20 || (err.message && err.message.includes('Transaction numbers are only allowed'))) {
        err.code = 'TRANSACTION_FAILED';
      }
      throw err;
    } finally {
      if (session) {
        try { await session.endSession(); } catch {}
      }
    }
  }
}

function createMongoStore({ maxPerSlot = 0 } = {}) {
  // Process-local async mutex to serialize check-then-create within an instance
  // when MongoDB runs in standalone mode (no multi-document transactions)
  // or to prevent write conflicts when running with replica sets.
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

  return {
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
      if (!mongoose.Types.ObjectId.isValid(clinic)) return [];
      return Doctor.find({ clinic }).sort({ createdAt: 1 }).lean();
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
      if (!mongoose.Types.ObjectId.isValid(clinic) || (id && !mongoose.Types.ObjectId.isValid(id))) {
        return null;
      }
      return Doctor.findOne({ _id: id, clinic }).lean();
    },

    async createDoctor(data, opts) {
      let clinic = (opts && typeof opts === 'object') ? opts.clinic : opts;
      if (!clinic && data && data.clinic) {
        clinic = data.clinic;
      }
      if (!clinic) {
        throw new Error('clinic is required for createDoctor');
      }
      if (!mongoose.Types.ObjectId.isValid(clinic)) {
        throw new Error('Invalid clinic ID');
      }
      const doc = await Doctor.create({ ...data, clinic });
      return doc.toObject();
    },

    async createDoctorIfWithinLimit(data, opts = {}) {
      let clinic = (opts && typeof opts === 'object') ? opts.clinic : opts;
      if (!clinic && data && data.clinic) {
        clinic = data.clinic;
      }
      if (!clinic) {
        throw new Error('clinic is required for createDoctorIfWithinLimit');
      }
      if (!mongoose.Types.ObjectId.isValid(clinic)) {
        throw new Error('Invalid clinic ID');
      }
      const maxDoctors = (opts && opts.maxDoctors != null) ? Number(opts.maxDoctors) : Infinity;
      const enforce = !!(opts && opts.enforce);
      const isActiveNew = data.active !== false;

      return withLock(async () => {
        const currentCount = await Doctor.countDocuments({ clinic, active: { $ne: false } });
        if (enforce && isActiveNew && currentCount >= maxDoctors) {
          return { ok: false, reason: 'quota_exceeded', currentUsage: currentCount, limit: maxDoctors };
        }
        const doc = (await Doctor.create({ ...data, clinic })).toObject();
        // Cross-process safety check: if another Node process raced and pushed count over limit, rollback
        if (enforce && isActiveNew && Number.isFinite(maxDoctors)) {
          const afterCount = await Doctor.countDocuments({ clinic, active: { $ne: false } });
          if (afterCount > maxDoctors) {
            await Doctor.findByIdAndDelete(doc._id);
            return { ok: false, reason: 'quota_exceeded', currentUsage: afterCount - 1, limit: maxDoctors };
          }
        }
        return { ok: true, doctor: doc, currentUsage: currentCount, limit: maxDoctors };
      });
    },

    async updateDoctor(docId, data, opts) {
      const clinic = (opts && typeof opts === 'object') ? opts.clinic : opts;
      if (!clinic) {
        throw new Error('clinic is required for updateDoctor');
      }
      if (!mongoose.Types.ObjectId.isValid(clinic) || (docId && !mongoose.Types.ObjectId.isValid(docId))) {
        return null;
      }
      return Doctor.findOneAndUpdate({ _id: docId, clinic }, { $set: data }, { new: true }).lean();
    },

    async updateDoctorIfWithinLimit(docId, data, opts = {}) {
      const clinic = (opts && typeof opts === 'object') ? opts.clinic : opts;
      if (!clinic) {
        throw new Error('clinic is required for updateDoctorIfWithinLimit');
      }
      if (!mongoose.Types.ObjectId.isValid(clinic) || (docId && !mongoose.Types.ObjectId.isValid(docId))) {
        return { ok: false, reason: 'not_found' };
      }
      const maxDoctors = (opts && opts.maxDoctors != null) ? Number(opts.maxDoctors) : Infinity;
      const enforce = !!(opts && opts.enforce);

      return withLock(async () => {
        const existing = await Doctor.findOne({ _id: docId, clinic }).lean();
        if (!existing) {
          return { ok: false, reason: 'not_found' };
        }
        const isReactivating = existing.active === false && data.active === true;
        if (isReactivating) {
          const currentCount = await Doctor.countDocuments({ clinic, active: { $ne: false } });
          if (enforce && currentCount >= maxDoctors) {
            return { ok: false, reason: 'quota_exceeded', currentUsage: currentCount, limit: maxDoctors };
          }
          const updated = await Doctor.findOneAndUpdate({ _id: docId, clinic }, { $set: data }, { new: true }).lean();
          // Cross-process safety check: if concurrent process reactivated/created another doctor and exceeded limit, rollback
          if (enforce && Number.isFinite(maxDoctors)) {
            const afterCount = await Doctor.countDocuments({ clinic, active: { $ne: false } });
            if (afterCount > maxDoctors) {
              await Doctor.findOneAndUpdate({ _id: docId, clinic }, { $set: { active: false } });
              return { ok: false, reason: 'quota_exceeded', currentUsage: afterCount - 1, limit: maxDoctors };
            }
          }
          return {
            ok: true,
            doctor: updated,
            currentUsage: currentCount,
            limit: maxDoctors,
            reactivated: true,
          };
        }

        const updated = await Doctor.findOneAndUpdate({ _id: docId, clinic }, { $set: data }, { new: true }).lean();
        return { ok: true, doctor: updated, reactivated: false };
      });
    },

    async deleteDoctor(docId, opts) {
      const clinic = (opts && typeof opts === 'object') ? opts.clinic : opts;
      if (!clinic) {
        throw new Error('clinic is required for deleteDoctor');
      }
      if (!mongoose.Types.ObjectId.isValid(clinic) || (docId && !mongoose.Types.ObjectId.isValid(docId))) {
        return false;
      }
      const removed = await Doctor.findOneAndDelete({ _id: docId, clinic });
      return !!removed;
    },

    // ----------------------------------------------------------- clinic
    async getClinic(arg1) {
      const clinicId = (arg1 && typeof arg1 === 'object') ? (arg1.clinic || arg1._id) : arg1;
      if (!clinicId) {
        throw new Error('clinic is required for getClinic');
      }
      if (!mongoose.Types.ObjectId.isValid(clinicId)) {
        return null;
      }
      let clinicDoc = await Clinic.findById(clinicId).lean();
      if (!clinicDoc) return null;
      if (!clinicDoc.subscription || !clinicDoc.subscription.trial_ends_at) {
        const defaultSub = {
          status: 'trial',
          plan_id: 'starter_1499',
          trial_ends_at: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
          current_period_start: new Date(),
          current_period_end: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
          payment_provider: 'mock',
          customer_id: '',
          subscription_id: '',
          cancel_at_period_end: false,
          canceled_at: null,
        };
        try {
          // Persist atomically to database so trial_ends_at is permanently fixed
          const updated = await Clinic.findByIdAndUpdate(
            clinicId,
            { $set: { subscription: defaultSub } },
            { new: true }
          ).lean();
          if (updated && updated.subscription) {
            clinicDoc = updated;
          } else {
            clinicDoc.subscription = defaultSub;
          }
        } catch (_) {
          clinicDoc.subscription = defaultSub;
        }
      }
      return clinicDoc;
    },

    async saveClinic(data, opts) {
      const clinicId = (opts && typeof opts === 'object') ? (opts.clinic || opts._id) : (opts || (data && (data.clinic || data._id)));
      if (!clinicId) {
        throw new Error('clinic is required for saveClinic');
      }
      if (!mongoose.Types.ObjectId.isValid(clinicId)) {
        throw new Error('Invalid clinic ID');
      }
      const toSet = Object.assign({}, data);
      delete toSet._id;
      delete toSet.clinic;
      const existing = await Clinic.findById(clinicId);
      if (!existing && !(opts && opts.create)) {
        // Prevent accidental creation when an unknown clinic ID is supplied
        return null;
      }
      if (!existing && (opts && opts.create)) {
        return (await Clinic.create(Object.assign({ _id: clinicId }, toSet))).toObject();
      }
      return Clinic.findByIdAndUpdate(
        clinicId,
        { $set: toSet },
        { new: true }
      ).lean();
    },

    async resolveClinicByPhone(phone) {
      const norm = normalizePhone(phone);
      if (!norm) return { ok: false, reason: 'unknown', clinic: null };
      const digits = norm.replace(/\D/g, '');
      const last10 = digits.slice(-10);
      const query = last10.length >= 7
        ? { phone: { $regex: last10.split('').map(d => d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\D*') } }
        : { phone: { $exists: true, $ne: '' } };
      const candidates = await Clinic.find(query).lean();
      const matches = candidates.filter(c => normalizePhone(c.phone) === norm);
      if (matches.length === 0) {
        return { ok: false, reason: 'unknown', clinic: null };
      }
      if (matches.length > 1) {
        return { ok: false, reason: 'ambiguous', count: matches.length, clinic: null };
      }
      const match = matches[0];
      if (match.active === false) {
        return { ok: false, reason: 'inactive', clinic: match };
      }
      return { ok: true, clinic: match };
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
      if (!clinicId || !mongoose.Types.ObjectId.isValid(clinicId)) return false;
      const res = await Clinic.findByIdAndDelete(clinicId);
      return !!res;
    },

    async listClinics(opts = {}) {
      const { limit = 200 } = opts || {};
      return Clinic.find({}).sort({ createdAt: -1 }).limit(Math.min(Number(limit) || 200, 500)).lean();
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
      // Cross-clinic write protection: if call log already belongs to another clinic,
      // prevent reassigning ownership or modifying another clinic's call log.
      const existing = await CallLog.findOne({ call_sid: callSid }).lean();
      if (existing && existing.clinic && turn.clinic && String(existing.clinic) !== String(turn.clinic)) {
        return existing;
      }
      const clinicToSet = (existing && existing.clinic) || (turn.clinic !== undefined && turn.clinic !== null ? turn.clinic : undefined);
      return CallLog.findOneAndUpdate(
        { call_sid: callSid },
        {
          $set: {
            ...(turn.phone !== undefined ? { phone: turn.phone } : {}),
            ...(turn.status ? { status: turn.status } : {}),
            ...(clinicToSet !== undefined ? { clinic: clinicToSet } : {}),
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
      if (!mongoose.Types.ObjectId.isValid(clinic)) return [];
      const { limit = 100 } = opts || {};
      return CallLog.find({ clinic }).sort({ createdAt: -1 }).limit(Math.min(Number(limit) || 100, 500)).lean();
    },

    async getSession(callSid) {
      if (!callSid) return null;
      return CallSession.findOne({ call_sid: callSid }).lean();
    },

    async saveSession(session) {
      if (!session || !session.call_sid) return null;
      const existing = await CallSession.findOne({ call_sid: session.call_sid }).lean();
      if (existing) {
        if (existing.clinic && session.clinic && String(existing.clinic) !== String(session.clinic)) {
          const err = new Error('Call session already exists for a different clinic');
          err.code = 'SESSION_CLINIC_CONFLICT';
          throw err;
        }
        return CallSession.findOneAndUpdate(
          { call_sid: session.call_sid },
          { $set: session },
          { new: true }
        ).lean();
      }

      // Safe upsert with clinic check to guard against concurrent race
      const filter = session.clinic
        ? { call_sid: session.call_sid, $or: [{ clinic: session.clinic }, { clinic: { $exists: false } }, { clinic: null }] }
        : { call_sid: session.call_sid };

      try {
        return await CallSession.findOneAndUpdate(
          filter,
          { $set: session },
          { upsert: true, new: true, setDefaultsOnInsert: true }
        ).lean();
      } catch (err) {
        if (err.code === 11000 || (err.message && err.message.includes('E11000'))) {
          const errConflict = new Error('Call session already exists for a different clinic');
          errConflict.code = 'SESSION_CLINIC_CONFLICT';
          throw errConflict;
        }
        throw err;
      }
    },

    async clearSession(callSid) {
      if (!callSid) return;
      await CallSession.deleteOne({ call_sid: callSid });
    },

    async findDuplicate({ phone, date, time_slot, clinic }) {
      if (!clinic) {
        throw new Error('clinic is required for findDuplicate');
      }
      if (!mongoose.Types.ObjectId.isValid(clinic)) return null;
      return Appointment.findOne({ phone, date, time_slot, status: 'Confirmed', clinic }).sort({ _id: -1 }).lean();
    },

    async countBooked({ date, time_slot, clinic }) {
      if (!clinic) {
        throw new Error('clinic is required for countBooked');
      }
      if (!mongoose.Types.ObjectId.isValid(clinic)) return 0;
      return Appointment.countDocuments({ date, time_slot, status: 'Confirmed', clinic });
    },

    async createAppointment(data) {
      if (!data || !data.clinic) {
        throw new Error('clinic is required for createAppointment');
      }
      if (!mongoose.Types.ObjectId.isValid(data.clinic)) {
        throw new Error('Invalid clinic ID');
      }
      return (await Appointment.create(data)).toObject();
    },

    /** Atomically check duplicate + slot cap then create. Returns {ok, appointment} or {ok:false, reason}. */
    async createAppointmentIfAvailable(data, maxPerSlot) {
      if (!data || !data.clinic) {
        throw new Error('clinic is required for createAppointmentIfAvailable');
      }
      if (!mongoose.Types.ObjectId.isValid(data.clinic)) {
        throw new Error('Invalid clinic ID');
      }
      const clinic = data.clinic;
      const slotKey = `${clinic}:${data.date}:${data.time_slot}`;
      let slotReserved = false;

      return withLock(async () => {
        try {
          // 1. Duplicate check inside the lock/store (both phone and call_sid)
          const query = Appointment.findOne({
            phone: data.phone,
            date: data.date,
            time_slot: data.time_slot,
            status: 'Confirmed',
            clinic,
          });
          const existing = await query.lean();
          if (existing) {
            return { ok: false, reason: 'duplicate' };
          }

          if (data.call_sid) {
            const existingSid = await Appointment.findOne({
              call_sid: data.call_sid,
              status: 'Confirmed',
            }).lean();
            if (existingSid) {
              return { ok: false, reason: 'duplicate' };
            }
          }

          // 2. Database-level atomic slot capacity across independent processes
          if (maxPerSlot > 0) {
            // Check if SlotReservation exists; initialize synced with confirmed count if absent
            const existingSlot = await SlotReservation.findById(slotKey).lean();
            if (!existingSlot) {
              const actual = await Appointment.countDocuments({
                clinic,
                date: data.date,
                time_slot: data.time_slot,
                status: 'Confirmed',
              });
              await SlotReservation.updateOne(
                { _id: slotKey },
                { $setOnInsert: { _id: slotKey, clinic, date: data.date, time_slot: data.time_slot, booked: actual } },
                { upsert: true }
              );
            }

            // Atomic conditional update on single document in MongoDB
            const reservation = await SlotReservation.findOneAndUpdate(
              { _id: slotKey, booked: { $lt: maxPerSlot } },
              { $inc: { booked: 1 } },
              { new: true }
            );

            if (!reservation) {
              return { ok: false, reason: 'slot_full' };
            }
            slotReserved = true;
          }

          // 3. Create inside the transaction (or standalone)
          const result = await withTransaction(async (session) => {
            const queryOpt = session ? { session } : {};
            const doc = await Appointment.create([data], queryOpt);
            return { ok: true, appointment: doc[0].toObject() };
          });
          return result;
        } catch (err) {
          // Safe rollback: decrement reserved slot count on any creation failure
          if (slotReserved) {
            try {
              await SlotReservation.updateOne(
                { _id: slotKey, booked: { $gt: 0 } },
                { $inc: { booked: -1 } }
              );
            } catch (_) {}
          }

          if (err.code === 11000 || (err.message && err.message.includes('E11000'))) {
            return { ok: false, reason: 'duplicate' };
          }
          throw err;
        }
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
      if (!mongoose.Types.ObjectId.isValid(clinic)) return [];
      const { status, q, date, call_sid, limit = 200 } = opts || {};
      const filter = { clinic };
      if (status) filter.status = status;
      if (date) filter.date = date;
      if (call_sid) filter.call_sid = call_sid;
      if (q) {
        const rx = new RegExp(String(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        filter.$or = [{ name: rx }, { phone: rx }, { reason: rx }];
      }
      return Appointment.find(filter).sort({ createdAt: -1 }).limit(Math.min(Number(limit) || 200, 500)).lean();
    },

    async getAppointment(arg1, arg2) {
      // Support both getAppointment(id) with clinic in arg2, and getAppointment({ _id, clinic })
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
      if (!mongoose.Types.ObjectId.isValid(clinic) || (id && !mongoose.Types.ObjectId.isValid(id))) {
        return null;
      }
      return Appointment.findOne({ _id: id, clinic }).lean();
    },

    async updateAppointmentStatus(id, status, opts) {
      const clinic = (opts && typeof opts === 'object') ? opts.clinic : opts;
      if (!clinic) {
        throw new Error('clinic is required for updateAppointmentStatus');
      }
      if (!mongoose.Types.ObjectId.isValid(clinic) || (id && !mongoose.Types.ObjectId.isValid(id))) {
        return null;
      }
      const prev = await Appointment.findOne({ _id: id, clinic }).lean();
      if (!prev) return null;
      if (prev.status === status) {
        return prev; // idempotent no-op
      }

      if (prev.status === 'Confirmed' && status !== 'Confirmed') {
        const slotKey = `${clinic}:${prev.date}:${prev.time_slot}`;
        try {
          await SlotReservation.updateOne({ _id: slotKey, booked: { $gt: 0 } }, { $inc: { booked: -1 } });
        } catch (_) {}
      } else if (prev.status !== 'Confirmed' && status === 'Confirmed') {
        const slotKey = `${clinic}:${prev.date}:${prev.time_slot}`;
        if (maxPerSlot > 0) {
          const existingSlot = await SlotReservation.findById(slotKey).lean();
          if (!existingSlot) {
            const actual = await Appointment.countDocuments({
              clinic,
              date: prev.date,
              time_slot: prev.time_slot,
              status: 'Confirmed',
            });
            await SlotReservation.updateOne(
              { _id: slotKey },
              { $setOnInsert: { _id: slotKey, clinic, date: prev.date, time_slot: prev.time_slot, booked: actual } },
              { upsert: true }
            );
          }
          const res = await SlotReservation.findOneAndUpdate(
            { _id: slotKey, booked: { $lt: maxPerSlot } },
            { $inc: { booked: 1 } },
            { new: true }
          );
          if (!res) {
            const err = new Error('This time slot is already full');
            err.code = 'SLOT_FULL';
            throw err;
          }
        } else {
          await SlotReservation.updateOne({ _id: slotKey }, { $inc: { booked: 1 } }, { upsert: true });
        }
      }

      const updated = await Appointment.findOneAndUpdate({ _id: id, clinic }, { $set: { status } }, { new: true }).lean();
      return updated;
    },

    async deleteAppointment(id, opts) {
      const clinic = (opts && typeof opts === 'object') ? opts.clinic : opts;
      if (!clinic) {
        throw new Error('clinic is required for deleteAppointment');
      }
      if (!mongoose.Types.ObjectId.isValid(clinic) || (id && !mongoose.Types.ObjectId.isValid(id))) {
        return false;
      }
      const prev = await Appointment.findOne({ _id: id, clinic }).lean();
      if (!prev) return false;
      const removed = await Appointment.findOneAndDelete({ _id: id, clinic });
      if (removed && prev.status === 'Confirmed') {
        const slotKey = `${clinic}:${prev.date}:${prev.time_slot}`;
        try {
          await SlotReservation.updateOne({ _id: slotKey, booked: { $gt: 0 } }, { $inc: { booked: -1 } });
        } catch (_) {}
      }
      return !!removed;
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
      if (!mongoose.Types.ObjectId.isValid(clinic)) {
        return { total: 0, confirmed: 0, incomplete: 0, emergency: 0, abandoned: 0, today: 0 };
      }
      const [total, confirmed, incomplete, emergency, abandoned, today] = await Promise.all([
        Appointment.countDocuments({ clinic }),
        Appointment.countDocuments({ status: 'Confirmed', clinic }),
        Appointment.countDocuments({ status: 'Incomplete', clinic }),
        Appointment.countDocuments({ status: 'Emergency', clinic }),
        Appointment.countDocuments({ status: 'Abandoned', clinic }),
        Appointment.countDocuments({ date: new Date().toLocaleDateString('en-IN'), clinic }),
      ]);
      return { total, confirmed, incomplete, emergency, abandoned, today };
    },

    // ------------------------------------------------------------- leads
    async createLead(data) {
      if (!data) throw new Error('data is required for createLead');
      const scope = data.scope || (data.clinic ? 'clinic' : 'platform');
      if (scope === 'clinic' && !data.clinic) {
        throw new Error('clinic is required for createLead');
      }
      const toInsert = Object.assign({}, data, {
        scope,
        clinic: scope === 'clinic' ? data.clinic : null,
        clinic_name: data.clinic_name || (typeof data.clinic === 'string' && scope === 'platform' ? data.clinic : ''),
      });
      return (await Lead.create(toInsert)).toObject();
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
      if (!mongoose.Types.ObjectId.isValid(clinic)) return [];
      const { limit = 200 } = opts || {};
      return Lead.find({ clinic }).sort({ createdAt: -1 }).limit(Math.min(Number(limit) || 200, 500)).lean();
    },

    async listPlatformLeads(opts = {}) {
      const { limit = 200 } = opts || {};
      const query = {
        $or: [
          { scope: 'platform' },
          {
            scope: { $exists: false },
            clinic: { $not: { $type: 'objectId' } }
          }
        ]
      };
      const raw = await Lead.find(query).sort({ createdAt: -1 }).limit(Math.min(Number(limit) || 200, 500)).lean();
      return raw.map(doc => {
        const isLegacyString = typeof doc.clinic === 'string';
        return Object.assign({}, doc, {
          clinic_name: doc.clinic_name || (isLegacyString ? doc.clinic : ''),
          clinic: isLegacyString ? null : doc.clinic,
          scope: doc.scope || 'platform',
        });
      });
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

    // ------------------------------------------------------------- login protection (MongoDB)
    // Per-IP rate limiting and per-account lockout using atomic MongoDB
    // operations. Fixed minute-aligned windows for rate limiting; count-based
    // lockout with $inc for atomic increment.
    async checkLoginRateLimit(ip, opts = {}) {
      const max = Number(opts.max || 15);
      const windowMs = Number(opts.windowMs || 60000);
      const clinicKey = opts.clinic || 'default';
      const key = `clinic-${clinicKey}:rate:ip:${ip}`;
      const now = new Date();

      // Fixed minute-aligned window: all requests in the same minute share a counter.
      const windowStart = new Date(now.getTime() - (now.getTime() % windowMs));
      const expiresAt = new Date(windowStart.getTime() + windowMs * 2);

      let doc = await LoginAttempt.findOne({ key });
      if (!doc || !doc.windowStart || doc.windowStart.getTime() < windowStart.getTime()) {
        doc = await LoginAttempt.findOneAndUpdate(
          { key },
          { $set: { count: 1, windowStart, expiresAt } },
          { new: true, upsert: true, setDefaultsOnInsert: true }
        );
      } else {
        doc = await LoginAttempt.findOneAndUpdate(
          { key },
          { $inc: { count: 1 }, $set: { expiresAt } },
          { new: true }
        );
      }

      if (doc.count > max) {
        return { allowed: false, remaining: 0, resetAt: new Date(windowStart.getTime() + windowMs) };
      }
      return { allowed: true, remaining: max - doc.count };
    },

    async isAccountLocked(email, opts = {}) {
      const lockoutWindowMs = Number(opts.lockoutWindowMs || 900000);
      const clinicKey = opts.clinic || 'default';
      const key = `clinic-${clinicKey}:lock:email:${email}`;
      const doc = await LoginAttempt.findOne({ key }).lean();
      if (!doc || !doc.lockedUntil) return { locked: false };
      if (new Date() >= new Date(doc.lockedUntil)) {
        // Lock expired - clear it
        await LoginAttempt.deleteOne({ key });
        return { locked: false };
      }
      return { locked: true, lockedUntil: doc.lockedUntil };
    },

    async recordLoginFailure(email, opts = {}) {
      const maxAttempts = Number(opts.maxAttempts || 5);
      const lockoutWindowMs = Number(opts.lockoutWindowMs || 900000);
      const clinicKey = opts.clinic || 'default';
      const key = `clinic-${clinicKey}:lock:email:${email}`;
      const now = new Date();

      // Atomic increment via $inc + upsert
      const doc = await LoginAttempt.findOneAndUpdate(
        { key },
        { $inc: { count: 1 } },
        { new: true, upsert: true, setDefaultsOnInsert: true }
      );

      if (doc.count >= maxAttempts && !doc.lockedUntil) {
        const lockedUntil = new Date(now.getTime() + lockoutWindowMs);
        await LoginAttempt.updateOne({ key }, { $set: { lockedUntil } });
        return { count: doc.count, locked: true, lockedUntil };
      }
      return { count: doc.count, locked: doc.count >= maxAttempts, lockedUntil: doc.lockedUntil };
    },

    async resetLoginFailure(email, opts = {}) {
      const clinicKey = opts.clinic || 'default';
      const key = `clinic-${clinicKey}:lock:email:${email}`;
      await LoginAttempt.deleteOne({ key });
    },

    // ------------------------------------------------------------- subscription plans (MongoDB)
    async createSubscriptionPlan(data) {
      if (!data || !data.plan_id) {
        throw new Error('plan_id is required for createSubscriptionPlan');
      }
      const planId = String(data.plan_id).toLowerCase().trim();
      const price = Number(data.price_inr != null ? data.price_inr : 1499);
      if (isNaN(price) || price < 0) {
        throw new Error('price_inr must be a non-negative number');
      }
      const toCreate = Object.assign({}, data, { plan_id: planId, price_inr: price });
      const plan = await SubscriptionPlan.create(toCreate);
      return plan.toObject();
    },

    async getSubscriptionPlan(planId) {
      if (!planId) return null;
      const key = String(planId).toLowerCase().trim();
      return SubscriptionPlan.findOne({ plan_id: key }).lean();
    },

    async listSubscriptionPlans(opts = {}) {
      const query = opts.activeOnly !== false ? { active: { $ne: false } } : {};
      return SubscriptionPlan.find(query).sort({ price_inr: 1 }).lean();
    },

    async updateSubscriptionPlan(planId, patch = {}) {
      if (!planId) return null;
      const key = String(planId).toLowerCase().trim();
      const toSet = Object.assign({}, patch);
      delete toSet._id;
      delete toSet.plan_id; // plan_id is immutable
      return SubscriptionPlan.findOneAndUpdate({ plan_id: key }, { $set: toSet }, { new: true }).lean();
    },

    // ------------------------------------------------------------- clinic subscription (MongoDB)
    async getClinicSubscription(arg1) {
      const clinicId = (arg1 && typeof arg1 === 'object') ? (arg1.clinic || arg1._id) : arg1;
      if (!clinicId) {
        throw new Error('clinic is required for getClinicSubscription');
      }
      if (!mongoose.Types.ObjectId.isValid(clinicId)) return null;
      const clinicDoc = await Clinic.findById(clinicId).lean();
      if (!clinicDoc) return null;
      const sub = clinicDoc.subscription || {
        status: 'trial',
        plan_id: 'starter_1499',
        trial_ends_at: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
        current_period_start: new Date(),
        current_period_end: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
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
      const id = (clinicId && typeof clinicId === 'object') ? (clinicId.clinic || clinicId._id) : clinicId;
      if (!id) {
        throw new Error('clinic is required for updateClinicSubscription');
      }
      if (!mongoose.Types.ObjectId.isValid(id)) return null;
      const setObj = {};
      for (const [k, v] of Object.entries(patch)) {
        setObj[`subscription.${k}`] = v;
      }
      const updated = await Clinic.findByIdAndUpdate(id, { $set: setObj }, { new: true }).lean();
      if (!updated) return null;
      return {
        clinic_id: updated._id,
        clinic_name: updated.name,
        active: updated.active !== false,
        subscription: updated.subscription,
      };
    },

    // ------------------------------------------------------------- clinic usage (MongoDB)
    async getOrCreateClinicUsage(clinicId, billingMonth) {
      const id = (clinicId && typeof clinicId === 'object') ? (clinicId.clinic || clinicId._id) : clinicId;
      if (!id) {
        throw new Error('clinic is required for getOrCreateClinicUsage');
      }
      if (!mongoose.Types.ObjectId.isValid(id)) {
        throw new Error('Invalid clinic ID for getOrCreateClinicUsage');
      }
      if (!billingMonth || !/^\d{4}-(0[1-9]|1[0-2])$/.test(String(billingMonth).trim())) {
        throw new Error('Valid billing_month (YYYY-MM) is required for getOrCreateClinicUsage');
      }
      const mKey = String(billingMonth).trim();
      return ClinicUsage.findOneAndUpdate(
        { clinic: id, billing_month: mKey },
        {
          $setOnInsert: {
            clinic: id,
            billing_month: mKey,
            call_count: 0,
            call_minutes: 0,
            booking_count: 0,
            whatsapp_count: 0,
          },
        },
        { new: true, upsert: true, setDefaultsOnInsert: true }
      ).lean();
    },

    async recordClinicUsage(clinicId, billingMonth, increments = {}, opts = {}) {
      const id = (clinicId && typeof clinicId === 'object') ? (clinicId.clinic || clinicId._id) : clinicId;
      if (!id) {
        throw new Error('clinic is required for recordClinicUsage');
      }
      if (!mongoose.Types.ObjectId.isValid(id)) {
        throw new Error('Invalid clinic ID for recordClinicUsage');
      }
      if (!billingMonth || !/^\d{4}-(0[1-9]|1[0-2])$/.test(String(billingMonth).trim())) {
        throw new Error('Valid billing_month (YYYY-MM) is required for recordClinicUsage');
      }
      const mKey = String(billingMonth).trim();
      const incObj = {};
      for (const field of ['call_count', 'call_minutes', 'booking_count', 'whatsapp_count']) {
        if (increments[field] != null) {
          const parsed = Number(increments[field]);
          const val = (Number.isFinite(parsed) && parsed > 0) ? Math.floor(parsed) : 0;
          if (val > 0) incObj[field] = val;
        }
      }

      const rawEventId = (opts && opts.eventId) || (increments && increments.event_id) || null;
      const eventId = rawEventId ? String(rawEventId).trim() : null;
      const eventType = (opts && opts.eventType) || (increments && increments.event_type) || 'other';
      const skipCounterIncrement = !!(opts && opts.skipCounterIncrement);

      if (eventId) {
        try {
          await UsageEvent.create({
            event_id: eventId,
            clinic: id,
            billing_month: mKey,
            event_type: eventType,
            increments: {
              call_count: incObj.call_count || 0,
              call_minutes: incObj.call_minutes || 0,
              booking_count: incObj.booking_count || 0,
              whatsapp_count: incObj.whatsapp_count || 0,
            },
          });
        } catch (err) {
          if (err && (err.code === 11000 || (err.message && err.message.includes('E11000')))) {
            const existing = await this.getOrCreateClinicUsage(id, mKey);
            return Object.assign({}, existing, { duplicate: true });
          }
          throw err;
        }

        if (skipCounterIncrement) {
          return this.getOrCreateClinicUsage(id, mKey);
        }
      }

      const update = Object.keys(incObj).length > 0 ? { $inc: incObj } : {};
      try {
        return await ClinicUsage.findOneAndUpdate(
          { clinic: id, billing_month: mKey },
          Object.assign(update, {
            $setOnInsert: {
              clinic: id,
              billing_month: mKey,
            },
          }),
          { new: true, upsert: true, setDefaultsOnInsert: true }
        ).lean();
      } catch (err) {
        // If counter update fails after UsageEvent insert, clean up event so retry can succeed
        if (eventId) {
          try { await UsageEvent.deleteOne({ event_id: eventId }); } catch (_) {}
        }
        throw err;
      }
    },

    async hasUsageEvent(eventId) {
      if (!eventId) return false;
      const doc = await UsageEvent.findOne({ event_id: String(eventId).trim() }).select('_id').lean();
      return !!doc;
    },

    async reserveBookingQuota(clinicId, billingMonth, limit) {
      const id = (clinicId && typeof clinicId === 'object') ? (clinicId.clinic || clinicId._id) : clinicId;
      if (!id || !mongoose.Types.ObjectId.isValid(id)) {
        throw new Error('Valid clinic ID is required for reserveBookingQuota');
      }
      if (!billingMonth || !/^\d{4}-(0[1-9]|1[0-2])$/.test(String(billingMonth).trim())) {
        throw new Error('Valid billing_month (YYYY-MM) is required for reserveBookingQuota');
      }
      const mKey = String(billingMonth).trim();
      const maxLimit = Number(limit);
      if (!Number.isFinite(maxLimit) || maxLimit < 0) {
        return { allowed: true, currentUsage: 0, limit: Infinity };
      }

      // Ensure usage doc exists first
      await this.getOrCreateClinicUsage(id, mKey);

      // Atomic conditional increment: succeeds strictly if booking_count < maxLimit
      const updated = await ClinicUsage.findOneAndUpdate(
        { clinic: id, billing_month: mKey, booking_count: { $lt: maxLimit } },
        { $inc: { booking_count: 1 } },
        { new: true }
      ).lean();

      if (!updated) {
        const current = await ClinicUsage.findOne({ clinic: id, billing_month: mKey }).lean();
        return {
          allowed: false,
          currentUsage: current ? (current.booking_count || 0) : maxLimit,
          limit: maxLimit,
        };
      }
      return {
        allowed: true,
        currentUsage: updated.booking_count,
        limit: maxLimit,
      };
    },

    async releaseBookingQuota(clinicId, billingMonth) {
      const id = (clinicId && typeof clinicId === 'object') ? (clinicId.clinic || clinicId._id) : clinicId;
      if (!id || !mongoose.Types.ObjectId.isValid(id) || !billingMonth) return;
      const mKey = String(billingMonth).trim();
      await ClinicUsage.findOneAndUpdate(
        { clinic: id, billing_month: mKey, booking_count: { $gt: 0 } },
        { $inc: { booking_count: -1 } }
      );
    },

    async getClinicUsage(clinicId, billingMonth) {
      const id = (clinicId && typeof clinicId === 'object') ? (clinicId.clinic || clinicId._id) : clinicId;
      if (!id || !mongoose.Types.ObjectId.isValid(id) || !billingMonth) return null;
      return ClinicUsage.findOne({ clinic: id, billing_month: String(billingMonth).trim() }).lean();
    },

    async listClinicUsage(clinicId, opts = {}) {
      const id = (clinicId && typeof clinicId === 'object') ? (clinicId.clinic || clinicId._id) : clinicId;
      if (!id) {
        throw new Error('clinic is required for listClinicUsage');
      }
      if (!mongoose.Types.ObjectId.isValid(id)) return [];
      const { limit = 24 } = opts;
      return ClinicUsage.find({ clinic: id })
        .sort({ billing_month: -1 })
        .limit(Math.min(Number(limit) || 24, 120))
        .lean();
    },

    // ------------------------------------------------------------- billing: checkout sessions, payment events & invoices (Phase 3)
    async createCheckoutSession(data) {
      if (!data || !data.session_id || !data.clinic) {
        throw new Error('session_id and clinic are required for createCheckoutSession');
      }
      if (!mongoose.Types.ObjectId.isValid(data.clinic)) {
        throw new Error('Invalid clinic ID for createCheckoutSession');
      }
      const doc = await CheckoutSession.create(data);
      return doc.toObject();
    },

    async getCheckoutSession(sessionId, opts = {}) {
      if (!sessionId) return null;
      const query = { session_id: String(sessionId).trim() };
      if (opts && opts.clinic) {
        if (!mongoose.Types.ObjectId.isValid(opts.clinic)) return null;
        query.clinic = opts.clinic;
      }
      return CheckoutSession.findOne(query).lean();
    },

    async updateCheckoutSession(sessionId, patch = {}) {
      if (!sessionId) return null;
      return CheckoutSession.findOneAndUpdate(
        { session_id: String(sessionId).trim() },
        { $set: patch },
        { new: true }
      ).lean();
    },

    async listCheckoutSessions(clinicId, opts = {}) {
      const id = (clinicId && typeof clinicId === 'object') ? (clinicId.clinic || clinicId._id) : clinicId;
      if (!id) throw new Error('clinic is required for listCheckoutSessions');
      if (!mongoose.Types.ObjectId.isValid(id)) return [];
      const { limit = 50 } = opts;
      return CheckoutSession.find({ clinic: id })
        .sort({ createdAt: -1 })
        .limit(Math.min(Number(limit) || 50, 200))
        .lean();
    },

    async recordPaymentEvent(eventData) {
      if (!eventData || !eventData.event_id || !eventData.clinic) {
        throw new Error('event_id and clinic are required for recordPaymentEvent');
      }
      try {
        const doc = await PaymentEvent.create(eventData);
        return { recorded: true, duplicate: false, event: doc.toObject() };
      } catch (err) {
        if (err && (err.code === 11000 || (err.message && err.message.includes('E11000')))) {
          return { recorded: false, duplicate: true };
        }
        throw err;
      }
    },

    async hasPaymentEvent(eventId) {
      if (!eventId) return false;
      const doc = await PaymentEvent.findOne({ event_id: String(eventId).trim() }).select('_id').lean();
      return !!doc;
    },

    async createInvoice(data) {
      if (!data || !data.invoice_number || !data.clinic) {
        throw new Error('invoice_number and clinic are required for createInvoice');
      }
      if (!mongoose.Types.ObjectId.isValid(data.clinic)) {
        throw new Error('Invalid clinic ID for createInvoice');
      }
      const doc = await Invoice.create(data);
      return doc.toObject();
    },

    async getInvoice(invoiceIdOrNumber, opts = {}) {
      const clinic = (opts && typeof opts === 'object') ? opts.clinic : opts;
      if (!clinic) {
        throw new Error('clinic is required for getInvoice');
      }
      if (!mongoose.Types.ObjectId.isValid(clinic) || !invoiceIdOrNumber) return null;
      const key = String(invoiceIdOrNumber).trim();
      const orClauses = [{ invoice_number: key }];
      if (mongoose.Types.ObjectId.isValid(key)) {
        orClauses.push({ _id: key });
      }
      return Invoice.findOne({ clinic, $or: orClauses }).lean();
    },

    async listInvoices(clinicId, opts = {}) {
      const id = (clinicId && typeof clinicId === 'object') ? (clinicId.clinic || clinicId._id) : clinicId;
      if (!id) {
        throw new Error('clinic is required for listInvoices');
      }
      if (!mongoose.Types.ObjectId.isValid(id)) return [];
      const { limit = 50 } = opts;
      return Invoice.find({ clinic: id })
        .sort({ issued_at: -1, createdAt: -1 })
        .limit(Math.min(Number(limit) || 50, 200))
        .lean();
    },
  };
}

module.exports = {
  createMongoStore,
  ensureIndexes,
  withTransaction,
  Appointment,
  CallSession,
  SlotReservation,
  TokenBlocklist,
  LoginAttempt,
  Clinic,
  Doctor,
  User,
  CallLog,
  Lead,
  SubscriptionPlan,
  ClinicUsage,
  UsageEvent,
  Invoice,
  CheckoutSession,
  PaymentEvent,
  DEFAULT_PLANS,
};
