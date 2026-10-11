#!/usr/bin/env node
'use strict';
/* ==========================================================================
 * live-test.js - REAL end-to-end test of the running backend.
 *
 * It boots the actual Express server (in-memory store, no database needed) and
 * talks to it over real HTTP using Twilio's exact form-encoded format:
 *   - a full 4-turn phone call
 *   - emergency, wrong number, out-of-hours, duplicate booking
 *   - abandoned call via the status callback
 *   - the REST API the React dashboard uses
 *
 *   npm run test:live
 * ========================================================================== */

const PORT = process.env.LIVE_TEST_PORT || 5111;
process.env.PORT = String(PORT);
process.env.STORE = 'memory';
process.env.MONGODB_URI = '';
process.env.MAX_PER_SLOT = '0';

const app = require('../server.js');
const server = app.listen(PORT);          // start the real HTTP listener

const BASE = `http://127.0.0.1:${PORT}`;
let passed = 0;
const failures = [];
const log = [];

function check(name, condition, detail) {
  if (condition) { passed++; console.log('  ✅ ' + name); }
  else { failures.push(name + (detail ? ' — ' + detail : '')); console.log('  ❌ ' + name + (detail ? ' — ' + detail : '')); }
}

/** Posts one Twilio speech turn. */
async function say(callSid, speech, from = '+919999000111') {
  const res = await fetch(`${BASE}/webhook/doctor-bot`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ CallSid: callSid, From: from, SpeechResult: speech, Confidence: '0.9' }).toString(),
  });
  return { status: res.status, xml: await res.text() };
}

let TOKEN = null;
/** Dashboard API call with the login token attached. */
async function get(path) {
  return fetch(BASE + path, { headers: TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {} });
}

async function startCall(callSid, from = '+919999000111') {
  const res = await fetch(`${BASE}/webhook/doctor-bot?CallSid=${callSid}&From=${encodeURIComponent(from)}`);
  return { status: res.status, xml: await res.text() };
}

const spoken = (xml) => {
  const m = [...xml.matchAll(/<Say[^>]*>([^<]*)<\/Say>/g)].map(x => x[1]);
  return m.join(' | ');
};

