'use strict';
/* ==========================================================================
 * End-to-end conversation tests with an in-memory store.
 * Proves the backend behaves like the n8n workflow, including the edge cases
 * that used to be missing (duplicates, full slots, hang-ups, emergencies).
 *
 *   node --test
 * ========================================================================== */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createConversation } = require('./conversation');

const TODAY = new Date(2026, 5, 22);   // Monday 22 June 2026

function createMemoryStore() {
  const sessions = new Map();
  const appointments = [];
  return {
    appointments, sessions,
    async getSession(sid) { return sessions.get(sid) || null; },
    async saveSession(s) { sessions.set(s.call_sid, Object.assign({}, s)); return s; },
    async clearSession(sid) { sessions.delete(sid); },
    async findDuplicate({ phone, date, time_slot }) {
      return appointments.find(a => a.phone === phone && a.date === date && a.time_slot === time_slot && a.status === 'Confirmed') || null;
    },
    async countBooked({ date, time_slot }) {
      return appointments.filter(a => a.date === date && a.time_slot === time_slot && a.status === 'Confirmed').length;
    },
    async createAppointment(data) {
      const doc = Object.assign({ _id: 'id-' + (appointments.length + 1) }, data);
      appointments.push(doc);
      return doc;
    },
  };
}

function makeBot(store, options) {
  return createConversation(Object.assign({ store, now: () => TODAY }, options || {}));
}

let sidCounter = 0;
function newSid() { return 'CA-test-' + (++sidCounter); }

async function talk(bot, store, utterances, from = '+919760849372') {
  const sid = newSid();
  const turns = [];
  for (const said of utterances) {
    const r = await bot.handleTurn({ callSid: sid, from, transcript: said, actionUrl: 'https://x.test/webhook/doctor-bot' });
    turns.push(r);
    if (r.ended) break;
  }
  return { sid, turns, last: turns[turns.length - 1] };
}

// ------------------------------------------------------------------ greeting
test('incoming call gets a Hindi greeting with a Gather', () => {
  const bot = makeBot(createMemoryStore());
  const xml = bot.greetingTwiml('https://x.test/webhook/doctor-bot');
  assert.match(xml, /नमस्ते/);
  assert.match(xml, /<Gather/);
  assert.match(xml, /actionOnEmptyResult="true"/);
  assert.match(xml, /https:\/\/x\.test\/webhook\/doctor-bot/);
});

// -------------------------------------------------------------- happy paths
test('a full 4-turn call books exactly one appointment after confirmation', async () => {
  const store = createMemoryStore();
  const bot = makeBot(store);
  const call = await talk(bot, store, ['mera naam Priya Sharma hai', 'kal', 'subah 10 baje', 'bukhar hai', 'haan sahi hai']);

  assert.equal(call.last.ended, true);
  assert.equal(call.last.status, 'Confirmed');
  assert.match(call.last.twiml, /Priya Sharma/);
  assert.match(call.last.twiml, /सुबह 10 बजे/);
  assert.equal(store.appointments.length, 1);
  assert.equal(store.appointments[0].date, '23/06/2026');
  assert.equal(store.appointments[0].time_slot, 'Morning 10:00');
  assert.equal(store.appointments[0].reason, 'Fever');
  assert.equal(store.appointments[0].status, 'Confirmed');
});

test('the bot reads the booking back and only saves after the caller agrees', async () => {
  const store = createMemoryStore();
  const bot = makeBot(store);
  // First turn collects everything but must NOT save yet - it asks "Sahi hai?".
  const readback = await bot.handleTurn({
    callSid: 'CA-rb', from: '+919760849372',
    transcript: 'mera naam Riya hai, kal shaam 5 baje khansi ke liye',
    actionUrl: 'https://x.test/webhook/doctor-bot',
  });
  assert.equal(readback.ended, false);
  assert.equal(readback.awaiting_confirm, true);
  assert.match(readback.twiml, /सही है/);
  assert.equal(store.appointments.length, 0);        // nothing saved before confirmation
});

test('one sentence is enough to book immediately', async () => {
  const store = createMemoryStore();
  const bot = makeBot(store);
  const call = await talk(bot, store, ['mera naam Riya hai, kal shaam 5 baje khansi ke liye', 'haan sahi hai']);
  assert.equal(call.last.status, 'Confirmed');
  assert.equal(store.appointments[0].time_slot, 'Evening 17:00');
});

test('the clinic WhatsApp text is built correctly', async () => {
  const store = createMemoryStore();
  const bot = makeBot(store);
  let sentBody = null;
  const call = await talk(bot, store, ['mera naam Riya hai, kal shaam 5 baje khansi ke liye', 'haan sahi hai']);
  sentBody = bot.whatsappText(call.last.appointment);
  assert.match(sentBody, /Patient Name: Riya/);
  assert.match(sentBody, /Time Slot: Evening 17:00/);
  assert.match(sentBody, /Medical Reason: Cough/);
  assert.match(sentBody, /Status: Confirmed/);
  assert.equal(sentBody.includes('undefined'), false);
});

