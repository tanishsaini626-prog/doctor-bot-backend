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

const ClinicSubscriptionSchema = new mongoose.Schema({
  status: {
    type: String,
    enum: ['trial', 'active', 'past_due', 'canceled', 'expired'],
    default: 'trial',
    index: true,
  },
  plan_id: { type: String, default: 'starter_1499', trim: true },
  trial_ends_at: {
    type: Date,
    default: () => new Date(Date.now() + 14 * 24 * 60 * 60 * 1000), // 14-day default trial
  },
  current_period_start: { type: Date, default: Date.now },
  current_period_end: {
    type: Date,
    default: () => new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
  },
  payment_provider: {
    type: String,
    enum: ['mock', 'razorpay', 'manual', 'none'],
    default: 'mock',
  },
  customer_id: { type: String, default: '' },
  subscription_id: { type: String, default: '' },
  cancel_at_period_end: { type: Boolean, default: false },
  canceled_at: { type: Date, default: null },
  grace_period_ends_at: { type: Date, default: null },
}, { _id: false });

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
  onboarding_demo_completed_at: { type: Date, default: null },
  subscription: {
    type: ClinicSubscriptionSchema,
    default: () => ({}),
  },
}, { timestamps: true });

// Prevent duplicate active clinic phone ownership at the database level.
ClinicSchema.index(
  { phone: 1 },
  {
    name: 'unique_active_clinic_phone',
    unique: true,
    partialFilterExpression: { active: true, phone: { $type: 'string', $gt: '' } }
  }
);

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
  role: { type: String, enum: ['platform_admin', 'clinic_owner', 'clinic_staff', 'receptionist', 'admin'], default: 'clinic_staff' },
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

// Marketing-site demo requests (Phase D). Public form -> validated -> stored.
const LeadSchema = new mongoose.Schema({
  name: { type: String, required: true },
  clinic_name: { type: String, default: '' },
  clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', default: null, index: true },
  scope: { type: String, enum: ['platform', 'clinic'], default: 'platform', index: true },
  phone: { type: String, default: '' },
  email: { type: String, default: '' },
  message: { type: String, default: '' },
  source: { type: String, default: 'landing' },   // landing | referral | ...
  consent: { type: Boolean, default: false },      // agreed to be contacted
  ip: { type: String, default: '' },
  user_agent: { type: String, default: '' },
  status: { type: String, default: 'new', index: true },  // new | contacted | converted | spam
}, { timestamps: true });

const Lead = mongoose.model('Lead', LeadSchema);

// ============================================================================
// SaaS Subscription & Usage Data Models (Phase 1)
// ============================================================================

const SubscriptionPlanSchema = new mongoose.Schema({
  plan_id: {
    type: String,
    required: true,
    unique: true,
    index: true,
    trim: true,
    lowercase: true,
  },
  name: { type: String, required: true, trim: true },
  price_inr: { type: Number, required: true, min: 0 },
  billing_interval: { type: String, enum: ['month', 'year'], default: 'month' },
  included_call_minutes: { type: Number, default: 350, min: 0 },
  included_bookings: { type: Number, default: 150, min: 0 },
  max_doctors: { type: Number, default: 2, min: 1 },
  features: { type: [String], default: () => ['hindi_voice', 'whatsapp_alerts', 'analytics'] },
  active: { type: Boolean, default: true },
}, { timestamps: true });

const ClinicUsageSchema = new mongoose.Schema({
  clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true, index: true },
  billing_month: {
    type: String,
    required: true,
    match: /^\d{4}-(0[1-9]|1[0-2])$/, // Format: YYYY-MM
    index: true,
  },
  call_count: { type: Number, default: 0, min: 0 },
  call_minutes: { type: Number, default: 0, min: 0 },
  booking_count: { type: Number, default: 0, min: 0 },
  whatsapp_count: { type: Number, default: 0, min: 0 },
}, { timestamps: true });

// Enforce unique usage record per clinic per billing month for strict tenant isolation
ClinicUsageSchema.index(
  { clinic: 1, billing_month: 1 },
  { name: 'unique_clinic_billing_month', unique: true }
);

// Persistent idempotency ledger for billable usage events (Phase 2.1)
// Guarantees exactly-once counting across retries, concurrency, and restarts.
const UsageEventSchema = new mongoose.Schema({
  event_id: {
    type: String,
    required: true,
    trim: true,
  },
  clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true, index: true },
  billing_month: {
    type: String,
    required: true,
    match: /^\d{4}-(0[1-9]|1[0-2])$/,
    index: true,
  },
  event_type: {
    type: String,
    enum: ['booking', 'call', 'whatsapp', 'other'],
    default: 'other',
  },
  increments: {
    call_count: { type: Number, default: 0, min: 0 },
    call_minutes: { type: Number, default: 0, min: 0 },
    booking_count: { type: Number, default: 0, min: 0 },
    whatsapp_count: { type: Number, default: 0, min: 0 },
  },
}, { timestamps: true });

