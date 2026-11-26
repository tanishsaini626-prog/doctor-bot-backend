'use strict';
/**
 * payment-service.js — Commercial SaaS Payment Abstraction & MockPaymentService (Phase 3)
 * --------------------------------------------------------------------------
 * Provides:
 * 1. PaymentService abstract interface:
 *    - createCheckoutSession()
 *    - handleWebhook()
 *    - cancelSubscription()
 *    - getPaymentStatus()
 *    - verifyWebhookSignature()
 * 2. MockPaymentService (development/test ONLY; fails closed in production):
 *    - Unique mock checkout session & transaction IDs
 *    - HMAC-SHA256 webhook signature verification (timing-safe)
 *    - Persistent PaymentEvent idempotency & replay prevention
 *    - Subscription lifecycle transitions (activation, renewal, failure + grace period,
 *      cancellation, cancellation at period end, expiry)
 *    - Test invoice generation clearly marked is_test_invoice: true
 * 3. Strict separation between mock and production providers.
 */

const crypto = require('crypto');
const { resolvePlan, getBillingMonth } = require('./subscription');

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const GRACE_PERIOD_DAYS = parseInt(process.env.SUBSCRIPTION_GRACE_DAYS || '3', 10) || 3;
const GRACE_PERIOD_MS = GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000;

function generateId(prefix) {
  const ts = Date.now().toString(36);
  const rand = crypto.randomBytes(6).toString('hex');
  return `${prefix}_${ts}_${rand}`;
}

function generateInvoiceNumber(isTest) {
  const monthCompact = getBillingMonth(new Date()).replace('-', '');
  const suffix = crypto.randomBytes(4).toString('hex').toUpperCase();
  return `${isTest ? 'TEST-INV' : 'INV'}-${monthCompact}-${suffix}`;
}

function sha256Hex(str) {
  return crypto.createHash('sha256').update(String(str || ''), 'utf8').digest('hex');
}

function signWebhookPayload(rawBody, secret) {
  const bodyStr = typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody || {});
  const hmac = crypto.createHmac('sha256', String(secret)).update(bodyStr, 'utf8').digest('hex');
  return `sha256=${hmac}`;
}

function verifyHmacSignature(rawBody, signature, secret) {
  if (!secret || !signature || typeof signature !== 'string') return false;
  const expected = signWebhookPayload(rawBody, secret);
  const sigBuf = Buffer.from(signature.trim(), 'utf8');
  const expBuf = Buffer.from(expected, 'utf8');
  if (sigBuf.length !== expBuf.length) return false;
  return crypto.timingSafeEqual(sigBuf, expBuf);
}

/**
 * Base PaymentService interface.
 * Concrete payment providers (MockPaymentService, future RazorpayPaymentService, etc.)
 * extend this class and implement all contract methods.
 */
class PaymentService {
  constructor(store) {
    this.store = store;
    this.providerName = 'abstract';
  }

  async createCheckoutSession(_params) {
    throw new Error('PaymentService.createCheckoutSession() must be implemented');
  }

  async handleWebhook(_params) {
    throw new Error('PaymentService.handleWebhook() must be implemented');
  }

  async cancelSubscription(_params) {
    throw new Error('PaymentService.cancelSubscription() must be implemented');
  }

  async getPaymentStatus(_params) {
    throw new Error('PaymentService.getPaymentStatus() must be implemented');
  }

  verifyWebhookSignature(_rawBody, _signature) {
    throw new Error('PaymentService.verifyWebhookSignature() must be implemented');
  }
}

/**
 * MockPaymentService — Development and Test Payment Provider.
 *
 * Security invariants:
 * - Strictly forbidden when NODE_ENV === 'production' (fails closed).
 * - Checkout creation ONLY creates a 'pending' session; never activates a subscription.
 * - Subscriptions are activated/updated ONLY via cryptographically signed webhooks.
 * - Every webhook event is deduplicated via persistent PaymentEvent.event_id.
 * - All generated invoices are explicitly marked is_test_invoice: true.
 */
