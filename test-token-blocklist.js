'use strict';
/* ==========================================================================
 * test-token-blocklist.js - Token blocklist persistence & shared revocation (item 1).
 *
 * Verifies that JWT revocation persists across restarts (file-backed store)
 * and across multiple independent server instances sharing MongoDB.
 *
 *   node --test test-token-blocklist.js
 * ========================================================================== */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

const { createFileStore } = require('./store-file');
const { createMongoStore, TokenBlocklist } = require('./store-mongo');
const { createAuth } = require('./auth');

// ---------------------------------------------------------------------------
// Helper: build a short-lived JWT for testing
// ---------------------------------------------------------------------------
function makeToken(jti, secret = 'test-secret-0123456789abcdef0123456789abcdef') {
  return jwt.sign(
    { sub: 'user-1', email: 'admin@test.local', role: 'admin', clinic: null, jti },
    secret,
    { expiresIn: '12h' }
  );
}

// ---------------------------------------------------------------------------
// 1. Blocklist persists across a simulated restart (file store)
// ---------------------------------------------------------------------------
test('token blocklist persists across file-store restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'medibot-blocklist-'));
  const file = path.join(dir, 'store.json');

  try {
    const s1 = createFileStore(file);
    const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000);
    await s1.createTokenBlocklist('jti-revoked-1', expiresAt);
    await s1.flush(); // force disk write before "restart"

    // Simulate restart: new store instance reading the same file.
    const s2 = createFileStore(file);
    assert.equal(await s2.isTokenBlocked('jti-revoked-1'), true,
      'revoked jti still blocked after restart');
    assert.equal(await s2.isTokenBlocked('jti-valid-1'), false,
      'non-blocked jti not blocked');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 2. requireAuth rejects a revoked token (through createAuth)
// ---------------------------------------------------------------------------
test('requireAuth rejects a token present in the blocklist', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'medibot-blocklist-'));
  const file = path.join(dir, 'store.json');

  try {
    const store = createFileStore(file);
    const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000);
    await store.createTokenBlocklist('jti-revoked-2', expiresAt);

    process.env.JWT_SECRET = 'test-secret-0123456789abcdef0123456789abcdef';
    const { requireAuth } = createAuth(store, async () => {});

    // Capture the response
    let statusCode = null;
    let body = null;
    const res = {
      status(code) { statusCode = code; return this; },
      json(obj) { body = obj; return this; },
    };

    // Build a fake req with the revoked token
    const token = makeToken('jti-revoked-2');
    const req = { headers: { authorization: 'Bearer ' + token } };

    await requireAuth(req, res, () => {
      throw new Error('next() should not be called for revoked token');
    });

    assert.equal(statusCode, 401, 'revoked token returns 401');
    assert.equal(body.error, 'Token has been revoked', 'revoked token error message');

    // Non-blocked token should pass
    statusCode = null; body = null;
    const req2 = { headers: { authorization: 'Bearer ' + makeToken('jti-valid-2') } };
    await requireAuth(req2, res, () => { /* next called - good */ });
    assert.equal(statusCode, null, 'valid token does not return 401');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 3. Blocklist entry expires (isTokenBlocked returns false after expiry)
// ---------------------------------------------------------------------------
test('expired blocklist entry is not blocked', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'medibot-blocklist-'));
  const file = path.join(dir, 'store.json');

  try {
    const store = createFileStore(file);
    const expiredAt = new Date(Date.now() - 1000); // already expired
    await store.createTokenBlocklist('jti-expired', expiredAt);

    assert.equal(await store.isTokenBlocked('jti-expired'), false,
      'expired jti is not blocked');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 4. Logout route revokes a token end-to-end (via auth router)
// ---------------------------------------------------------------------------
test('logout route revokes token via createTokenBlocklist', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'medibot-blocklist-'));
  const file = path.join(dir, 'store.json');

  try {
    const store = createFileStore(file);
    process.env.JWT_SECRET = 'test-secret-0123456789abcdef0123456789abcdef';
    const { router } = createAuth(store, async () => {});

    const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000);
    await store.createTokenBlocklist('jti-logout', expiresAt);
    assert.equal(await store.isTokenBlocked('jti-logout'), true,
      'logout-revoked token is blocked');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 5. Shared token revocation across separate application instances (MongoDB)
// ---------------------------------------------------------------------------
test('shared token revocation across separate application instances via MongoDB', async () => {
  const MONGO_URI = 'mongodb://127.0.0.1:27017/medibot-test-shared-revocation';
  await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 5000 });

  try {
    await TokenBlocklist.deleteMany({});

    // Instance A and Instance B represent two separate server instances
    // backed by the same shared MongoDB database.
    const storeA = createMongoStore();
    const storeB = createMongoStore();

    process.env.JWT_SECRET = 'test-secret-0123456789abcdef0123456789abcdef';
    const authA = createAuth(storeA, async () => {});
    const authB = createAuth(storeB, async () => {});

    const jti = 'jti-shared-instance-999';
    const token = makeToken(jti);

    // Step A: Before revocation, Instance B accepts the token.
    let passedB = false;
    const reqBefore = { headers: { authorization: 'Bearer ' + token } };
    await authB.requireAuth(reqBefore, {}, () => { passedB = true; });
    assert.equal(passedB, true, 'Instance B accepts valid token prior to revocation on Instance A');

    // Step B: User logs out on Instance A -> storeA records revocation in MongoDB.
    const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000);
    await storeA.createTokenBlocklist(jti, expiresAt);

    // Step C: Instance B immediately sees the token is blocked in the shared database.
    const isBlockedOnB = await storeB.isTokenBlocked(jti);
    assert.equal(isBlockedOnB, true, 'Instance B immediately detects token revocation executed by Instance A');

    // Step D: An incoming request to Instance B with that token is rejected with 401.
    let statusCodeB = null;
    let bodyB = null;
    const resB = {
      status(c) { statusCodeB = c; return this; },
      json(j) { bodyB = j; return this; },
    };
    const reqAfter = { headers: { authorization: 'Bearer ' + token } };
    await authB.requireAuth(reqAfter, resB, () => {
      throw new Error('Instance B should not allow revoked token through requireAuth');
    });
    assert.equal(statusCodeB, 401, 'Instance B returns 401 for token revoked on Instance A');
    assert.equal(bodyB.error, 'Token has been revoked', 'Instance B reports revocation message');

    // Step E: Unrevoked token for another user/session is still accepted on Instance B.
    let passedOther = false;
    const otherToken = makeToken('jti-other-valid-session');
    await authB.requireAuth({ headers: { authorization: 'Bearer ' + otherToken } }, {}, () => {
      passedOther = true;
    });
    assert.equal(passedOther, true, 'Instance B continues to accept unrevoked tokens');

    // Step F: Expired blocklist entry in MongoDB is not considered blocked.
    await storeA.createTokenBlocklist('jti-expired-mongo', new Date(Date.now() - 1000));
    assert.equal(await storeB.isTokenBlocked('jti-expired-mongo'), false,
      'Instance B ignores expired revocation entry in MongoDB');
  } finally {
    await TokenBlocklist.deleteMany({});
    await mongoose.disconnect();
  }
});