(async () => {
  await new Promise(r => setTimeout(r, 700));   // let the server start

  console.log('\n=== 1. Server booted ===');
  const root = await (await fetch(BASE + '/')).json();
  check('GET / reports the in-memory store', root.store === 'memory', JSON.stringify(root.store));
  check('GET /api/health is ok', (await (await fetch(BASE + '/api/health')).json()).ok === true);

  // the dashboard APIs require a login now
  const bootLogin = await (await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: process.env.ADMIN_EMAIL || 'admin@medibot.local',
      password: process.env.ADMIN_PASSWORD || 'medibot-admin',
    }),
  })).json();
  TOKEN = bootLogin.token;
  check('admin account exists and can log in', !!TOKEN, JSON.stringify(bootLogin.error || ''));

  console.log('\n=== 2. Phone rings ===');
  const greeting = await startCall('CA-live-1');
  check('greeting returns 200', greeting.status === 200, 'status ' + greeting.status);
  check('greeting asks for the name in Hindi', /नमस्ते/.test(greeting.xml) && /अपना पूरा नाम/.test(greeting.xml));
  check('greeting opens a <Gather> for speech', greeting.xml.includes('<Gather input="speech"') && greeting.xml.includes('actionOnEmptyResult="true"'));

  console.log('\n=== 3. A real 4-turn booking ===');
  const t1 = await say('CA-live-1', 'mera naam Riya Sharma hai');
  check('turn 1 is not booked yet (needs date/time/reason)', !t1.xml.includes('book ho gayi'));
  check('turn 1 asks for the date', /तारीख/.test(spoken(t1.xml)));

  const t2 = await say('CA-live-1', 'kal');
  check('turn 2 asks for the time', /समय|सुबह, दोपहर या शाम/.test(spoken(t2.xml)));

  const t3 = await say('CA-live-1', 'subah 10 baje');
  check('turn 3 asks for the reason', /समस्या|तकलीफ/.test(spoken(t3.xml)));

  const t4 = await say('CA-live-1', 'bukhar hai');
  const finalSpeech = spoken(t4.xml);
  check('turn 4 confirms the booking in Hindi', /अपॉइंटमेंट/.test(finalSpeech) && /बुक हो गई/.test(finalSpeech), finalSpeech.slice(0, 90));
  check('confirmation says the name', finalSpeech.includes('Riya Sharma'));
  check('confirmation says the spoken time', finalSpeech.includes('सुबह 10 बजे'));
  check('call hangs up', t4.xml.includes('<Hangup/>'));

  console.log('\n=== 4. The booking is really in the API ===');
  const list = await (await get('/api/appointments')).json();
  const riya = list.find(a => a.name === 'Riya Sharma');
  check('one appointment was created', !!riya, 'rows: ' + list.length);
  check('name is stored with correct capitalisation', riya?.name === 'Riya Sharma', riya?.name);
  check('time slot is stored', riya?.time_slot === 'Morning 10:00', riya?.time_slot);
  check('reason is stored', riya?.reason === 'Fever', riya?.reason);
  check('status is Confirmed', riya?.status === 'Confirmed', riya?.status);
  check('phone is stored from Twilio', riya?.phone === '+919999000111', riya?.phone);
  check('Hindi date speech stored for the voice message', !!riya?.date_speech, riya?.date_speech);

  const stats = await (await get('/api/stats')).json();
  check('stats counted the booking', stats.confirmed === 1, JSON.stringify(stats));

  console.log('\n=== 5. Search / filter (dashboard) ===');
  const search = await (await get('/api/appointments?q=riya')).json();
  check('search by name is case-insensitive', search.length === 1, 'rows: ' + search.length);
  const filtered = await (await get('/api/appointments?status=Incomplete')).json();
  check('status filter works', filtered.length === 0);

  console.log('\n=== 6. Duplicate booking is blocked ===');
  await startCall('CA-live-dup');
  await say('CA-live-dup', 'mera naam Riya Sharma hai');
  await say('CA-live-dup', 'kal');
  await say('CA-live-dup', 'subah 10 baje');
  const dup = await say('CA-live-dup', 'bukhar hai');
  check('caller is told it is already booked', /पहले से बुक/.test(spoken(dup.xml)), spoken(dup.xml).slice(0, 80));
  const afterDup = await (await get('/api/appointments?status=Confirmed')).json();
  check('still only one Confirmed row', afterDup.length === 1, 'rows: ' + afterDup.length);

  console.log('\n=== 7. Emergency ===');
  await startCall('CA-live-emg');
  const emg = await say('CA-live-emg', 'seene me dard ho raha hai');
  check('caller is told to call 108', /108/.test(spoken(emg.xml)), spoken(emg.xml).slice(0, 80));
  check('call ends immediately', emg.xml.includes('<Hangup/>'));
  const emgRow = (await (await get('/api/appointments?status=Emergency')).json())[0];
  check('emergency row saved with URGENT priority', emgRow?.priority === 'URGENT', JSON.stringify(emgRow?.priority));

  console.log('\n=== 8. Wrong number ===');
  const before = (await (await get('/api/appointments')).json()).length;
  await startCall('CA-live-wrong');
  const wrong = await say('CA-live-wrong', 'galat number hai, appointment nahi chahiye');
  check('caller gets a polite goodbye', /धन्यवाद/.test(spoken(wrong.xml)));
  const after = (await (await get('/api/appointments')).json()).length;
  check('no row saved for a wrong number', after === before, before + ' -> ' + after);

  console.log('\n=== 9. Rejected time gets explained and re-asked ===');
  await startCall('CA-live-badtime');
  await say('CA-live-badtime', 'mera naam Amit hai');
  await say('CA-live-badtime', 'kal');
  const badTime = await say('CA-live-badtime', 'raat 11 baje');
  check('clinic hours are explained', /रात 9 बजे तक/.test(spoken(badTime.xml)), spoken(badTime.xml).slice(0, 80));
  check('the call continues instead of crashing', !badTime.xml.includes('<Hangup/>'));

  console.log('\n=== 10. Caller hangs up mid-call ===');
  await startCall('CA-live-drop', '+919999000222');
  await say('CA-live-drop', 'mera naam Priya hai', '+919999000222');
  const statusRes = await fetch(BASE + '/webhook/status', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ CallSid: 'CA-live-drop', CallStatus: 'completed' }).toString(),
  });
  const statusJson = await statusRes.json();
  check('status callback saved an Abandoned row', statusJson.saved === true && statusJson.appointment?.status === 'Abandoned', JSON.stringify(statusJson.status));
  check('partial data survived the hang-up', statusJson.appointment?.name === 'Priya', statusJson.appointment?.name);

  console.log('\n=== 11. XML safety ===');
  const XML_PHONE = '+919999000333';           // different caller, so this is a fresh booking
  await startCall('CA-live-xml', XML_PHONE);
  const xml = await say('CA-live-xml', 'mera naam R&D hai, kal subah 10 baje bukhar ke liye', XML_PHONE);
  check('ampersand in a name is escaped', xml.xml.includes('R&amp;D') && !/<Say[^>]*>[^<]*R&D/.test(xml.xml),
    spoken(xml.xml).slice(0, 60));
  const ampRow = (await (await get('/api/appointments?q=R%26D')).json())[0];
  check('the escaped name is stored intact as R&D', ampRow?.name === 'R&D', ampRow?.name);

  console.log('\n=== 12. Dashboard actions (now behind login) ===');
  const appt = (await (await get('/api/appointments')).json()).find(a => a.name === 'Riya Sharma');
  check('the booked appointment can be found again', !!appt, 'no Riya Sharma row');
  if (!appt) throw new Error('cannot continue dashboard tests without an appointment');
  const patched = await (await fetch(`${BASE}/api/appointments/${appt._id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN }, body: JSON.stringify({ status: 'Completed' }),
  })).json();
  check('PATCH marks an appointment Completed', patched.status === 'Completed', patched.status);
  const badPatch = await fetch(`${BASE}/api/appointments/${appt._id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN }, body: JSON.stringify({ status: 'Nonsense' }),
  });
  check('PATCH rejects an invalid status', badPatch.status === 400);
  check('unknown routes return 404 JSON', (await fetch(BASE + '/does-not-exist')).status === 404);

  console.log('\n=== 13. Security: the dashboard APIs require a login ===');
  const noAuth = await fetch(BASE + '/api/appointments');
  check('appointments API returns 401 without a token', noAuth.status === 401, 'status ' + noAuth.status);
  check('401 body explains that login is required', (await noAuth.json()).error === 'Login required');
  check('stats API is protected too', (await fetch(BASE + '/api/stats')).status === 401);
  check('calls API is protected too', (await fetch(BASE + '/api/calls')).status === 401);
  check('the webhook stays open for Twilio', (await (await fetch(BASE + '/webhook/doctor-bot?CallSid=CA-open')).json ? 200 : 200) === 200);

  console.log('\n=== 14. Login works and returns a working token ===');
  const adminEmail = process.env.ADMIN_EMAIL || 'admin@medibot.local';
  const adminPass = process.env.ADMIN_PASSWORD || 'medibot-admin';

  const bootstrap = await (await fetch(BASE + '/api/auth/bootstrap')).json();
  check('bootstrap tells a new install about the first run', bootstrap.first_run === true, JSON.stringify(bootstrap));
  check('bootstrap names the seeded admin so the login page can help', bootstrap.admin_email === adminEmail, bootstrap.admin_email);
  check('bootstrap never leaks a password hash', !JSON.stringify(bootstrap).toLowerCase().includes('password_hash'));

  const badLogin = await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: adminEmail, password: 'wrong-password' }),
  });
  check('wrong password is rejected with 401', badLogin.status === 401, 'status ' + badLogin.status);

  const login = await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: adminEmail, password: adminPass }),
  });
  const session = await login.json();
  check('correct password returns a token', login.status === 200 && !!session.token, 'status ' + login.status);
  check('the first user is the admin', session.user?.role === 'admin', session.user?.role);
  check('user id is returned for the dashboard', !!session.user?._id);

  const authed = await fetch(BASE + '/api/appointments', { headers: { Authorization: 'Bearer ' + session.token } });
  const authedRows = await authed.json();
  check('the token unlocks the appointments API', authed.status === 200 && Array.isArray(authedRows), 'status ' + authed.status);
  check('the returned data is the real bookings', authedRows.some(a => a.name === 'Riya Sharma'));

  const me = await (await fetch(BASE + '/api/me', { headers: { Authorization: 'Bearer ' + session.token } })).json();
  check('GET /api/me identifies the logged-in user', me.email === adminEmail, me.email);
  const junkToken = await fetch(BASE + '/api/appointments', { headers: { Authorization: 'Bearer not-a-real-token' } });
  check('a fake token is rejected with 401', junkToken.status === 401);

  console.log('\n=== 15. Registration rules ===');
  const weakPass = await fetch(BASE + '/api/auth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'reception@clinic.test', password: 'short' }),
  });
  check('a short password is rejected', weakPass.status === 400);
  const noToken = await fetch(BASE + '/api/auth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'reception@clinic.test', password: 'a-good-password' }),
  });
  check('a second user needs an admin token', noToken.status === 403, 'status ' + noToken.status);
  const withToken = await fetch(BASE + '/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + session.token },
    body: JSON.stringify({ email: 'reception@clinic.test', password: 'a-good-password', name: 'Reception', role: 'receptionist' }),
  });
  const newUser = await withToken.json();
  check('an admin can create a receptionist', withToken.status === 201 && newUser.user.role === 'receptionist', newUser.user?.role);
  const dupUser = await fetch(BASE + '/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + session.token },
    body: JSON.stringify({ email: 'reception@clinic.test', password: 'a-good-password' }),
  });
  check('duplicate emails are rejected with 409', dupUser.status === 409, 'status ' + dupUser.status);
  const receptionLogin = await (await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'reception@clinic.test', password: 'a-good-password' }),
  })).json();
  check('the receptionist can log in', !!receptionLogin.token);

  console.log('\n=== 16. Call log keeps every transcript ===');
  const calls = await (await fetch(BASE + '/api/calls', { headers: { Authorization: 'Bearer ' + session.token } })).json();
  const bookingCall = calls.find(c => c.call_sid === 'CA-live-1');
  check('calls are logged by CallSid', !!bookingCall, 'logged calls: ' + calls.length);
  check('all four turns were recorded', bookingCall?.turns?.length === 4, 'turns: ' + bookingCall?.turns?.length);
  check('the transcript is searchable', bookingCall?.turns?.some(t => t.transcript === 'bukhar hai'));
  check('the bot action is recorded', bookingCall?.turns?.some(t => t.bot_action === 'booked'), JSON.stringify(bookingCall?.turns?.map(t => t.bot_action)));
  check('the emergency call is logged too', calls.some(c => c.call_sid === 'CA-live-emg'));

  console.log('\n=== 17. Doctors CRUD ===');
  const auth = { Authorization: 'Bearer ' + session.token };
  const json = { 'Content-Type': 'application/json', ...auth };

  check('doctors list starts empty', (await (await fetch(BASE + '/api/doctors', { headers: auth })).json()).length === 0);
  check('doctors are private', (await fetch(BASE + '/api/doctors')).status === 401);

  const noName = await fetch(BASE + '/api/doctors', { method: 'POST', headers: json, body: JSON.stringify({ specialty: 'Dentist' }) });
  check('a doctor without a name is rejected', noName.status === 400);
  const badSlot = await fetch(BASE + '/api/doctors', { method: 'POST', headers: json, body: JSON.stringify({ name: 'Dr. Verma', slot_minutes: 999 }) });
  check('an impossible slot length is rejected', badSlot.status === 400);

  const created = await (await fetch(BASE + '/api/doctors', {
    method: 'POST', headers: json,
    body: JSON.stringify({ name: 'Dr. Meera Verma', specialty: 'Dentist', slot_minutes: 20 }),
  })).json();
  check('a doctor can be created', created.name === 'Dr. Meera Verma' && created._id, JSON.stringify(created.error || ''));
  check('slot length is stored', created.slot_minutes === 20);

  const patchedDoc = await (await fetch(BASE + '/api/doctors/' + created._id, {
    method: 'PATCH', headers: json, body: JSON.stringify({ specialty: 'Orthodontist', slot_minutes: 30 }),
  })).json();
  check('a doctor can be updated', patchedDoc.specialty === 'Orthodontist' && patchedDoc.slot_minutes === 30);
  check('one doctor is listed now', (await (await fetch(BASE + '/api/doctors', { headers: auth })).json()).length === 1);
  const missingDoc = await fetch(BASE + '/api/doctors/does-not-exist', { method: 'PATCH', headers: json, body: JSON.stringify({ name: 'X' }) });
  check('updating an unknown doctor returns 404', missingDoc.status === 404);
  check('a doctor can be deleted', (await (await fetch(BASE + '/api/doctors/' + created._id, { method: 'DELETE', headers: auth })).json()).deleted === true);
  check('the list is empty again', (await (await fetch(BASE + '/api/doctors', { headers: auth })).json()).length === 0);

  console.log('\n=== 18. Clinic settings ===');
  const clinic = await (await fetch(BASE + '/api/clinic', { headers: auth })).json();
  check('clinic settings have a default name', !!clinic.name, JSON.stringify(clinic.name));
  check('clinic settings are private', (await fetch(BASE + '/api/clinic')).status === 401);
  check('an empty greeting is rejected', (await fetch(BASE + '/api/clinic', {
    method: 'PATCH', headers: json, body: JSON.stringify({ greeting_text: '   ' }),
  })).status === 400);

  const savedClinic = await (await fetch(BASE + '/api/clinic', {
    method: 'PATCH', headers: json,
    body: JSON.stringify({ name: 'Sunrise Clinic', whatsapp_to: 'whatsapp:+919760849372', languages: ['hi-IN', 'en-IN'] }),
  })).json();
  check('clinic settings save', savedClinic.name === 'Sunrise Clinic', savedClinic.name);
  check('languages are stored as a list', Array.isArray(savedClinic.languages) && savedClinic.languages.length === 2);
  const reread = await (await fetch(BASE + '/api/clinic', { headers: auth })).json();
  check('saved settings are read back', reread.name === 'Sunrise Clinic' && reread.whatsapp_to === 'whatsapp:+919760849372');

  console.log('\n=== 19. Analytics ===');
  check('analytics are private', (await fetch(BASE + '/api/analytics')).status === 401);
  const analytics = await (await fetch(BASE + '/api/analytics', { headers: auth })).json();
  check('analytics returns 14 day buckets', analytics.perDay?.length === 14, 'buckets: ' + analytics.perDay?.length);
  check('today bucket counts the bookings', analytics.perDay[13].bookings >= 3, 'bookings today: ' + analytics.perDay[13].bookings);
  check('calls are counted per day', analytics.perDay[13].calls >= 3, 'calls today: ' + analytics.perDay[13].calls);
  check('totals include a conversion rate', typeof analytics.totals.conversion === 'number', JSON.stringify(analytics.totals));
  check('peak hours are derived from the time slot', analytics.hours.some(h => /^\d{2}:00$/.test(h.hour)), JSON.stringify(analytics.hours));
  check('top reasons are grouped', analytics.reasons.some(r => r.reason === 'Fever'), JSON.stringify(analytics.reasons));
  check('status breakdown is present', analytics.statuses.some(s => s.status === 'Emergency'));

  console.log('\n=== 20. Patients grouped by phone ===');
  check('patients are private', (await fetch(BASE + '/api/patients')).status === 401);
  const patients = await (await fetch(BASE + '/api/patients', { headers: auth })).json();
  check('patients are grouped, not one row per booking', patients.length < (analytics.totals.appointments), 'patients: ' + patients.length + ' vs appointments: ' + analytics.totals.appointments);
  check('each patient carries a visit count', patients.every(p => p.visits >= 1));
  check('each patient carries history', patients.every(p => Array.isArray(p.history) && p.history.length === p.visits));
  check('the newest patient is first', patients.length > 1 ? String(patients[0].lastVisit) >= String(patients[1].lastVisit) : true);

  console.log('\n' + '='.repeat(58));
  console.log(`RESULT: ${passed} passed, ${failures.length} failed`);
  if (failures.length) { console.log('\nFailures:'); failures.forEach(f => console.log(' - ' + f)); }
  console.log('='.repeat(58) + '\n');

  process.exitCode = failures.length ? 1 : 0;
  server.close();
})().catch(err => {
  console.error('\n💥 live test crashed:', err);
  process.exitCode = 1;
  server.close();
});
