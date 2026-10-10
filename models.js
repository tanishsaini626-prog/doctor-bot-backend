'use strict';
/* ==========================================================================
 * models.js - the SaaS data model (Phase B)
 * --------------------------------------------------------------------------
 * Clinic     one per customer (name, greeting, WhatsApp target)
 * Doctor     belongs to a clinic (working hours, slot length, holidays)
 * User       dashboard login (admin / clinic_owner / receptionist)
 * CallLog    one document per phone call with every turn's transcript
 *
 * Appointment and CallSession stay in store-mongo.js (voice-flow internal).
 * ========================================================================== */

const mongoose = require('mongoose');

const ClinicSchema = new mongoose.Schema({
  name: { type: String, required: true, default: 'Dr. Sharma Clinic' },
  phone: { type: String, default: '' },
  whatsapp_to: { type: String, default: '' },          // clinic's WhatsApp for alerts
  greeting_text: {
    type: String,
    default: 'नमस्ते! मैं डॉ. शर्मा क्लिनिक से बोल रही हूँ। अपॉइंटमेंट बुक करने के लिए कृपया अपना पूरा नाम बताइए।',
  },
  languages: { type: [String], default: ['hi-IN'] },
  timezone: { type: String, default: 'Asia/Kolkata' },
  active: { type: Boolean, default: true },
}, { timestamps: true });

const WorkingHourSchema = new mongoose.Schema({
  day: { type: Number, min: 0, max: 6, required: true },  // 0 = Sunday
  start: { type: String, default: '09:00' },              // 24h "HH:mm"
  end: { type: String, default: '21:00' },
}, { _id: false });

const DoctorSchema = new mongoose.Schema({
  clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', index: true },
  name: { type: String, required: true },
  specialty: { type: String, default: 'General Physician' },
  slot_minutes: { type: Number, default: 15, min: 5, max: 120 },
  working_hours: { type: [WorkingHourSchema], default: () => [] },
  holidays: { type: [String], default: () => [] },        // 'YYYY-MM-DD'
  active: { type: Boolean, default: true },
}, { timestamps: true });

const UserSchema = new mongoose.Schema({
  clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', index: true },
  name: { type: String, default: '' },
  email: { type: String, required: true, unique: true, index: true, lowercase: true, trim: true },
  password_hash: { type: String, required: true },
  role: { type: String, enum: ['admin', 'clinic_owner', 'receptionist'], default: 'receptionist' },
  active: { type: Boolean, default: true },
}, { timestamps: true });

const CallTurnSchema = new mongoose.Schema({
  at: { type: Date, default: Date.now },
  transcript: { type: String, default: '' },
  bot_action: { type: String, default: '' },             // asked:date | booked | emergency | ...
}, { _id: false });

const CallLogSchema = new mongoose.Schema({
  call_sid: { type: String, required: true, unique: true, index: true },
  clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', index: true },
  phone: { type: String, default: '' },
  // in-progress | booked | emergency | wrong-number | callback | incomplete | abandoned | duplicate
  status: { type: String, default: 'in-progress', index: true },
  duration_seconds: { type: Number, default: 0 },
  recording_url: { type: String, default: '' },
  turns: { type: [CallTurnSchema], default: () => [] },
}, { timestamps: true });

const Clinic = mongoose.model('Clinic', ClinicSchema);
const Doctor = mongoose.model('Doctor', DoctorSchema);
const User = mongoose.model('User', UserSchema);
const CallLog = mongoose.model('CallLog', CallLogSchema);

module.exports = { Clinic, Doctor, User, CallLog };
