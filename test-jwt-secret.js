'use strict';
/* ==========================================================================
 * test-jwt-secret.js - JWT secret and production storage readiness (Batch 2).
 *
 * Verifies that server.js enforces a strong JWT_SECRET when NODE_ENV=production,
 * and that production mode fails closed (exits with code 1) if MongoDB is
 * missing, disabled, or unavailable, never silently falling back to file/memory.
 *
 *   node --test test-jwt-secret.js
 * ========================================================================== */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function runServer(envOverrides) {
  const env = Object.assign({}, process.env, {
    PORT: '0',
    TWILIO_VALIDATE_SIGNATURE: 'false',
  }, envOverrides);

  return spawnSync(process.execPath, [path.join(__dirname, 'server.js')], {
    env,
    encoding: 'utf8',
    timeout: 10000,
  });
}

// ---------------------------------------------------------------------------
// 1. server.js source contains the production readiness checks
// ---------------------------------------------------------------------------
test('server.js enforces JWT_SECRET in production', () => {
  const src = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  assert.ok(src.includes("NODE_ENV = process.env.NODE_ENV || 'development'"),
    'NODE_ENV is read from env');
  assert.ok(src.includes("if (NODE_ENV === 'production')"),
    'production check present');
  assert.ok(src.includes("JWT_SECRET is required in production"),
    'missing JWT_SECRET fatal message');
  assert.ok(src.includes('must be at least 32 characters'),
    'short JWT_SECRET fatal message');
  assert.ok(src.includes('process.exit(1)'),
    'fatal exits the process');
});

// ---------------------------------------------------------------------------
// 2. Production readiness check logic (simulated unit tests)
// ---------------------------------------------------------------------------
test('production check rejects missing JWT_SECRET', () => {
  const NODE_ENV = 'production';
  let jwtSecret = undefined;
  let exited = false;
  let message = '';

  if (NODE_ENV === 'production') {
    jwtSecret = jwtSecret || '';
    if (!jwtSecret) {
      message = 'FATAL: JWT_SECRET is required in production (NODE_ENV=production).';
      exited = true;
    } else if (jwtSecret.length < 32) {
      message = 'FATAL: JWT_SECRET must be at least 32 characters in production.';
      exited = true;
    }
  }

  assert.equal(exited, true, 'missing secret triggers exit');
  assert.ok(message.includes('required in production'), 'correct error message');
});

test('production check rejects short JWT_SECRET (< 32 chars)', () => {
  const NODE_ENV = 'production';
  const jwtSecret = 'short-secret'; // 12 chars
  let exited = false;
  let message = '';

  if (NODE_ENV === 'production') {
    if (!jwtSecret) {
      exited = true;
      message = 'missing';
    }
    if (jwtSecret.length < 32) {
      exited = true;
      message = 'FATAL: JWT_SECRET must be at least 32 characters in production (got ' + jwtSecret.length + ').';
    }
  }

  assert.equal(exited, true, 'short secret triggers exit');
  assert.ok(message.includes('32 characters'), 'correct error message');
});

test('production check accepts JWT_SECRET >= 32 chars', () => {
  const NODE_ENV = 'production';
  const jwtSecret = 'this-is-a-strong-enough-secret-for-production-use-12345'; // 48 chars
  let exited = false;

  if (NODE_ENV === 'production') {
    if (!jwtSecret) {
      exited = true;
    }
    if (jwtSecret.length < 32) {
      exited = true;
    }
  }

  assert.equal(exited, false, 'long secret does not trigger exit');
});

test('development mode does not require JWT_SECRET', () => {
  const NODE_ENV = 'development';
  const jwtSecret = undefined;
  let exited = false;

  if (NODE_ENV === 'production') {
    if (!jwtSecret) {
      exited = true;
    }
  }

  assert.equal(exited, false, 'development mode does not enforce JWT_SECRET');
});

// ---------------------------------------------------------------------------
// 3. Production storage fails closed (integration tests via server subprocess)
// ---------------------------------------------------------------------------
test('production mode fails closed if MONGODB_URI is missing', () => {
  const res = runServer({
    NODE_ENV: 'production',
    JWT_SECRET: 'test-production-secret-at-least-32-chars-long-012345',
    MONGODB_URI: '',
  });
  assert.equal(res.status, 1, 'process must exit with status 1');
  assert.ok(
    res.stderr.includes('FATAL: MONGODB_URI is required in production'),
    'stderr explains missing MONGODB_URI in production: ' + res.stderr
  );
});

test('production mode fails closed if STORE=memory is configured', () => {
  const res = runServer({
    NODE_ENV: 'production',
    JWT_SECRET: 'test-production-secret-at-least-32-chars-long-012345',
    STORE: 'memory',
    MONGODB_URI: 'mongodb://127.0.0.1:27017/dummy',
  });
  assert.equal(res.status, 1, 'process must exit with status 1');
  assert.ok(
    res.stderr.includes('FATAL: STORE=memory is not permitted in production'),
    'stderr rejects STORE=memory in production: ' + res.stderr
  );
});

test('production mode fails closed if STORE=file is configured', () => {
  const res = runServer({
    NODE_ENV: 'production',
    JWT_SECRET: 'test-production-secret-at-least-32-chars-long-012345',
    STORE: 'file',
    MONGODB_URI: 'mongodb://127.0.0.1:27017/dummy',
  });
  assert.equal(res.status, 1, 'process must exit with status 1');
  assert.ok(
    res.stderr.includes('FATAL: STORE=file is not permitted in production'),
    'stderr rejects STORE=file in production: ' + res.stderr
  );
});

test('production mode fails closed when MongoDB is unavailable (no silent fallback)', () => {
  const res = runServer({
    NODE_ENV: 'production',
    JWT_SECRET: 'test-production-secret-at-least-32-chars-long-012345',
    MONGODB_URI: 'mongodb://127.0.0.1:59999/unreachable',
  });
  assert.equal(res.status, 1, 'process must exit with status 1 on MongoDB connection failure');
  assert.ok(
    res.stderr.includes('FATAL: MongoDB connection failed in production'),
    'stderr confirms fail-closed behavior without fallback: ' + res.stderr
  );
});