UsageEventSchema.index(
  { event_id: 1 },
  { name: 'unique_usage_event_id', unique: true }
);

// ============================================================================
// Billing, Invoices, Checkout Sessions & Payment Webhook Events (Phase 3)
// ============================================================================

const InvoiceSchema = new mongoose.Schema({
  invoice_number: { type: String, required: true, trim: true },
  clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true, index: true },
  clinic_snapshot: {
    name: { type: String, default: '' },
    phone: { type: String, default: '' },
  },
  plan_id: { type: String, required: true, trim: true },
  plan_name: { type: String, required: true, trim: true },
  amount_inr: { type: Number, required: true, min: 0 },
  currency: { type: String, default: 'INR' },
  billing_period_start: { type: Date, required: true },
  billing_period_end: { type: Date, required: true },
  status: {
    type: String,
    enum: ['paid', 'failed', 'open', 'void', 'refunded'],
    default: 'open',
    index: true,
  },
  transaction_ref: { type: String, default: '', index: true },
  checkout_session_id: { type: String, default: '' },
  payment_provider: { type: String, default: 'mock' },
  is_test_invoice: { type: Boolean, default: false },
  issued_at: { type: Date, default: Date.now },
  paid_at: { type: Date, default: null },
  notes: { type: String, default: '' },
}, { timestamps: true });

InvoiceSchema.index(
  { invoice_number: 1 },
  { name: 'unique_invoice_number', unique: true }
);

const CheckoutSessionSchema = new mongoose.Schema({
  session_id: { type: String, required: true, trim: true },
  clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true, index: true },
  plan_id: { type: String, required: true, trim: true },
  plan_name: { type: String, default: '' },
  amount_inr: { type: Number, required: true, min: 0 },
  currency: { type: String, default: 'INR' },
  provider: { type: String, default: 'mock' },
  status: {
    type: String,
    enum: ['pending', 'completed', 'failed', 'expired'],
    default: 'pending',
    index: true,
  },
  transaction_ref: { type: String, default: '' },
  is_test: { type: Boolean, default: true },
  created_by: { type: String, default: '' },
  expires_at: {
    type: Date,
    default: () => new Date(Date.now() + 30 * 60 * 1000), // 30 minutes
  },
}, { timestamps: true });

CheckoutSessionSchema.index(
  { session_id: 1 },
  { name: 'unique_checkout_session_id', unique: true }
);

const PaymentEventSchema = new mongoose.Schema({
  event_id: { type: String, required: true, trim: true },
  provider: { type: String, required: true, default: 'mock' },
  event_type: { type: String, required: true },
  clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true, index: true },
  checkout_session_id: { type: String, default: '' },
  transaction_ref: { type: String, default: '' },
  payload_hash: { type: String, default: '' },
  processed_at: { type: Date, default: Date.now },
}, { timestamps: true });

PaymentEventSchema.index(
  { event_id: 1 },
  { name: 'unique_payment_event_id', unique: true }
);

const SubscriptionPlan = mongoose.models.SubscriptionPlan || mongoose.model('SubscriptionPlan', SubscriptionPlanSchema);
const ClinicUsage = mongoose.models.ClinicUsage || mongoose.model('ClinicUsage', ClinicUsageSchema);
const UsageEvent = mongoose.models.UsageEvent || mongoose.model('UsageEvent', UsageEventSchema);
const Invoice = mongoose.models.Invoice || mongoose.model('Invoice', InvoiceSchema);
const CheckoutSession = mongoose.models.CheckoutSession || mongoose.model('CheckoutSession', CheckoutSessionSchema);
const PaymentEvent = mongoose.models.PaymentEvent || mongoose.model('PaymentEvent', PaymentEventSchema);

const DEFAULT_PLANS = Object.freeze([
  {
    plan_id: 'starter_1499',
    name: 'Clinic Starter',
    price_inr: 1499,
    billing_interval: 'month',
    included_call_minutes: 350,
    included_bookings: 150,
    max_doctors: 2,
    features: ['hindi_voice', 'whatsapp_alerts', 'analytics'],
    active: true,
  },
  {
    plan_id: 'growth_2499',
    name: 'Clinic Growth',
    price_inr: 2499,
    billing_interval: 'month',
    included_call_minutes: 750,
    included_bookings: 350,
    max_doctors: 5,
    features: ['hindi_voice', 'whatsapp_alerts', 'analytics', 'priority_support', 'custom_greeting'],
    active: true,
  },
]);

module.exports = {
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
