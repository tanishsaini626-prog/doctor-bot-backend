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
  const list = await (await fetch(BASE + '/api/appointments')).json();
  const riya = list.find(a => a.name === 'Riya Sharma');
  check('one appointment was created', !!riya, 'rows: ' + list.length);
  check('name is stored with correct capitalisation', riya?.name === 'Riya Sharma', riya?.name);
  check('time slot is stored', riya?.time_slot === 'Morning 10:00', riya?.time_slot);
  check('reason is stored', riya?.reason === 'Fever', riya?.reason);
  check('status is Confirmed', riya?.status === 'Confirmed', riya?.status);
  check('phone is stored from Twilio', riya?.phone === '+919999000111', riya?.phone);
  check('Hindi date speech stored for the voice message', !!riya?.date_speech, riya?.date_speech);

  const stats = await (await fetch(BASE + '/api/stats')).json();
  check('stats counted the booking', stats.confirmed === 1, JSON.stringify(stats));

  console.log('\n=== 5. Search / filter (dashboard) ===');
  const search = await (await fetch(BASE + '/api/appointments?q=riya')).json();
  check('search by name is case-insensitive', search.length === 1, 'rows: ' + search.length);
  const filtered = await (await fetch(BASE + '/api/appointments?status=Incomplete')).json();
  check('status filter works', filtered.length === 0);

  console.log('\n=== 6. Duplicate booking is blocked ===');
  await startCall('CA-live-dup');
  await say('CA-live-dup', 'mera naam Riya Sharma hai');
  await say('CA-live-dup', 'kal');
  await say('CA-live-dup', 'subah 10 baje');
  const dup = await say('CA-live-dup', 'bukhar hai');
  check('caller is told it is already booked', /पहले से बुक/.test(spoken(dup.xml)), spoken(dup.xml).slice(0, 80));
  const afterDup = await (await fetch(BASE + '/api/appointments?status=Confirmed')).json();
  check('still only one Confirmed row', afterDup.length === 1, 'rows: ' + afterDup.length);

  console.log('\n=== 7. Emergency ===');
  await startCall('CA-live-emg');
  const emg = await say('CA-live-emg', 'seene me dard ho raha hai');
  check('caller is told to call 108', /108/.test(spoken(emg.xml)), spoken(emg.xml).slice(0, 80));
  check('call ends immediately', emg.xml.includes('<Hangup/>'));
  const emgRow = (await (await fetch(BASE + '/api/appointments?status=Emergency')).json())[0];
  check('emergency row saved with URGENT priority', emgRow?.priority === 'URGENT', JSON.stringify(emgRow?.priority));

  console.log('\n=== 8. Wrong number ===');
  const before = (await (await fetch(BASE + '/api/appointments')).json()).length;
  await startCall('CA-live-wrong');
  const wrong = await say('CA-live-wrong', 'galat number hai, appointment nahi chahiye');
  check('caller gets a polite goodbye', /धन्यवाद/.test(spoken(wrong.xml)));
  const after = (await (await fetch(BASE + '/api/appointments')).json()).length;
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
  const ampRow = (await (await fetch(BASE + '/api/appointments?q=R%26D')).json())[0];
  check('the escaped name is stored intact as R&D', ampRow?.name === 'R&D', ampRow?.name);

  console.log('\n=== 12. Dashboard actions ===');
  const appt = (await (await fetch(BASE + '/api/appointments')).json()).find(a => a.name === 'Riya Sharma');
  check('the booked appointment can be found again', !!appt, 'no Riya Sharma row');
  if (!appt) throw new Error('cannot continue dashboard tests without an appointment');
  const patched = await (await fetch(`${BASE}/api/appointments/${appt._id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'Completed' }),
  })).json();
  check('PATCH marks an appointment Completed', patched.status === 'Completed', patched.status);
  const badPatch = await fetch(`${BASE}/api/appointments/${appt._id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'Nonsense' }),
  });
  check('PATCH rejects an invalid status', badPatch.status === 400);
  check('unknown routes return 404 JSON', (await fetch(BASE + '/does-not-exist')).status === 404);

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
