'use strict';
/* ==========================================================================
 * twilio-signature.js - proof that a webhook call really came from Twilio
 * --------------------------------------------------------------------------
 * Twilio signs every webhook request with HMAC-SHA1 over (full URL + sorted
 * POST params) using the account's Auth Token, and sends it in the
 * X-Twilio-Signature header. Faking a booking or listening to someone's call
 * then requires the secret token.
 *
 * Enabled with TWILIO_VALIDATE_SIGNATURE=true in .env (needs TWILIO_AUTH_TOKEN).
 * Off by default so local curl/ngrok testing keeps working during development.
 * ========================================================================== */

const twilio = require('twilio');

/** Rebuilds the exact URL Twilio signed (proxy-aware: ngrok, Render, Vercel, multi-proxy chains). */
function publicUrl(req) {
  const rawProto = req.get('x-forwarded-proto') || req.protocol || 'https';
  // If behind multiple reverse proxies (e.g. Cloudflare -> ALB -> Node), take the first (client-facing) proto
  const proto = String(rawProto).split(',')[0].trim() || 'https';
  const rawHost = req.get('x-forwarded-host') || req.get('host') || '';
  // Similarly, take the client-facing host if multiple comma-separated proxy hosts exist
  const host = String(rawHost).split(',')[0].trim();
  return `${proto}://${host}${req.originalUrl || req.url}`;
}

/** Returns an Express middleware. Signature checked only for enabled routes. */
function requireTwilioSignature(options) {
  const opts = options || {};
  const enabled = () => {
    // F-06: Production MUST never permit disabling signature verification
    if (process.env.NODE_ENV === 'production') {
      return true;
    }
    if (opts.enabled !== undefined) return opts.enabled;
    const envVal = String(process.env.TWILIO_VALIDATE_SIGNATURE || '').toLowerCase();
    if (envVal === 'true') return true;
    if (envVal === 'false') return false;
    return false;
  };
  const authToken = () => opts.authToken !== undefined ? opts.authToken : process.env.TWILIO_AUTH_TOKEN;

  return function (req, res, next) {
    if (!enabled()) return next();                       // local development mode
    const token = authToken();
    if (!token) {
      console.error('TWILIO_VALIDATE_SIGNATURE=true but TWILIO_AUTH_TOKEN is missing');
      return res.status(503).type('text/plain').send('Signature validation not configured');
    }
    const signature = req.get('x-twilio-signature');
    if (!signature) return res.status(403).type('text/plain').send('Missing X-Twilio-Signature');

    const url = publicUrl(req);
    const params = req.method === 'GET' ? {} : (req.body || {});
    const valid = twilio.validateRequest(token, signature, url, params);
    if (!valid) {
      console.warn('Rejected forged Twilio webhook for', url);
      return res.status(403).type('text/plain').send('Invalid Twilio signature');
    }
    next();
  };
}

/** Computes a correct signature the same way Twilio does (used by tests). */
function computeSignature(authToken, url, params) {
  const crypto = require('crypto');
  const data = Object.keys(params).sort().reduce((acc, key) => acc + key + params[key], url);
  return crypto.createHmac('sha1', authToken).update(Buffer.from(data, 'utf-8')).digest('base64');
}

module.exports = { requireTwilioSignature, computeSignature, publicUrl };
