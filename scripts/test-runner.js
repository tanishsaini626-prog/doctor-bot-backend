'use strict';
/**
 * scripts/test-runner.js
 *
 * Test runner wrapper for MediBot backend automated tests.
 *
 * Ensures:
 * 1. Dedicated, non-production test secret is set for tests that require JWT authentication.
 * 2. Never leaks or commits production secrets.
 * 3. Preserves the production startup guard in server.js that rejects weak or missing secrets.
 * 4. Passes through all CLI flags and paths to `node --test`.
 */

const { spawn } = require('child_process');

const testSecret = process.env.TEST_JWT_SECRET || 'medibot-automated-test-suite-ephemeral-secret-min32chars';

const env = Object.assign({}, process.env, {
  NODE_ENV: process.env.NODE_ENV || 'test',
  TEST_JWT_SECRET: testSecret,
  JWT_SECRET: process.env.JWT_SECRET || testSecret,
});

// If the environment contains the known leaked production secret, neutralize it for tests
if (env.JWT_SECRET && env.JWT_SECRET.includes('ifkHCeRjCLRTatBZX9K5v0MS34gPvW4')) {
  env.JWT_SECRET = testSecret;
}
if (env.TEST_JWT_SECRET && env.TEST_JWT_SECRET.includes('ifkHCeRjCLRTatBZX9K5v0MS34gPvW4')) {
  env.TEST_JWT_SECRET = testSecret;
}

// Ensure cloud Atlas database is never touched during local tests
if (env.MONGODB_URI && env.MONGODB_URI.includes('mongodb.net')) {
  delete env.MONGODB_URI;
}

const userArgs = process.argv.slice(2);
const DEFAULT_SUITES = [
  'test-bot-logic.js',
  'test-conversation.js',
  'test-twilio-signature.js',
  'test-login-protection.js',
  'test-tenant-isolation.js',
  'test-leads.js',
  'test-login-route-regression.js',
  'test-twilio-webhook-resolution.js',
  'test-jwt-secret.js',
  'test-clinic-onboarding.js',
  'test-platform-admin.js',
  'test-voice-gateway.js',
  'test-phase3e-mongo-voice-gateway.js',
  'test-phase3f1-remediation.js',
  'test-phase3f2-operational.js',
  'test-phase3g1-operational.js',
  'test-phase3g2-data-integrity.js',
  'test-phase1-saas-subscription.js',
  'test-phase2-usage-enforcement.js',
  'test-phase2-1-billing-integrity.js',
  'test-phase3-billing-mock-payments.js',
  'test-phase4-browser-receptionist.js',
  'test-phase5a-reliability-security.js',
  'test-phase5b-clinic-onboarding.js',
  'test-phase5c-dashboard-receptionist-integration.js',
  'test-phase5d-billing-usage-dashboard.js',
  'test-phase5e-demo-customer-readiness.js',
  'test-phase6a-p0-remediation.js',
];

const targets = userArgs.length > 0 ? userArgs : DEFAULT_SUITES;
const args = ['--test', '--test-concurrency=1', ...targets];

const child = spawn(process.execPath, args, {
  env,
  stdio: 'inherit',
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
  } else {
    process.exit(code ?? 0);
  }
});
