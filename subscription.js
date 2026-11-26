'use strict';
/**
 * subscription.js - Subscription Validation & Quota Enforcement Engine
 * --------------------------------------------------------------------------
 * Handles:
 * 1. Timezone-aware billing month calculation (Asia/Kolkata).
 * 2. Subscription state evaluation (trial, active, past_due, canceled, expired).
 * 3. Quota calculation and shadow mode / enforcement mode gating.
 * 4. Express middleware (requireActiveSubscription) for dashboard route protection.
 */

const { DEFAULT_PLANS } = require('./models');

/**
 * Returns the current or provided date formatted as YYYY-MM in Asia/Kolkata timezone.
 * Indian healthcare practices operate in IST.
 */
function getBillingMonth(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const validDate = isNaN(d.getTime()) ? new Date() : d;
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
  });
  return formatter.format(validDate);
}

/**
 * Evaluates the authoritative subscription state against current time.
 *
 * Supported States:
 * - trial: valid if now <= trial_ends_at. If expired, transitions to expired.
 * - active: valid if now <= current_period_end. If expired, transitions to past_due.
 * - past_due: payment failed or grace period expired; read-only access only.
 * - canceled: if cancel_at_period_end is true and now <= current_period_end,
 *             remains valid until period ends. Otherwise inactive.
 * - expired: trial or active subscription lapsed; read-only access only.
 */
function evaluateSubscription(subscription) {
  if (!subscription) {
    return {
      status: 'expired',
      rawStatus: 'none',
      valid: false,
      reason: 'No subscription record found',
      canBook: false,
      canMutate: false,
    };
  }

  const rawStatus = subscription.status || 'trial';
  const now = new Date();

  // 1. Trial status
  if (rawStatus === 'trial') {
    const trialEnd = subscription.trial_ends_at ? new Date(subscription.trial_ends_at) : null;
    if (trialEnd && now > trialEnd) {
      return {
        status: 'expired',
        rawStatus: 'trial',
        valid: false,
        reason: 'Free trial period has expired',
        canBook: false,
        canMutate: false,
        trial_ended: true,
        trial_ends_at: trialEnd,
      };
    }
    return {
      status: 'trial',
      rawStatus: 'trial',
      valid: true,
      reason: 'Free trial active',
      canBook: true,
      canMutate: true,
      trial_ends_at: trialEnd,
    };
  }

  // 2. Active status
  if (rawStatus === 'active') {
    const periodEnd = subscription.current_period_end ? new Date(subscription.current_period_end) : null;
    if (periodEnd && now > periodEnd) {
      return {
        status: 'past_due',
        rawStatus: 'active',
        valid: false,
        reason: 'Subscription period ended; payment is past due',
        canBook: false,
        canMutate: false,
        period_ended: true,
        current_period_end: periodEnd,
      };
    }
    return {
      status: 'active',
      rawStatus: 'active',
      valid: true,
      reason: 'Subscription active and current',
      canBook: true,
      canMutate: true,
      current_period_end: periodEnd,
    };
  }

  // 3. Canceled status
  if (rawStatus === 'canceled') {
    const periodEnd = subscription.current_period_end ? new Date(subscription.current_period_end) : null;
    if (subscription.cancel_at_period_end && periodEnd && now <= periodEnd) {
      return {
        status: 'canceled',
        rawStatus: 'canceled',
        valid: true,
        reason: 'Subscription scheduled for cancellation at end of billing period',
        canBook: true,
        canMutate: true,
        active_until: periodEnd,
        cancel_at_period_end: true,
      };
    }
    return {
      status: 'canceled',
      rawStatus: 'canceled',
      valid: false,
      reason: 'Subscription is canceled',
      canBook: false,
      canMutate: false,
      cancel_at_period_end: false,
    };
  }

  // 4. Past-due status (with optional grace period handling)
  if (rawStatus === 'past_due') {
    const graceEnd = subscription.grace_period_ends_at ? new Date(subscription.grace_period_ends_at) : null;
    if (graceEnd && !isNaN(graceEnd.getTime())) {
      if (now <= graceEnd) {
        return {
          status: 'past_due',
          rawStatus: 'past_due',
          valid: true,
          in_grace_period: true,
          grace_period_ends_at: graceEnd,
          reason: 'Subscription payment is past due (within grace period)',
          canBook: true,
          canMutate: true,
        };
      }
      return {
        status: 'expired',
        rawStatus: 'past_due',
        valid: false,
        in_grace_period: false,
        grace_period_ended: true,
        grace_period_ends_at: graceEnd,
        reason: 'Subscription grace period has expired',
        canBook: false,
        canMutate: false,
      };
    }
    return {
      status: 'past_due',
      rawStatus: 'past_due',
      valid: false,
      in_grace_period: false,
      reason: 'Subscription payment is past due',
      canBook: false,
      canMutate: false,
    };
  }

  // 5. Expired status
  if (rawStatus === 'expired') {
    return {
      status: 'expired',
      rawStatus: 'expired',
      valid: false,
      reason: 'Subscription has expired',
      canBook: false,
      canMutate: false,
    };
  }

  // Unknown fallback
  return {
    status: 'expired',
    rawStatus,
    valid: false,
    reason: 'Unknown subscription state',
    canBook: false,
    canMutate: false,
  };
}