// ---------------------------------------------------------------- edge cases
test('the same caller cannot book the same slot twice', async () => {
  const store = createMemoryStore();
  const bot = makeBot(store);
  await talk(bot, store, ['mera naam Riya hai, kal subah 10 baje bukhar ke liye', 'haan sahi hai']);
  const second = await talk(bot, store, ['mera naam Riya hai, kal subah 10 baje bukhar ke liye']);

  assert.equal(second.last.duplicate, true);
  assert.equal(second.last.status, 'Duplicate');
  assert.match(second.last.twiml, /पहले से बुक/);
  assert.equal(store.appointments.filter(a => a.status === 'Confirmed').length, 1);
});

test('a full slot sends the caller back to pick another time', async () => {
  const store = createMemoryStore();
  const bot = makeBot(store, { maxPerSlot: 1 });

  await talk(bot, store, ['mera naam Riya hai, kal subah 10 baje bukhar ke liye', 'haan sahi hai'], '+911111111111');
  const second = await talk(bot, store, ['mera naam Amit hai, kal subah 10 baje bukhar ke liye'], '+912222222222');

  assert.equal(second.last.ended, false);             // still on the call
  assert.match(second.last.twiml, /भर चुका है/);        // told the slot is full
  assert.equal(second.last.asked_field, 'time_slot');
  assert.equal(store.appointments.filter(a => a.status === 'Confirmed').length, 1);
});

test('a caller who hangs up mid-call still appears as Abandoned', async () => {
  const store = createMemoryStore();
  const bot = makeBot(store);
  const call = await talk(bot, store, ['mera naam Priya hai', 'kal']);
  const result = await bot.handleStatus({ callSid: call.sid, callStatus: 'completed' });

  assert.equal(result.saved, true);
  assert.equal(result.appointment.status, 'Abandoned');
  assert.equal(result.appointment.name, 'Priya');
  assert.equal(result.appointment.date, '23/06/2026');
});

test('an empty call saves nothing', async () => {
  const store = createMemoryStore();
  const bot = makeBot(store);
  const call = await talk(bot, store, ['hello']);
  const result = await bot.handleStatus({ callSid: call.sid, callStatus: 'no-answer' });
  assert.equal(result.saved, false);
  assert.equal(store.appointments.length, 0);
});

test('emergency is saved as URGENT and the caller is told to call 108', async () => {
  const store = createMemoryStore();
  const bot = makeBot(store);
  const call = await talk(bot, store, ['seene me dard ho raha hai']);
  assert.match(call.last.twiml, /108/);
  assert.equal(call.last.status, 'Emergency');
  assert.equal(store.appointments[0].priority, 'URGENT');
});

test('a wrong number ends the call and saves nothing', async () => {
  const store = createMemoryStore();
  const bot = makeBot(store);
  const call = await talk(bot, store, ['galat number hai']);
  assert.equal(call.last.ended, true);
  assert.equal(call.last.status, 'Wrong Number');
  assert.equal(store.appointments.length, 0);
});

test('three fruitless turns save the partial row as Incomplete', async () => {
  const store = createMemoryStore();
  const bot = makeBot(store);
  const call = await talk(bot, store, ['mera naam Priya hai', 'hmm', 'hello', 'hello']);
  assert.equal(call.last.status, 'Incomplete');
  assert.equal(store.appointments[0].status, 'Incomplete');
});

test('a correction replaces the earlier answer', async () => {
  const store = createMemoryStore();
  const bot = makeBot(store);
  const call = await talk(bot, store, ['mera naam Priya hai', 'kal subah 10 baje', 'nahi, shaam 5 baje', 'bukhar hai', 'haan sahi hai']);
  assert.equal(call.last.status, 'Confirmed');
  assert.equal(store.appointments[0].time_slot, 'Evening 17:00');
});

test('a rejected time is re-asked with an explanation', async () => {
  const store = createMemoryStore();
  const bot = makeBot(store);
  const call = await talk(bot, store, ['mera naam Priya hai', 'kal', 'raat 11 baje']);
  const third = call.turns[2];
  assert.equal(third.ended, false);
  assert.match(third.twiml, /रात 9 बजे तक/);
  assert.equal(third.asked_field, 'time_slot');
});

test('dangerous characters never break the TwiML', async () => {
  const store = createMemoryStore();
  const bot = makeBot(store);
  const call = await talk(bot, store, ['mera naam R&D hai, kal subah 10 baje bukhar ke liye']);
  assert.match(call.last.twiml, /R&amp;D/);
  assert.equal(/<Say[^>]*>[^<]*R&D/.test(call.last.twiml), false);
});

test('the store is told about every talking turn so a hang-up keeps the data', async () => {
  const store = createMemoryStore();
  const bot = makeBot(store);
  const call = await talk(bot, store, ['mera naam Priya hai']);
  const session = store.sessions.get(call.sid);
  assert.equal(session.name, 'Priya');
  assert.equal(session.asked_field, 'date');
  assert.equal(session.attempt, 1);
});