class MockPaymentService extends PaymentService {
  constructor(store, opts = {}) {
    super(store);
    this.providerName = 'mock';
    this._customSecret = opts.webhookSecret || null;
    this.assertMockAllowed();
  }

  assertMockAllowed() {
    if (String(process.env.NODE_ENV || '').toLowerCase() === 'production') {
      const err = new Error('MockPaymentService is forbidden in production (NODE_ENV=production).');
      err.code = 'MOCK_PAYMENT_FORBIDDEN_IN_PRODUCTION';
      err.statusCode = 503;
      throw err;
    }
  }

  getWebhookSecret() {
    this.assertMockAllowed();
    return this._customSecret
      || process.env.PAYMENT_WEBHOOK_SECRET
      || 'medibot-dev-mock-payment-webhook-secret-32chars';
  }

  verifyWebhookSignature(rawBody, signature) {
    this.assertMockAllowed();
    return verifyHmacSignature(rawBody, signature, this.getWebhookSecret());
  }

  async createCheckoutSession({ clinic, plan, userId }) {
    this.assertMockAllowed();
    if (!clinic || !(clinic._id || clinic.id)) {
      const err = new Error('Valid clinic is required to create checkout session');
      err.statusCode = 400;
      throw err;
    }
    if (!plan || !plan.plan_id || plan.active === false) {
      const err = new Error('Valid active subscription plan is required');
      err.statusCode = 400;
      throw err;
    }

    const clinicId = String(clinic._id || clinic.id);
    const sessionId = generateId('mock_cs');

    const session = await this.store.createCheckoutSession({
      session_id: sessionId,
      clinic: clinicId,
      plan_id: plan.plan_id,
      plan_name: plan.name,
      amount_inr: plan.price_inr,
      currency: 'INR',
      provider: 'mock',
      status: 'pending',
      transaction_ref: '',
      is_test: true,
      created_by: userId ? String(userId) : '',
      expires_at: new Date(Date.now() + 30 * 60 * 1000),
    });

    return {
      session_id: session.session_id,
      status: session.status, // strictly 'pending' — never activates subscription directly
      plan_id: session.plan_id,
      plan_name: session.plan_name,
      amount_inr: session.amount_inr,
      currency: session.currency,
      provider: 'mock',
      is_test: true,
      expires_at: session.expires_at,
    };
  }

  async getPaymentStatus({ sessionId, clinicId }) {
    this.assertMockAllowed();
    if (!sessionId || !clinicId) return null;
    const session = await this.store.getCheckoutSession(sessionId, { clinic: clinicId });
    if (!session) return null;
    return {
      session_id: session.session_id,
      status: session.status,
      plan_id: session.plan_id,
      amount_inr: session.amount_inr,
      currency: session.currency,
      transaction_ref: session.transaction_ref || '',
      provider: session.provider,
      is_test: !!session.is_test,
      created_at: session.createdAt,
      updated_at: session.updatedAt,
    };
  }

  async cancelSubscription({ clinic, cancelAtPeriodEnd = true }) {
    this.assertMockAllowed();
    if (!clinic || !(clinic._id || clinic.id)) {
      const err = new Error('Valid clinic is required to cancel subscription');
      err.statusCode = 400;
      throw err;
    }
    const clinicId = String(clinic._id || clinic.id);
    const now = new Date();
    const atPeriodEnd = cancelAtPeriodEnd !== false;

    const patch = {
      status: 'canceled',
      cancel_at_period_end: atPeriodEnd,
      canceled_at: now,
    };
    if (!atPeriodEnd) {
      patch.grace_period_ends_at = null;
    }

    const updated = await this.store.updateClinicSubscription(clinicId, patch);
    return {
      ok: true,
      canceled: true,
      cancel_at_period_end: atPeriodEnd,
      canceled_at: now,
      subscription: updated ? updated.subscription : null,
    };
  }

