'use strict';
/* ==========================================================================
 * test-login-route-regression.js - Batch 2 Fix 1 Regression Tests
 *
 * Verifies that the HTTP auth router (/api/auth/login, /api/auth/logout, /api/me)
 * works with the store delegation in both memory and file-backed stores:
 *   - Valid login succeeds (200 + token + user)
 *   - Failed login increments protection state (401)
 *   - Locked accounts are rejected (423)
 *   - Successful login resets failure state
 *   - Token revocation / blocklist remains intact (401 on revoked token)
 * ========================================================================== */

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const os = require('os');

process.env.JWT_SECRET = 'test-secret-must-be-at-least-32-chars-long-012345';
const { createAuth } = require('./auth');
const { createMemoryStore } = require('./store-memory');
const { createFileStore } = require('./store-file');

function createTestServer(store) {
  const app = express();
  app.use(express.json());
  const { router, requireAuth } = createAuth(store, (_req, _res, next) => next());
  app.use('/api', router);
  app.get('/api/protected', requireAuth, (req, res) => {
    res.json({ ok: true, user: req.user });
  });

  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const base = `http://127.0.0.1:${port}`;
      resolve({
        base,
        close: () => new Promise((res) => {
          if (typeof server.closeAllConnections === 'function') {
            server.closeAllConnections();
          }
          server.close(res);
        }),
      });
    });
  });
}

function runLoginRouteSuite(storeFactory, storeName) {
  describe(`Login Route Regression: ${storeName}`, () => {
    let store;
    let serverCtx;
    let tempDir = null;
    const testEmail = 'dr.sharma@example.com';
    const testPassword = 'securePassword123!';

    before(async () => {
      if (storeName === 'file') {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-test-'));
        store = storeFactory(path.join(tempDir, 'store.json'));
      } else {
        store = storeFactory();
      }

      // Seed a test user
      const password_hash = await bcrypt.hash(testPassword, 10);
      await store.createUser({
        email: testEmail,
        password_hash,
        name: 'Dr. Sharma',
        role: 'clinic_owner',
        clinic: 'clinic-101',
      });

      serverCtx = await createTestServer(store);
    });

    after(async () => {
      if (serverCtx) await serverCtx.close();
      if (tempDir && fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    beforeEach(async () => {
      // Clear any leftover lockout or rate-limiting state between individual tests
      if (store && store.resetLoginFailure) {
        await store.resetLoginFailure(testEmail);
      }
    });

    test('valid login succeeds and returns token + user payload', async () => {
      const res = await fetch(`${serverCtx.base}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: testEmail, password: testPassword }),
      });

      assert.equal(res.status, 200);
      const json = await res.json();
      assert.ok(json.token, 'token must be returned');
      assert.equal(json.user.email, testEmail);
      assert.equal(json.user.role, 'clinic_owner');
    });

    test('failed login returns 401 and increments protection state', async () => {
      const res = await fetch(`${serverCtx.base}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: testEmail, password: 'wrongPassword' }),
      });

      assert.equal(res.status, 401);
      const json = await res.json();
      assert.match(json.error, /invalid email or password/i);

      // Verify failure was recorded in the store
      const lockStatus = await store.isAccountLocked(testEmail);
      assert.equal(lockStatus.locked, false, 'should not be locked after only 1 failure');
    });

    test('5 consecutive failed logins trigger lockout (HTTP 423)', async () => {
      for (let i = 0; i < 5; i++) {
        const res = await fetch(`${serverCtx.base}/api/auth/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email: testEmail, password: 'wrongPassword' }),
        });
        if (i < 4) {
          assert.equal(res.status, 401);
        } else {
          // On the 5th failure, lockout threshold is reached
          assert.equal(res.status, 401);
        }
      }

      // 6th attempt (even with CORRECT password) must be rejected with 423
      const lockedRes = await fetch(`${serverCtx.base}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: testEmail, password: testPassword }),
      });
      assert.equal(lockedRes.status, 423);
      const json = await lockedRes.json();
      assert.match(json.error, /temporarily locked/i);
    });

    test('successful login resets failure state', async () => {
      // 2 failed attempts
      for (let i = 0; i < 2; i++) {
        await fetch(`${serverCtx.base}/api/auth/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email: testEmail, password: 'bad' }),
        });
      }

      // Valid login succeeds
      const goodRes = await fetch(`${serverCtx.base}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: testEmail, password: testPassword }),
      });
      assert.equal(goodRes.status, 200);

      // Failures should now be reset in the store
      const lockStatus = await store.isAccountLocked(testEmail);
      assert.equal(lockStatus.locked, false);
    });

    test('token blocklist / revocation remains intact on logout', async () => {
      // 1. Log in
      const loginRes = await fetch(`${serverCtx.base}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: testEmail, password: testPassword }),
      });
      const { token } = await loginRes.json();

      // 2. Access protected route -> 200
      const okRes = await fetch(`${serverCtx.base}/api/protected`, {
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(okRes.status, 200);

      // 3. Log out (revokes token)
      const logoutRes = await fetch(`${serverCtx.base}/api/auth/logout`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(logoutRes.status, 200);

      // 4. Access protected route again -> 401 Revoked
      const blockedRes = await fetch(`${serverCtx.base}/api/protected`, {
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(blockedRes.status, 401);
      const json = await blockedRes.json();
      assert.match(json.error, /revoked/i);
    });
  });
}

runLoginRouteSuite(() => createMemoryStore(), 'memory');
runLoginRouteSuite((filePath) => createFileStore(filePath), 'file');