// ------------------------------------------------- confirmation read-back loop
test('saying "nahi" to the read-back re-opens date+time and never saves a wrong row', async () => {
  const store = createMemoryStore();
  const bot = makeBot(store);
  // Collect everything -> read-back -> "nahi" -> new date/time -> "haan" -> booked.
  const call = await talk(bot, store, [
    'mera naam Priya hai',
    'kal subah 10 baje',
    'bukhar hai',
    'nahi',                 // reject the read-back
    'parso shaam 5 baje',   // corrected date + time
    'haan sahi hai',
  ]);
  assert.equal(call.last.status, 'Confirmed');
  assert.equal(store.appointments.length, 1);
  assert.equal(store.appointments[0].date, '24/06/2026');       // parso, not kal
  assert.equal(store.appointments[0].time_slot, 'Evening 17:00');
  // The rejected "kal 10:00" must never have been written.
  assert.equal(store.appointments.some(a => a.time_slot === 'Morning 10:00'), false);
});

test('an unclear answer repeats the read-back and still saves nothing', async () => {
  const store = createMemoryStore();
  const bot = makeBot(store);
  const call = await talk(bot, store, [
    'mera naam Priya hai, kal subah 10 baje bukhar ke liye',
    'kya matlab',           // not a yes/no
  ]);
  assert.equal(call.last.ended, false);
  assert.equal(call.last.awaiting_confirm, true);
  assert.match(call.last.twiml, /सही है/);
  assert.equal(store.appointments.length, 0);
});

// ------------------------------------------------- doctor availability checks
// Doctor works Tue(2)..Sat(6) 09:00-17:00, off Sunday(0) and Monday(1),
// and 2026-06-25 is a holiday.
const DOCTOR = {
  name: 'Dr. Sharma',
  working_hours: [
    { day: 2, start: '09:00', end: '17:00' },
    { day: 3, start: '09:00', end: '17:00' },
    { day: 4, start: '09:00', end: '17:00' },
    { day: 5, start: '09:00', end: '17:00' },
    { day: 6, start: '09:00', end: '17:00' },
  ],
  holidays: ['2026-06-25'],
};
const doctorProvider = async () => DOCTOR;

test('doctor off that weekday is told to pick another day', async () => {
  const store = createMemoryStore();
  const bot = makeBot(store, { doctorProvider });
  // today is Mon 22 Jun; "parso" = Wed 24 (works). Use "kal" = Tue 23 (works).
  // Monday 29 Jun ("agle hafte") is a day the doctor does NOT work.
  const call = await talk(bot, store, [
    'mera naam Priya hai',
    'agle hafte',           // Mon 29 Jun -> doctor off
    'subah 10 baje',
    'bukhar hai',
  ]);
  const last = call.turns[call.turns.length - 1];
  assert.equal(last.ended, false);
  assert.equal(last.asked_field, 'date');                 // sent back to the date
  assert.match(last.twiml, /उपलब्ध नहीं/);                 // doctor_off hint
  assert.equal(store.appointments.length, 0);
});

test('a doctor holiday refuses the date and asks for another day', async () => {
  const store = createMemoryStore();
  const bot = makeBot(store, { doctorProvider });
  // 25 Jun 2026 is a Thursday and a holiday.
  const call = await talk(bot, store, [
    'mera naam Priya hai',
    '25 june',
    'subah 10 baje',
    'bukhar hai',
  ]);
  const last = call.turns[call.turns.length - 1];
  assert.equal(last.ended, false);
  assert.equal(last.asked_field, 'date');
  assert.match(last.twiml, /बंद रहता है/);                  // closed_day hint
  assert.equal(store.appointments.length, 0);
});

test('a time outside the doctor working hours is sent back to the time slot', async () => {
  const store = createMemoryStore();
  const bot = makeBot(store, { doctorProvider });
  // Tue 23 Jun works 09:00-17:00; shaam 8 baje = 20:00 is after hours.
  const call = await talk(bot, store, [
    'mera naam Priya hai',
    'kal',
    'shaam 8 baje',
    'bukhar hai',
  ]);
  const last = call.turns[call.turns.length - 1];
  assert.equal(last.ended, false);
  assert.equal(last.asked_field, 'time_slot');             // only the time re-opened
  assert.match(last.twiml, /उपलब्ध नहीं/);                  // doctor_off hint
  assert.equal(store.appointments.length, 0);
});

test('a valid slot inside the doctor hours still books after confirmation', async () => {
  const store = createMemoryStore();
  const bot = makeBot(store, { doctorProvider });
  const call = await talk(bot, store, [
    'mera naam Priya hai',
    'kal',                    // Tue 23 Jun, inside 09:00-17:00
    'subah 10 baje',
    'bukhar hai',
    'haan sahi hai',
  ]);
  assert.equal(call.last.status, 'Confirmed');
  assert.equal(store.appointments.length, 1);
  assert.equal(store.appointments[0].date, '23/06/2026');
});
