'use strict';
/**
 * test-phase4-browser-receptionist.js
 *
 * Automated verification suite for MediBot Phase 4 — Browser-Based AI Receptionist.
 * Verifies:
 * 1. Hindi (Devanagari) end-to-end conversation & booking.
 * 2. Hinglish end-to-end conversation & booking.
 * 3. English end-to-end conversation & booking.
 * 4. Text-only fallback & empty/unclear input resilience.
 * 5. Doctor availability (off-day, holiday, outside working hours) & alternative slot suggestions.
 * 6. Explicit confirmation & rejection ("nahi"/"no" never books).
 * 7. Duplicate booking prevention.
 * 8. Simulation cancellation (POST /end).
 * 9. Tenant isolation, JWT authentication, and separation from Twilio CallSessions.
 * 10. Zero INTERNAL_SERVICE_KEY / Twilio secret leakage in frontend build or API responses.
 * 11. Zero billable telephone call_count / call_minutes & zero WhatsApp usage for simulated calls,
 *     while confirmed bookings increment booking_count via standard usage tracking.
 * 12. Real offline Kokoro ONNX Hindi TTS + Faster-Whisper Small STT end-to-end audio turn.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const jwt = require('jsonwebtoken');

const { getBillingMonth } = require('./subscription');
const { createLocalVoiceEngine } = require('./voice-local');

const TEST_JWT_SECRET = 'medibot-phase4-receptionist-test-jwt-secret-32chars';
const TEST_INTERNAL_KEY = 'medibot-phase4-super-secret-internal-key-32chars';

describe('MediBot Phase 4 — Browser-Based AI Receptionist', () => {
  let app;
  let server;
  let baseUrl;
  let store;

  const CLINIC_A = 'clinic_p4_alpha';
  const CLINIC_B = 'clinic_p4_beta';
  let tokenA;
  let tokenB;
  let doctorA;

  before(async () => {
    process.env.NODE_ENV = 'test';
    process.env.STORE = 'memory';
    process.env.PORT = '0';
    process.env.JWT_SECRET = TEST_JWT_SECRET;
    process.env.INTERNAL_SERVICE_KEY = TEST_INTERNAL_KEY;
    process.env.TWILIO_VALIDATE_SIGNATURE = 'false';

    app = require('./server');
    if (app.locals && app.locals.storeReadyPromise) {
      await app.locals.storeReadyPromise;
    }
    store = app.locals.store;

    server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;

    await store.saveClinic({ name: 'Sharma Care Clinic', phone: '+919876544001' }, { clinic: CLINIC_A, create: true });
    await store.saveClinic({ name: 'Beta Health Clinic', phone: '+919876544002' }, { clinic: CLINIC_B, create: true });

    // Seed doctor for Clinic A: Mon-Fri 09:00-17:00, holiday on 2026-12-25, Saturday (6) off
    doctorA = await store.createDoctor({
      name: 'Dr. Anil Sharma',
      specialty: 'General Physician',
      working_hours: [
        { day: 1, start: '09:00', end: '17:00' },
        { day: 2, start: '09:00', end: '17:00' },
        { day: 3, start: '09:00', end: '17:00' },
        { day: 4, start: '09:00', end: '17:00' },
        { day: 5, start: '09:00', end: '17:00' },
      ],
      holidays: ['2026-12-25'],
      active: true,
    }, { clinic: CLINIC_A });

    tokenA = jwt.sign(
      { sub: 'usr_p4_a', email: 'owner@sharma.test', role: 'clinic_owner', clinic: CLINIC_A },
      TEST_JWT_SECRET
    );
    tokenB = jwt.sign(
      { sub: 'usr_p4_b', email: 'owner@beta.test', role: 'clinic_owner', clinic: CLINIC_B },
      TEST_JWT_SECRET
    );
  });

  after(async () => {
    if (app && app.locals && app.locals.shutdownLocalVoice) {
      app.locals.shutdownLocalVoice();
    }
    if (server) {
      await new Promise(resolve => server.close(resolve));
    }
  });

  async function apiPost(endpoint, token, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`${baseUrl}${endpoint}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body || {}),
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, json };
  }

  test('1. Hindi (Devanagari) end-to-end conversation books appointment only after explicit confirmation', async () => {
    const start = await apiPost('/api/receptionist/sessions', tokenA, { language: 'hi', speak: false });
    assert.equal(start.status, 201);
    assert.match(start.json.session_id, /^sim_/);
    assert.match(start.json.reply, /नमस्ते/);
    const sid = start.json.session_id;

    // Name
    let turn = await apiPost(`/api/receptionist/sessions/${sid}/turn`, tokenA, { text: 'मेरा नाम राहुल वर्मा है' });
    assert.equal(turn.status, 200);
    assert.equal(turn.json.slots.name, 'राहुल वर्मा');
    assert.equal(turn.json.asked_field, 'phone');

    // Phone
    turn = await apiPost(`/api/receptionist/sessions/${sid}/turn`, tokenA, { text: '9876543210' });
    assert.equal(turn.json.slots.phone, '+919876543210');
    assert.equal(turn.json.asked_field, 'reason');

    // Reason
    turn = await apiPost(`/api/receptionist/sessions/${sid}/turn`, tokenA, { text: 'मुझे बुखार है' });
    assert.ok(turn.json.slots.reason);
    assert.equal(turn.json.asked_field, 'date');

    // Date (Monday 28/12/2026) + Time (10:00)
    turn = await apiPost(`/api/receptionist/sessions/${sid}/turn`, tokenA, { text: '28/12/2026 सुबह 10 बजे' });
    assert.equal(turn.json.awaiting_confirm, true, 'Must read back and wait for explicit confirmation');
    assert.equal(turn.json.appointment, null, 'Must NOT book before confirmation');

    // Unclear confirmation must NOT book
    turn = await apiPost(`/api/receptionist/sessions/${sid}/turn`, tokenA, { text: 'हम्म सोच रहा हूँ' });
    assert.equal(turn.json.awaiting_confirm, true);
    assert.equal(turn.json.appointment, null);

    // Explicit Hindi confirmation -> books atomically
    turn = await apiPost(`/api/receptionist/sessions/${sid}/turn`, tokenA, { text: 'हाँ, कन्फर्म कर दो' });
    assert.equal(turn.status, 200);
    assert.equal(turn.json.status, 'confirmed');
    assert.ok(turn.json.appointment && turn.json.appointment._id, 'Appointment must be persisted');
    assert.equal(turn.json.appointment.source, 'browser-simulator');
    assert.equal(turn.json.appointment.clinic, CLINIC_A);
  });

  test('2. Hinglish end-to-end conversation & booking', async () => {
    const start = await apiPost('/api/receptionist/sessions', tokenA, { language: 'hinglish', speak: false });
    assert.equal(start.status, 201);
    assert.match(start.json.reply, /Namaste/i);
    const sid = start.json.session_id;

    await apiPost(`/api/receptionist/sessions/${sid}/turn`, tokenA, { text: 'Mera naam Priya Sharma hai' });
    await apiPost(`/api/receptionist/sessions/${sid}/turn`, tokenA, { text: '9876543211' });
    await apiPost(`/api/receptionist/sessions/${sid}/turn`, tokenA, { text: 'Sirdard aur bukhar hai' });
    const rb = await apiPost(`/api/receptionist/sessions/${sid}/turn`, tokenA, { text: '28/12/2026 subah 11 baje' });
    assert.equal(rb.json.awaiting_confirm, true);

    const conf = await apiPost(`/api/receptionist/sessions/${sid}/turn`, tokenA, { text: 'Haan book kar do' });
    assert.equal(conf.json.status, 'confirmed');
    assert.ok(conf.json.appointment && conf.json.appointment._id);
  });

  test('3. English end-to-end conversation & text-only fallback with empty input handling', async () => {
    const start = await apiPost('/api/receptionist/sessions', tokenA, { language: 'en', speak: false });
    assert.equal(start.status, 201);
    assert.match(start.json.reply, /Hello/i);
    const sid = start.json.session_id;

    // Empty transcript handled gracefully without crashing
    const emptyTurn = await apiPost(`/api/receptionist/sessions/${sid}/turn`, tokenA, { text: '   ' });
    assert.equal(emptyTurn.status, 200);
    assert.equal(emptyTurn.json.ended, false);

    await apiPost(`/api/receptionist/sessions/${sid}/turn`, tokenA, { text: 'My name is Amit Verma' });
    await apiPost(`/api/receptionist/sessions/${sid}/turn`, tokenA, { text: '9876543212' });
    await apiPost(`/api/receptionist/sessions/${sid}/turn`, tokenA, { text: 'Routine dental checkup' });
    const rb = await apiPost(`/api/receptionist/sessions/${sid}/turn`, tokenA, { text: '29/12/2026 at 10 AM' });
    assert.equal(rb.json.awaiting_confirm, true);

    const conf = await apiPost(`/api/receptionist/sessions/${sid}/turn`, tokenA, { text: 'Yes, confirm' });
    assert.equal(conf.json.status, 'confirmed');
    assert.ok(conf.json.appointment && conf.json.appointment._id);
  });

  test('4. Doctor availability (holiday, off-day, outside hours) offers alternatives & confirmation rejection prevents booking', async () => {
    const start = await apiPost('/api/receptionist/sessions', tokenA, { language: 'en', doctorId: doctorA._id, speak: false });
    const sid = start.json.session_id;

    await apiPost(`/api/receptionist/sessions/${sid}/turn`, tokenA, { text: 'My name is Neha Gupta' });
    await apiPost(`/api/receptionist/sessions/${sid}/turn`, tokenA, { text: '9876543213' });
    await apiPost(`/api/receptionist/sessions/${sid}/turn`, tokenA, { text: 'Fever' });

    // Holiday: 25/12/2026 (Friday, in doctor.holidays)
    let turn = await apiPost(`/api/receptionist/sessions/${sid}/turn`, tokenA, { text: '25/12/2026 at 10 AM' });
    assert.equal(turn.json.hint, 'holiday');
    assert.equal(turn.json.awaiting_confirm, false);
    assert.ok(turn.json.alternatives.length > 0, 'Must suggest alternative dates on holiday');

    // Off-day: Saturday 26/12/2026
    turn = await apiPost(`/api/receptionist/sessions/${sid}/turn`, tokenA, { text: '26/12/2026 at 10 AM' });
    assert.equal(turn.json.hint, 'doctor_off');
    assert.ok(turn.json.alternatives.length > 0, 'Must suggest alternative dates on doctor off-day');

    // Outside working hours: Monday 28/12/2026 at 20:00 (doctor works 09:00-17:00)
    turn = await apiPost(`/api/receptionist/sessions/${sid}/turn`, tokenA, { text: '28/12/2026 at 8 PM' });
    assert.equal(turn.json.hint, 'outside_hours');
    assert.ok(turn.json.alternatives.length > 0, 'Must suggest alternative times when outside working hours');

    // Valid slot -> readback -> reject with "No" -> must NOT book
    turn = await apiPost(`/api/receptionist/sessions/${sid}/turn`, tokenA, { text: '14:00' });
    assert.equal(turn.json.awaiting_confirm, true);

    const reject = await apiPost(`/api/receptionist/sessions/${sid}/turn`, tokenA, { text: 'No, change time' });
    assert.equal(reject.json.awaiting_confirm, false);
    assert.equal(reject.json.appointment, null, 'Rejecting confirmation must NOT create appointment');

    // End / cancel simulation cleanly
    const endRes = await apiPost(`/api/receptionist/sessions/${sid}/end`, tokenA, {});
    assert.equal(endRes.status, 200);
    assert.equal(endRes.json.ended, true);
  });

  test('5. Duplicate booking is prevented and never falsely claimed as booked', async () => {
    const start = await apiPost('/api/receptionist/sessions', tokenA, { language: 'hinglish', speak: false });
    const sid = start.json.session_id;

    // Exact same phone (+919876543210), date (28/12/2026), and slot (Morning 10:00) booked in Test 1
    await apiPost(`/api/receptionist/sessions/${sid}/turn`, tokenA, { text: 'Mera naam Rahul Verma hai' });
    await apiPost(`/api/receptionist/sessions/${sid}/turn`, tokenA, { text: '9876543210' });
    await apiPost(`/api/receptionist/sessions/${sid}/turn`, tokenA, { text: 'Bukhar' });
    const dupTurn = await apiPost(`/api/receptionist/sessions/${sid}/turn`, tokenA, { text: '28/12/2026 subah 10 baje' });
    assert.equal(dupTurn.json.error_code, 'DUPLICATE_BOOKING');
    assert.equal(dupTurn.json.appointment, null);
  });

  test('6. Security: auth, tenant isolation, Twilio session separation, no secret leakage & zero billable call minutes', async () => {
    // 6a. Unauthenticated requests rejected (401)
    const noAuthCap = await fetch(`${baseUrl}/api/receptionist/capabilities`);
    assert.equal(noAuthCap.status, 401);
    const noAuthStart = await apiPost('/api/receptionist/sessions', null, { language: 'hi' });
    assert.equal(noAuthStart.status, 401);

    // 6b. Cross-clinic session isolation: Clinic B cannot access or end Clinic A's session (404)
    const startA = await apiPost('/api/receptionist/sessions', tokenA, { language: 'en', speak: false });
    const sidA = startA.json.session_id;

    const crossTurn = await apiPost(`/api/receptionist/sessions/${sidA}/turn`, tokenB, { text: 'Hijack attempt' });
    assert.equal(crossTurn.status, 404, 'Clinic B must NOT access Clinic A simulation session');

    const crossEnd = await apiPost(`/api/receptionist/sessions/${sidA}/end`, tokenB, {});
    assert.equal(crossEnd.status, 404, 'Clinic B must NOT end Clinic A simulation session');

    // 6c. Browser simulation session ID CANNOT impersonate a verified Twilio session on /api/voice/book
    const impersonateRes = await fetch(`${baseUrl}/api/voice/book`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Service-Key': TEST_INTERNAL_KEY,
      },
      body: JSON.stringify({
        call_sid: sidA,
        name: 'Impersonator',
        phone: '+919999999999',
        date: '29/12/2026',
        time_slot: 'Morning 10:00',
      }),
    });
    assert.equal(impersonateRes.status, 403, 'Browser simulation session must NEVER be accepted as a verified Twilio session');

    // 6d. Verify zero billable call usage (call_count=0, call_minutes=0, whatsapp_count=0), while 3 confirmed bookings ARE counted
    const m = getBillingMonth();
    const usageA = await store.getClinicUsage(CLINIC_A, m);
    assert.ok(usageA);
    assert.equal(usageA.call_count, 0, 'Simulated calls must NEVER consume billable call_count');
    assert.equal(usageA.call_minutes, 0, 'Simulated calls must NEVER consume billable call_minutes');
    assert.equal(usageA.whatsapp_count, 0, 'Simulated calls must NEVER send/count WhatsApp messages');
    assert.equal(usageA.booking_count, 3, 'Successfully created appointments must follow standard booking usage tracking');

    // 6e. Verify no INTERNAL_SERVICE_KEY or TWILIO_AUTH_TOKEN leaked in frontend build bundle
    const distDir = path.resolve(__dirname, '..', 'doctor-bot-frontend', 'dist', 'assets');
    if (fs.existsSync(distDir)) {
      const jsFiles = fs.readdirSync(distDir).filter(f => f.endsWith('.js'));
      for (const file of jsFiles) {
        const content = fs.readFileSync(path.join(distDir, file), 'utf8');
        assert.ok(!content.includes('INTERNAL_SERVICE_KEY'), `Frontend bundle ${file} must not contain INTERNAL_SERVICE_KEY`);
        assert.ok(!content.includes('TWILIO_AUTH_TOKEN'), `Frontend bundle ${file} must not contain TWILIO_AUTH_TOKEN`);
        assert.ok(!content.includes(TEST_INTERNAL_KEY), `Frontend bundle ${file} must not contain test internal key`);
      }
    }
  });

  test('7. Real local offline voice pipeline: Kokoro ONNX Hindi TTS -> Faster-Whisper Small STT -> /audio turn', async (t) => {
    const voice = createLocalVoiceEngine();
    const caps = voice.getCapabilities();
    if (!caps.stt.available || !caps.tts.available) {
      return t.skip('Local Whisper/Kokoro models not present on this host');
    }

    try {
      // 1. Synthesize real Hindi caller utterance using local Kokoro ONNX (hf_alpha)
      const synth = await voice.synthesize({ text: 'मेरा नाम राहुल वर्मा है', lang: 'hi' });
      assert.equal(synth.ok, true, 'Kokoro ONNX must synthesize Hindi WAV offline');
      assert.ok(synth.audio_base64 && synth.audio_base64.length > 1000);
      assert.equal(synth.mime_type, 'audio/wav');

      // 2. Start Hindi browser session and send the synthesized WAV to POST /api/receptionist/sessions/:id/audio
      const start = await apiPost('/api/receptionist/sessions', tokenA, { language: 'hi', speak: false });
      const sid = start.json.session_id;

      const audioRes = await apiPost(`/api/receptionist/sessions/${sid}/audio`, tokenA, {
        audio_base64: synth.audio_base64,
        mime_type: 'audio/wav',
        speak: true,
      });
      assert.equal(audioRes.status, 200);
      assert.equal(audioRes.json.ok, true);
      assert.equal(audioRes.json.stt_engine, 'faster-whisper');
      assert.ok(audioRes.json.transcript && audioRes.json.transcript.length > 0, 'Faster-Whisper must return Hindi transcript');
      assert.ok(audioRes.json.audio && audioRes.json.audio.audio_base64, 'AI reply must include synthesized Kokoro WAV audio');
      assert.equal(audioRes.json.audio.engine, 'kokoro-onnx');
    } finally {
      voice.shutdown();
    }
  });
});