  async handleWebhook({ rawBody, signature, payload }) {
    this.assertMockAllowed();

    // 1. Cryptographic signature verification (HMAC-SHA256, timing-safe)
    const bodyForSig = typeof rawBody === 'string' ? rawBody : JSON.stringify(payload || {});
    if (!this.verifyWebhookSignature(bodyForSig, signature)) {
      return {
        ok: false,
        statusCode: 401,
        code: 'INVALID_WEBHOOK_SIGNATURE',
        error: 'Invalid or missing payment webhook signature',
      };
    }

    const evt = payload && typeof payload === 'object' ? payload : {};
    const eventId = evt.event_id ? String(evt.event_id).trim() : '';
    const eventType = evt.event_type ? String(evt.event_type).trim() : '';

    if (!eventId || !eventType) {
      return {
        ok: false,
        statusCode: 400,
        code: 'INVALID_WEBHOOK_PAYLOAD',
        error: 'event_id and event_type are required',
      };
    }

    const supportedEvents = [
      'payment.succeeded',
      'payment.failed',
      'subscription.renewed',
      'subscription.canceled',
      'subscription.expired',
    ];
    if (!supportedEvents.includes(eventType)) {
      return {
        ok: false,
        statusCode: 400,
        code: 'UNSUPPORTED_EVENT_TYPE',
        error: `Unsupported webhook event_type: ${eventType}`,
      };
    }

    // 2. Server-side resolution of clinic & checkout session
    let session = null;
    let clinicId = null;
    if (eventType === 'payment.succeeded' || eventType === 'payment.failed') {
      const sessionId = evt.session_id ? String(evt.session_id).trim() : '';
      if (!sessionId) {
        return {
          ok: false,
          statusCode: 400,
          code: 'MISSING_SESSION_ID',
          error: 'session_id is required for payment events',
        };
      }
      session = await this.store.getCheckoutSession(sessionId);
      if (!session) {
        return {
          ok: false,
          statusCode: 404,
          code: 'CHECKOUT_SESSION_NOT_FOUND',
          error: 'Checkout session not found',
        };
      }
      clinicId = String(session.clinic);
      // Reject if webhook payload claims a different clinic than the server-side session
      if (evt.clinic_id && String(evt.clinic_id) !== clinicId) {
        return {
          ok: false,
          statusCode: 403,
          code: 'CLINIC_MISMATCH',
          error: 'Webhook clinic_id does not match checkout session clinic',
        };
      }
    } else {
      clinicId = evt.clinic_id ? String(evt.clinic_id).trim() : '';
      if (!clinicId) {
        return {
          ok: false,
          statusCode: 400,
          code: 'MISSING_CLINIC_ID',
          error: 'clinic_id is required for subscription lifecycle events',
        };
      }
    }

    const clinic = await this.store.getClinic(clinicId);
    if (!clinic) {
      return {
        ok: false,
        statusCode: 404,
        code: 'CLINIC_NOT_FOUND',
        error: 'Clinic not found',
      };
    }

    const transactionRef = evt.transaction_ref
      ? String(evt.transaction_ref).trim()
      : generateId('mock_txn');

    // 3. Persistent idempotency & replay protection
    const eventRecord = await this.store.recordPaymentEvent({
      event_id: eventId,
      provider: 'mock',
      event_type: eventType,
      clinic: clinicId,
      checkout_session_id: session ? session.session_id : '',
      transaction_ref: transactionRef,
      payload_hash: sha256Hex(bodyForSig),
      processed_at: new Date(),
    });

    if (eventRecord.duplicate) {
      return {
        ok: true,
        statusCode: 200,
        duplicate: true,
        event_id: eventId,
        message: 'Duplicate webhook event ignored (idempotent)',
      };
    }

    // 4. Execute verified subscription lifecycle transition & invoice generation
    const now = new Date();
    let updatedSub = null;
    let invoice = null;

    if (eventType === 'payment.succeeded') {
      const plan = await resolvePlan(this.store, session.plan_id);
      const periodStart = now;
      const periodEnd = new Date(now.getTime() + THIRTY_DAYS_MS);
      const customerId = (clinic.subscription && clinic.subscription.customer_id)
        || `mock_cus_${clinicId.slice(-8)}`;
      const subscriptionId = (clinic.subscription && clinic.subscription.subscription_id)
        || generateId('mock_sub');

      await this.store.updateCheckoutSession(session.session_id, {
        status: 'completed',
        transaction_ref: transactionRef,
      });

      updatedSub = await this.store.updateClinicSubscription(clinicId, {
        status: 'active',
        plan_id: session.plan_id,
        current_period_start: periodStart,
        current_period_end: periodEnd,
        grace_period_ends_at: null,
        cancel_at_period_end: false,
        canceled_at: null,
        payment_provider: 'mock',
        customer_id: customerId,
        subscription_id: subscriptionId,
      });

      invoice = await this.store.createInvoice({
        invoice_number: generateInvoiceNumber(true),
        clinic: clinicId,
        clinic_snapshot: {
          name: clinic.name || '',
          phone: clinic.phone || '',
        },
        plan_id: session.plan_id,
        plan_name: session.plan_name || (plan && plan.name) || session.plan_id,
        amount_inr: session.amount_inr,
        currency: 'INR',
        billing_period_start: periodStart,
        billing_period_end: periodEnd,
        status: 'paid',
        transaction_ref: transactionRef,
        checkout_session_id: session.session_id,
        payment_provider: 'mock',
        is_test_invoice: true,
        issued_at: now,
        paid_at: now,
        notes: 'TEST INVOICE — Mock Payment Mode (No real money charged)',
      });
    } else if (eventType === 'payment.failed') {
      const plan = await resolvePlan(this.store, session.plan_id);
      await this.store.updateCheckoutSession(session.session_id, {
        status: 'failed',
        transaction_ref: transactionRef,
      });

      // Only transition active/past_due clinics to past_due with grace period;
      // never activate an expired or trial clinic on a failed payment.
      const currentStatus = (clinic.subscription && clinic.subscription.status) || 'trial';
      if (currentStatus === 'active' || currentStatus === 'past_due') {
        const graceEndsAt = new Date(now.getTime() + GRACE_PERIOD_MS);
        updatedSub = await this.store.updateClinicSubscription(clinicId, {
          status: 'past_due',
          grace_period_ends_at: graceEndsAt,
        });
      }

      invoice = await this.store.createInvoice({
        invoice_number: generateInvoiceNumber(true),
        clinic: clinicId,
        clinic_snapshot: {
          name: clinic.name || '',
          phone: clinic.phone || '',
        },
        plan_id: session.plan_id,
        plan_name: session.plan_name || (plan && plan.name) || session.plan_id,
        amount_inr: session.amount_inr,
        currency: 'INR',
        billing_period_start: now,
        billing_period_end: new Date(now.getTime() + THIRTY_DAYS_MS),
        status: 'failed',
        transaction_ref: transactionRef,
        checkout_session_id: session.session_id,
        payment_provider: 'mock',
        is_test_invoice: true,
        issued_at: now,
        paid_at: null,
        notes: 'TEST INVOICE (PAYMENT FAILED) — Mock Payment Mode',
      });
    } else if (eventType === 'subscription.renewed') {
      const planId = (evt.plan_id && String(evt.plan_id).trim())
        || (clinic.subscription && clinic.subscription.plan_id)
        || 'starter_1499';
      const plan = await resolvePlan(this.store, planId);
      const existingEnd = clinic.subscription && clinic.subscription.current_period_end
        ? new Date(clinic.subscription.current_period_end)
        : now;
      const periodStart = existingEnd > now ? existingEnd : now;
      const periodEnd = new Date(periodStart.getTime() + THIRTY_DAYS_MS);

      updatedSub = await this.store.updateClinicSubscription(clinicId, {
        status: 'active',
        plan_id: plan.plan_id,
        current_period_start: periodStart,
        current_period_end: periodEnd,
        grace_period_ends_at: null,
        cancel_at_period_end: false,
        canceled_at: null,
        payment_provider: 'mock',
      });

      invoice = await this.store.createInvoice({
        invoice_number: generateInvoiceNumber(true),
        clinic: clinicId,
        clinic_snapshot: {
          name: clinic.name || '',
          phone: clinic.phone || '',
        },
        plan_id: plan.plan_id,
        plan_name: plan.name,
        amount_inr: plan.price_inr,
        currency: 'INR',
        billing_period_start: periodStart,
        billing_period_end: periodEnd,
        status: 'paid',
        transaction_ref: transactionRef,
        payment_provider: 'mock',
        is_test_invoice: true,
        issued_at: now,
        paid_at: now,
        notes: 'TEST INVOICE (RENEWAL) — Mock Payment Mode (No real money charged)',
      });
    } else if (eventType === 'subscription.canceled') {
      const atPeriodEnd = evt.cancel_at_period_end === true;
      updatedSub = await this.store.updateClinicSubscription(clinicId, {
        status: 'canceled',
        cancel_at_period_end: atPeriodEnd,
        canceled_at: now,
        ...(atPeriodEnd ? {} : { grace_period_ends_at: null }),
      });
    } else if (eventType === 'subscription.expired') {
      updatedSub = await this.store.updateClinicSubscription(clinicId, {
        status: 'expired',
        grace_period_ends_at: null,
        cancel_at_period_end: false,
      });
    }

    return {
      ok: true,
      statusCode: 200,
      duplicate: false,
      event_id: eventId,
      event_type: eventType,
      transaction_ref: transactionRef,
      subscription: updatedSub ? updatedSub.subscription : clinic.subscription,
      invoice,
    };
  }
}