/**
 * Checks whether quota enforcement is active or running in shadow mode.
 * Defaults to false (shadow mode) unless explicitly set to 'true'.
 */
function isQuotaEnforced() {
  return String(process.env.ENFORCE_SUBSCRIPTION_QUOTAS || 'false').toLowerCase() === 'true';
}

/**
 * Resolves a subscription plan from store or default fallback.
 */
async function resolvePlan(store, planId) {
  const targetId = String(planId || 'starter_1499').toLowerCase().trim();
  let plan = null;
  try {
    if (store && typeof store.getSubscriptionPlan === 'function') {
      plan = await store.getSubscriptionPlan(targetId);
    }
  } catch (_) {}
  if (!plan && Array.isArray(DEFAULT_PLANS)) {
    plan = DEFAULT_PLANS.find(p => p.plan_id === targetId) || DEFAULT_PLANS[0];
  }
  return plan;
}

/**
 * Checks plan quota for a clinic.
 * Returns: { allowed, shadow, limit, currentUsage, metric, shadowWarning }
 */
async function checkQuota({ store, clinicId, planId, metric, billingMonth, count = 1, currentCount = null }) {
  const enforced = isQuotaEnforced();
  const plan = await resolvePlan(store, planId);
  const m = billingMonth || getBillingMonth();

  let limit = Infinity;
  let usageVal = 0;

  if (metric === 'bookings') {
    limit = (plan && plan.included_bookings != null) ? plan.included_bookings : 150;
    if (currentCount != null) {
      usageVal = currentCount;
    } else if (store && typeof store.getClinicUsage === 'function') {
      const usageDoc = await store.getClinicUsage(clinicId, m);
      usageVal = usageDoc ? (usageDoc.booking_count || 0) : 0;
    }
  } else if (metric === 'call_minutes') {
    limit = (plan && plan.included_call_minutes != null) ? plan.included_call_minutes : 350;
    if (currentCount != null) {
      usageVal = currentCount;
    } else if (store && typeof store.getClinicUsage === 'function') {
      const usageDoc = await store.getClinicUsage(clinicId, m);
      usageVal = usageDoc ? (usageDoc.call_minutes || 0) : 0;
    }
  } else if (metric === 'max_doctors') {
    limit = (plan && plan.max_doctors != null) ? plan.max_doctors : 2;
    if (currentCount != null) {
      usageVal = currentCount;
    } else if (store && typeof store.listDoctors === 'function') {
      const doctors = await store.listDoctors({ clinic: clinicId });
      usageVal = (doctors || []).filter(d => d.active !== false).length;
    }
  }

  const wouldExceed = (usageVal + count) > limit;

  if (wouldExceed) {
    if (enforced) {
      return {
        allowed: false,
        enforced: true,
        limit,
        currentUsage: usageVal,
        metric,
        reason: `Monthly plan limit reached for ${metric} (${usageVal}/${limit})`,
      };
    } else {
      return {
        allowed: true,
        enforced: false,
        limit,
        currentUsage: usageVal,
        metric,
        shadowWarning: `Plan quota exceeded for ${metric}: ${usageVal}/${limit} (shadow mode)`,
      };
    }
  }

  return {
    allowed: true,
    enforced,
    limit,
    currentUsage: usageVal,
    metric,
  };
}

/**
 * Express middleware to enforce active subscription for dashboard mutating routes.
 *
 * Rules:
 * - platform_admin always has access.
 * - clinic_owner and clinic_staff can perform mutations only if subscription evaluates to valid (canMutate === true).
 * - Read-only GET requests bypass this middleware to guarantee historical data access.
 */
function createSubscriptionMiddleware(store) {
  return async function requireActiveSubscription(req, res, next) {
    // 1. Platform admin bypasses clinic subscription restrictions
    if (req.user && req.user.role === 'platform_admin') {
      return next();
    }

    const clinicId = req.user && req.user.clinic;
    if (!clinicId) {
      return res.status(403).json({ error: 'Clinic not assigned' });
    }

    try {
      let clinic = await store.getClinic(clinicId);
      if (!clinic) {
        // Auto-provision trial clinic record for legacy clinics or tests that have not run onboarding
        try {
          clinic = await store.saveClinic({ name: 'Clinic ' + clinicId, active: true }, { clinic: clinicId, create: true });
        } catch (_) {}
      }
      if (!clinic) {
        return res.status(404).json({ error: 'Clinic not found' });
      }

      const evaluation = evaluateSubscription(clinic.subscription);
      req.clinicSubscription = evaluation;

      if (!evaluation.canMutate) {
        return res.status(402).json({
          error: 'Subscription inactive or expired',
          code: 'SUBSCRIPTION_INACTIVE',
          status: evaluation.status,
          reason: evaluation.reason,
          trial_ended: !!evaluation.trial_ended,
          period_ended: !!evaluation.period_ended,
        });
      }

      next();
    } catch (err) {
      console.error('Subscription validation failed:', err.message);
      res.status(500).json({ error: 'Failed to validate subscription status' });
    }
  };
}

module.exports = {
  getBillingMonth,
  evaluateSubscription,
  checkQuota,
  isQuotaEnforced,
  resolvePlan,
  createSubscriptionMiddleware,
};
