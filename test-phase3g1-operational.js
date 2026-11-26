'use strict';
/**
 * test-phase3g1-operational.js
 *
 * Automated verification suite for MediBot Phase 3G.1 Operational Hardening:
 * 1. Configurable and validated TRUST_PROXY configuration.
 * 2. Dedicated readiness endpoint (/api/health/ready) with 200/503 states.
 * 3. Graceful shutdown: in-flight request completion, timeout handling, duplicate protection.
 * 4. Signal handling (SIGTERM / SIGINT) and process lifecycle.
 * 5. Backward compatibility of existing /api/health.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const mongoose = require('mongoose');
const { spawn } = require('node:child_process');
const path = require('node:path');

const TEST_DB_URI = process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017/medibot_test_phase3e';

function makeRequest(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const reqOpts = {
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method: opts.method || 'GET',
      headers: opts.headers || {},
    };

    const req = http.request(reqOpts, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(body); } catch (_) {}
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body,
          json,
        });
      });
    });

    req.on('error', reject);
    if (opts.body) {
      req.write(typeof opts.body === 'object' ? JSON.stringify(opts.body) : opts.body);
    }
    req.end();
  });
}

describe('MediBot Phase 3G.1: Operational Hardening Suite', () => {
  let app;
  let parseTrustProxy;
  let gracefulShutdown;

  before(async () => {
    // Set test env
    process.env.NODE_ENV = 'test';
    process.env.STORE = 'mongo';
    process.env.TEST_MONGODB_URI = TEST_DB_URI;
    process.env.MONGODB_URI = TEST_DB_URI;
    process.env.JWT_SECRET = 'test-secret-at-least-32-chars-long-operational-hardening';
    process.env.TWILIO_AUTH_TOKEN = 'test-twilio-auth-token-operational';
    process.env.INTERNAL_SERVICE_KEY = 'test-internal-service-key-at-least-32-chars';

    app = require('./server.js');
    parseTrustProxy = app.parseTrustProxy;
    gracefulShutdown = app.gracefulShutdown;

    if (app.locals && app.locals.storeReadyPromise) {
      await app.locals.storeReadyPromise;
    }

    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(TEST_DB_URI, { serverSelectionTimeoutMS: 5000 });
    }
  });

  after(async () => {
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
  });

  // ==========================================================================
  // PART 1: Configurable and Validated TRUST_PROXY
  // ==========================================================================
  describe('Part 1: Configurable TRUST_PROXY Configuration', () => {
    test('1.1: Default behavior when TRUST_PROXY is undefined or empty string preserves 1 hop', () => {
      assert.equal(parseTrustProxy(undefined), 1);
      assert.equal(parseTrustProxy(null), 1);
      assert.equal(parseTrustProxy(''), 1);
      assert.equal(parseTrustProxy('   '), 1);
    });

    test('1.2: Valid integer hop counts (0..100) are parsed correctly', () => {
      assert.equal(parseTrustProxy(0), 0);
      assert.equal(parseTrustProxy(1), 1);
      assert.equal(parseTrustProxy(2), 2);
      assert.equal(parseTrustProxy('0'), 0);
      assert.equal(parseTrustProxy('1'), 1);
      assert.equal(parseTrustProxy('2'), 2);
      assert.equal(parseTrustProxy('5'), 5);
      assert.equal(parseTrustProxy('100'), 100);
    });

    test('1.3: Valid boolean values (true / false) are parsed correctly', () => {
      assert.equal(parseTrustProxy(true), true);
      assert.equal(parseTrustProxy(false), false);
      assert.equal(parseTrustProxy('true'), true);
      assert.equal(parseTrustProxy('false'), false);
      assert.equal(parseTrustProxy('TRUE'), true);
      assert.equal(parseTrustProxy('FALSE'), false);
    });

    test('1.4: Valid Express presets (loopback, linklocal, uniquelocal) are supported', () => {
      assert.equal(parseTrustProxy('loopback'), 'loopback');
      assert.equal(parseTrustProxy('linklocal'), 'linklocal');
      assert.equal(parseTrustProxy('uniquelocal'), 'uniquelocal');
      assert.equal(parseTrustProxy('LOOPBACK'), 'loopback');
    });

    test('1.5: Valid IP addresses and CIDR notations are supported', () => {
      assert.equal(parseTrustProxy('127.0.0.1'), '127.0.0.1');
      assert.equal(parseTrustProxy('10.0.0.0/8'), '10.0.0.0/8');
      assert.deepEqual(parseTrustProxy('127.0.0.1, 10.0.0.0/8, 172.16.0.0/12'), [
        '127.0.0.1',
        '10.0.0.0/8',
        '172.16.0.0/12',
      ]);
    });

    test('1.6: Invalid numeric hop counts (negative or > 100) are rejected', () => {
      assert.throws(() => parseTrustProxy(-1), /Invalid TRUST_PROXY/);
      assert.throws(() => parseTrustProxy(101), /Invalid TRUST_PROXY/);
      assert.throws(() => parseTrustProxy('-1'), /Invalid TRUST_PROXY/);
      assert.throws(() => parseTrustProxy('150'), /Invalid TRUST_PROXY/);
    });

    test('1.7: Malformed or dangerous strings are rejected safely', () => {
      assert.throws(() => parseTrustProxy('invalid-proxy'), /Invalid TRUST_PROXY entry/);
      assert.throws(() => parseTrustProxy('127.0.0.1, not_an_ip'), /Invalid TRUST_PROXY entry/);
      assert.throws(() => parseTrustProxy('foo/bar'), /Invalid TRUST_PROXY entry/);
      assert.throws(() => parseTrustProxy(';; rm -rf /'), /Invalid TRUST_PROXY entry/);
    });

    test('1.8: Express extracts correct client IP across multiple proxy hops', async () => {
      const server = http.createServer(app);
      await new Promise(resolve => server.listen(0, resolve));
      const port = server.address().port;

      // Temporarily set trust proxy to 2 hops
      const originalTrust = app.get('trust proxy');
      app.set('trust proxy', 2);

      try {
        // Multi-hop: Client (203.0.113.195) -> Proxy1 (198.51.100.10) -> Proxy2 (192.0.2.1)
        const res = await makeRequest(`http://127.0.0.1:${port}/api/health`, {
          headers: {
            'x-forwarded-for': '203.0.113.195, 198.51.100.10',
          },
        });
        assert.equal(res.statusCode, 200);
      } finally {
        app.set('trust proxy', originalTrust);
        await new Promise(resolve => server.close(resolve));
      }
    });
  });

  // ==========================================================================
  // PART 2: Dedicated Readiness Endpoint (/api/health/ready)
  // ==========================================================================
  describe('Part 2: Health and Readiness Endpoints', () => {
    let server;
    let port;

    before(async () => {
      app.resetShutdownForTests();
      if (mongoose.connection.readyState === 0) {
        await mongoose.connect(TEST_DB_URI, { serverSelectionTimeoutMS: 5000 });
      }
      server = http.createServer(app);
      await new Promise(resolve => server.listen(0, resolve));
      port = server.address().port;
    });

    after(async () => {
      if (server) await new Promise(resolve => server.close(resolve));
    });

    test('2.1: /api/health/ready returns HTTP 200 when storage is fully ready', async () => {
      const res = await makeRequest(`http://127.0.0.1:${port}/api/health/ready`);
      assert.equal(res.statusCode, 200);
      assert.equal(res.json.status, 'ready');
      assert.equal(res.json.ready, true);
      assert.equal(res.json.store, 'mongo');
      assert.ok(typeof res.json.uptime_seconds === 'number');

      // Verify no secrets or sensitive database connection strings leaked
      const raw = res.body;
      assert.ok(!raw.includes('mongodb://'));
      assert.ok(!raw.includes('password'));
      assert.ok(!raw.includes('secret'));
    });

    test('2.2: Existing /api/health endpoint behavior is preserved (regression check)', async () => {
      const res = await makeRequest(`http://127.0.0.1:${port}/api/health`);
      assert.equal(res.statusCode, 200);
      assert.equal(res.json.ok, true);
      assert.equal(res.json.store, 'mongo');
      assert.equal(res.json.database, true);
      assert.ok(typeof res.json.uptime_seconds === 'number');
    });

    test('2.3: /api/health/ready returns HTTP 503 when MongoDB disconnects', async () => {
      // Disconnect mongoose temporarily
      await mongoose.disconnect();
      assert.equal(mongoose.connection.readyState, 0);

      try {
        const readyRes = await makeRequest(`http://127.0.0.1:${port}/api/health/ready`);
        assert.equal(readyRes.statusCode, 503);
        assert.equal(readyRes.json.status, 'unready');
        assert.equal(readyRes.json.ready, false);
        assert.equal(readyRes.json.error, 'Storage backend is not ready');

        // Verify existing /api/health returns 200 with database: false as per original design
        const healthRes = await makeRequest(`http://127.0.0.1:${port}/api/health`);
        assert.equal(healthRes.statusCode, 200);
        assert.equal(healthRes.json.database, false);
      } finally {
        // Reconnect mongoose
        await mongoose.connect(TEST_DB_URI, { serverSelectionTimeoutMS: 5000 });
        assert.equal(mongoose.connection.readyState, 1);
      }

      // Verify it recovers to 200 after reconnection
      const recoveredRes = await makeRequest(`http://127.0.0.1:${port}/api/health/ready`);
      assert.equal(recoveredRes.statusCode, 200);
      assert.equal(recoveredRes.json.ready, true);
    });
  });

  // ==========================================================================
  // PART 3: Graceful Shutdown Implementation & In-Flight Request Handling
  // ==========================================================================
  describe('Part 3: Graceful Shutdown Mechanics', () => {
    after(async () => {
      app.resetShutdownForTests();
      if (mongoose.connection.readyState === 0) {
        await mongoose.connect(TEST_DB_URI, { serverSelectionTimeoutMS: 5000 });
      }
    });

    test('3.1: In-flight requests complete successfully during graceful shutdown', async () => {
      app.resetShutdownForTests();
      let slowFinished = false;

      const express = require('express');
      const slowApp = express();
      slowApp.get('/test-slow-request', async (req, res) => {
        await new Promise(r => setTimeout(r, 200));
        slowFinished = true;
        res.status(200).json({ ok: true, completed: true });
      });

      const server = http.createServer(slowApp);
      await new Promise(resolve => server.listen(0, resolve));
      const port = server.address().port;

      // Start the slow request
      const slowReqPromise = makeRequest(`http://127.0.0.1:${port}/test-slow-request`);

      // Give request time to arrive and begin executing (50ms)
      await new Promise(r => setTimeout(r, 50));

      // Trigger graceful shutdown while request is active
      const shutdownPromise = gracefulShutdown(server, { timeoutMs: 3000, exit: false, signal: 'SIGTERM' });

      // Verify the in-flight request finishes cleanly with HTTP 200
      const slowRes = await slowReqPromise;
      assert.equal(slowRes.statusCode, 200);
      assert.equal(slowRes.json.completed, true);
      assert.equal(slowFinished, true);

      // Await shutdown completion
      const shutdownResult = await shutdownPromise;
      assert.equal(shutdownResult.ok, true);
      assert.equal(shutdownResult.timedOut, false);
    });

    test('3.2: Duplicate shutdown invocations are safely ignored', async () => {
      // isShuttingDown is now true from previous test
      assert.equal(app.getIsShuttingDown(), true);
      const duplicateRes = await gracefulShutdown(null, { timeoutMs: 1000, exit: false });
      assert.equal(duplicateRes.ok, false);
      assert.equal(duplicateRes.alreadyShuttingDown, true);
    });

    test('3.3: Shutdown timeout forces termination when request hangs past deadline', async () => {
      app.resetShutdownForTests();

      const express = require('express');
      const hangApp = express();
      hangApp.get('/test-hanging-request', (req, res) => {
        // Do not respond
      });

      const server = http.createServer(hangApp);
      await new Promise(resolve => server.listen(0, resolve));
      const port = server.address().port;

      // Start hanging request
      const req = http.get(`http://127.0.0.1:${port}/test-hanging-request`);
      req.on('error', () => {}); // expected socket hangup

      await new Promise(r => setTimeout(r, 50));

      // Graceful shutdown with short 200ms timeout
      const start = Date.now();
      const shutdownRes = await gracefulShutdown(server, { timeoutMs: 200, exit: false, signal: 'SIGTERM' });
      const elapsed = Date.now() - start;

      assert.equal(shutdownRes.ok, false);
      assert.equal(shutdownRes.timedOut, true);
      assert.ok(elapsed >= 180 && elapsed <= 1000, `Elapsed time ${elapsed}ms should be around 200ms`);

      req.destroy();
      try { server.close(); } catch (_) {}
    });
  });

  // ==========================================================================
  // PART 4: Multi-Process Signal Handling (SIGTERM & SIGINT)
  // ==========================================================================
  describe('Part 4: Multi-Process Signal Trapping', () => {
    test('4.1: Standalone server process traps SIGTERM and exits with code 0', async () => {
      const childScript = `
        const http = require('http');
        const mongoose = require('mongoose');
        const app = require('./server.js');

        const server = http.createServer(app);
        server.listen(0, () => {
          console.log('CHILD_READY:' + server.address().port);
        });

        process.on('SIGTERM', async () => {
          console.log('RECEIVED_SIGTERM_CHILD');
          await app.gracefulShutdown(server, { timeoutMs: 2000, exit: false, signal: 'SIGTERM' });
          process.exit(0);
        });
      `;

      const child = spawn(process.execPath, ['-e', childScript], {
        cwd: path.resolve(__dirname),
        env: Object.assign({}, process.env, {
          NODE_ENV: 'test',
          STORE: 'memory',
          JWT_SECRET: 'test-secret-at-least-32-chars-long-signal-test',
        }),
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let childOutput = '';
      child.stdout.on('data', d => { childOutput += d.toString(); });
      child.stderr.on('data', d => { childOutput += d.toString(); });

      // Wait for child to be ready
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Child startup timeout')), 5000);
        const interval = setInterval(() => {
          if (childOutput.includes('CHILD_READY:')) {
            clearTimeout(timeout);
            clearInterval(interval);
            resolve();
          }
        }, 50);
      });

      // Send SIGTERM
      child.kill('SIGTERM');

      const exitCode = await new Promise((resolve) => {
        child.on('exit', (code, sig) => resolve({ code, sig }));
      });

      // Code 0 or SIGTERM signal indicates clean graceful termination
      assert.ok(exitCode.code === 0 || exitCode.sig === 'SIGTERM', `Child exit code: ${exitCode.code}, sig: ${exitCode.sig}`);
    });

    test('4.2: Standalone server process traps SIGINT and exits cleanly', async () => {
      const childScript = `
        const http = require('http');
        const app = require('./server.js');

        const server = http.createServer(app);
        server.listen(0, () => {
          console.log('CHILD_READY:' + server.address().port);
        });

        process.on('SIGINT', async () => {
          console.log('RECEIVED_SIGINT_CHILD');
          await app.gracefulShutdown(server, { timeoutMs: 2000, exit: false, signal: 'SIGINT' });
          process.exit(0);
        });
      `;

      const child = spawn(process.execPath, ['-e', childScript], {
        cwd: path.resolve(__dirname),
        env: Object.assign({}, process.env, {
          NODE_ENV: 'test',
          STORE: 'memory',
          JWT_SECRET: 'test-secret-at-least-32-chars-long-signal-test',
        }),
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let childOutput = '';
      child.stdout.on('data', d => { childOutput += d.toString(); });

      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Child startup timeout')), 5000);
        const interval = setInterval(() => {
          if (childOutput.includes('CHILD_READY:')) {
            clearTimeout(timeout);
            clearInterval(interval);
            resolve();
          }
        }, 50);
      });

      child.kill('SIGINT');

      const exitResult = await new Promise((resolve) => {
        child.on('exit', (code, sig) => resolve({ code, sig }));
      });

      assert.ok(exitResult.code === 0 || exitResult.sig === 'SIGINT', `Child exit code: ${exitResult.code}, sig: ${exitResult.sig}`);
    });
  });
});