/**
 * Production provider placeholder — keeps mock and production payment providers
 * completely separated. Fails closed (501/503) until a real gateway is configured.
 */
class UnconfiguredProductionPaymentService extends PaymentService {
  constructor(store, providerName) {
    super(store);
    this.providerName = providerName || 'unconfigured';
  }

  _failClosed() {
    const err = new Error(`Payment provider "${this.providerName}" is not configured for live payments.`);
    err.code = 'PAYMENT_PROVIDER_NOT_CONFIGURED';
    err.statusCode = 503;
    throw err;
  }

  async createCheckoutSession() { this._failClosed(); }
  async handleWebhook() { this._failClosed(); }
  async cancelSubscription() { this._failClosed(); }
  async getPaymentStatus() { this._failClosed(); }
  verifyWebhookSignature() { return false; }
}

/**
 * Factory resolving the active PaymentService based on environment.
 * Fails closed if mock mode is requested in production.
 */
function createPaymentService(store, opts = {}) {
  const isProd = String(process.env.NODE_ENV || '').toLowerCase() === 'production';
  const rawProvider = String(opts.provider || process.env.PAYMENT_PROVIDER || (isProd ? 'unconfigured' : 'mock')).toLowerCase().trim();

  if (isProd && rawProvider === 'mock') {
    const err = new Error('FATAL: PAYMENT_PROVIDER=mock is not permitted in production (NODE_ENV=production).');
    err.code = 'MOCK_PAYMENT_FORBIDDEN_IN_PRODUCTION';
    err.statusCode = 503;
    throw err;
  }

  if (rawProvider === 'mock') {
    return new MockPaymentService(store, opts);
  }

  return new UnconfiguredProductionPaymentService(store, rawProvider);
}

module.exports = {
  PaymentService,
  MockPaymentService,
  UnconfiguredProductionPaymentService,
  createPaymentService,
  signWebhookPayload,
  verifyHmacSignature,
  generateInvoiceNumber,
};
