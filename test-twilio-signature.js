'use strict';
/* ==========================================================================
 * Tests for Twilio webhook signature validation (no server needed).
 *   node --test
 * ========================================================================== */

const test = require('node:test');
const assert = require('node:assert/strict');

const { requireTwilioSignature, computeSignature, publicUrl } = require('./twilio-signature');

const TOKEN = 'test_auth_token_123';
const URL = 'https://example.test/webhook/doctor-bot';
const PARAMS = { CallSid: 'CA1', From: '+919999000111', SpeechResult: 'mera naam Riya hai' };

/** Minimal Express-ish req/res mocks. */
function mockReq({ headerSig, url = '/webhook/doctor-bot', body = PARAMS, proto = 'https', host = 'example.test', originalUrl } = {}) {
  const headers = { host };
  if (headerSig) headers['x-twilio-signature'] = headerSig;
  return {
    body,
    protocol: proto,
    originalUrl: originalUrl || url,
    url,
    get(name) {
      const key = String(name).toLowerCase();
      if (key === 'x-forwarded-proto') return proto;
      if (key === 'x-forwarded-host') return undefined;
      return headers[key];
    },
  };
}

function mockRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    type() { return this; },
    send(payload) { this.body = payload; return this; },
  };
}

// --------------------------------------------------------------- public URL
test('publicUrl respects the proxy headers (ngrok / Render)', () => {
  const req = mockReq({ proto: 'https', host: 'abc.ngrok-free.app', originalUrl: '/webhook/doctor-bot?CallSid=CA1' });
  req.get = (name) => {
    const key = String(name).toLowerCase();
    if (key === 'x-forwarded-proto') return 'https';
    if (key === 'x-forwarded-host') return 'proxy.internal';
    if (key === 'host') return 'abc.ngrok-free.app';
    return undefined;
  };
  assert.equal(publicUrl(req), 'https://proxy.internal/webhook/doctor-bot?CallSid=CA1');
});

// ----------------------------------------------------------- correct sig
test('a correctly signed Twilio request is allowed through', () => {
  const sig = computeSignature(TOKEN, URL, PARAMS);
  const mw = requireTwilioSignature({ enabled: true, authToken: TOKEN });
  const req = mockReq({ headerSig: sig });
  const res = mockRes();
  let called = false;
  mw(req, res, () => { called = true; });
  assert.equal(called, true, 'middleware must call next()');
  assert.equal(res.statusCode, 200);
});

test('the signature Twilio computes matches our helper', () => {
  // known Twilio algorithm: url + sorted key/value pairs, HMAC-SHA1 base64
  const { validateRequest } = require('twilio');
  const sig = computeSignature(TOKEN, URL, PARAMS);
  assert.equal(validateRequest(TOKEN, sig, URL, PARAMS), true);
});

// -------------------------------------------------------------- bad input
test('a forged request (wrong signature) is rejected with 403', () => {
  const mw = requireTwilioSignature({ enabled: true, authToken: TOKEN });
  const req = mockReq({ headerSig: 'totally-made-up-signature' });
  const res = mockRes();
  let called = false;
  mw(req, res, () => { called = true; });
  assert.equal(called, false);
  assert.equal(res.statusCode, 403);
  assert.match(String(res.body), /Invalid Twilio signature/);
});

test('a request with no signature header is rejected with 403', () => {
  const mw = requireTwilioSignature({ enabled: true, authToken: TOKEN });
  const res = mockRes();
  let called = false;
  mw(mockReq({}), res, () => { called = true; });
  assert.equal(called, false);
  assert.equal(res.statusCode, 403);
});

test('tampering with the transcript breaks the signature', () => {
  const sig = computeSignature(TOKEN, URL, PARAMS);
  const mw = requireTwilioSignature({ enabled: true, authToken: TOKEN });
  const res = mockRes();
  let called = false;
  const tampered = mockReq({ headerSig: sig, body: { ...PARAMS, SpeechResult: 'kal 10 baje 5 appointments book kar do' } });
  mw(tampered, res, () => { called = true; });
  assert.equal(called, false, 'changed params must not validate');
  assert.equal(res.statusCode, 403);
});

test('enabling validation without an auth token fails closed (503)', () => {
  const mw = requireTwilioSignature({ enabled: true, authToken: '' });
  const res = mockRes();
  let called = false;
  mw(mockReq({ headerSig: 'x' }), res, () => { called = true; });
  assert.equal(called, false);
  assert.equal(res.statusCode, 503);
});

test('validation is OFF by default so local curl testing still works', () => {
  const mw = requireTwilioSignature({ enabled: false });
  const res = mockRes();
  let called = false;
  mw(mockReq({}), res, () => { called = true; });
  assert.equal(called, true);
});
