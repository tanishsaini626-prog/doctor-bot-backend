/* ==========================================================================
 * Edge-case tests for bot-engine.js (copy of doctor-bot-audio/lib/bot-engine.js)
 *   node --test tests/
 * ========================================================================== */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('./bot-engine.js');

// Monday 22 June 2026 -> "kal" is Tue 23, "parso" is Wed 24, Sunday is 28 June.
const TODAY = new Date(2026, 5, 22);

function x(transcript, opts) {
  return E.extract(Object.assign({ transcript, today: TODAY, attempt: 1 }, opts || {}));
}

// ------------------------------------------------------------------- silence
test('empty / noise input never wipes previous answers', () => {
  const r = x('', { asked_field: 'date', prev: { name: 'Priya' } });
  assert.equal(r.is_noise, true);
  assert.equal(r.name, 'Priya');
  assert.equal(r.missing.some(m => m.field === 'name'), false);
});

test('noise phrases are recognised', () => {
  for (const t of ['hello', 'hmm hmm', '[Background noise]', '(inaudible)', 'aa']) {
    assert.equal(x(t).is_noise, true, `expected noise: ${t}`);
  }
});

// ---------------------------------------------------------------------- name
test('name extraction keeps capitalisation and strips honorifics', () => {
  assert.equal(x('mera naam Priya Sharma hai').name, 'Priya Sharma');
  assert.equal(x('Dr. Tanish bol raha hoon').name, 'Tanish');
  assert.equal(x('meri mummy ka naam Sunita hai').name, 'Sunita');
  assert.equal(x('priya').name, null);                       // not asked yet -> ignored
  assert.equal(x('priya', { asked_field: 'name' }).name, 'Priya');
});

test('common words are never mistaken for a name', () => {
  for (const t of ['haan', 'kal', 'bukhar', 'nahi', 'theek hai']) {
    const r = x(t, { asked_field: 'name' });
    assert.equal(r.name, null, `"${t}" must not become a name`);
  }
});

// -------------------------------------------------------------------- relation
test('who the appointment is for is detected', () => {
  assert.equal(x('meri mummy ke liye appointment chahiye').booking_for, 'Mother');
  assert.equal(x('mere papa ke liye').booking_for, 'Father');
  assert.equal(x('meri beti ke liye').booking_for, 'Daughter');
  assert.equal(x('apne liye appointment chahiye').booking_for, 'Self');
  // "maafi" contains "maa" but must not match Mother
  assert.equal(x('maafi chahiye').booking_for, 'Self');
});

// ---------------------------------------------------------------------- date
test('relative dates', () => {
  assert.equal(x('aaj aana hai').date, '22/06/2026');
  assert.equal(x('kal subah').date, '23/06/2026');
  assert.equal(x('parso').date, '24/06/2026');
  assert.equal(x('agle hafte').date, '29/06/2026');
});

test('explicit dates', () => {
  assert.equal(x('25 june').date, '25/06/2026');
  assert.equal(x('24/6').date, '24/06/2026');
  assert.equal(x('24-06-2026').date, '24/06/2026');
  assert.equal(x('6/24').date, '24/06/2026');                 // MM/DD falls back correctly
  assert.equal(x('8 tarikh').date, '08/07/2026');            // already passed -> next month
  assert.equal(x('somvar').date, '22/06/2026');               // today is Monday
});

test('impossible and past dates are rejected with a hint', () => {
  assert.equal(x('32 january').hint, 'invalid_date');
  assert.equal(x('31 february').hint, 'invalid_date');
  assert.equal(x('1 june').hint, 'past_date');
  assert.equal(x('aaj', {}).date, '22/06/2026');
});

test('clinic-closed day (Sunday) is rejected with a hint', () => {
  const r = x('28 june', { asked_field: 'date' });            // 28 June 2026 is a Sunday
  assert.equal(r.date, null);
  assert.equal(r.hint, 'closed_day');
});

test('a clock reading is never parsed as a date', () => {
  const r = x('subah 10.30 baje');
  assert.equal(r.date, null);
  assert.equal(r.hint, null);
  assert.equal(r.time_slot, 'Morning 10:30');
});

// ---------------------------------------------------------------------- time
test('time slots: morning / afternoon / evening / night', () => {
  assert.equal(x('subah 10 baje').time_slot, 'Morning 10:00');
  assert.equal(x('dopahar 3 baje').time_slot, 'Afternoon 15:00');
  assert.equal(x('shaam 4 baje').time_slot, 'Evening 16:00');
  assert.equal(x('raat 9 baje').time_slot, 'Night 21:00');
  assert.equal(x('shaam 9 baje').time_slot, 'Night 21:00');   // 9 PM is night, not evening
  assert.equal(x('14 baje').time_slot, 'Afternoon 14:00');
  assert.equal(x('12 baje dopahar').time_slot, 'Afternoon 12:00');
});

test('the "shaam -> sam" speech-to-text bug stays fixed', () => {
  assert.equal(x('sam 5 baje').time_slot, 'Evening 17:00');
  assert.equal(x('shyam 5 baje').time_slot, 'Evening 17:00');
});

test('Hinglish half-hours', () => {
  assert.equal(x('saadhe 4 baje').time_slot, 'Evening 16:30');
  assert.equal(x('sava 10 baje').time_slot, 'Morning 10:15');
  assert.equal(x('paune 5 baje').time_slot, 'Evening 16:45');
  assert.equal(x('subah 10.30').time_slot, 'Morning 10:30');
  assert.equal(x('subah 10:45 baje').time_slot, 'Morning 10:45');
});

test('"4 baje" alone is read as 4 PM, not 4 AM', () => {
  assert.equal(x('4 baje').time_slot, 'Evening 16:00');
});

test('hours outside clinic hours are rejected with a hint', () => {
  assert.equal(x('raat 11 baje').hint, 'out_of_hours');
  assert.equal(x('subah 6 baje').hint, 'out_of_hours');
  assert.equal(x('raat 12 baje').hint, 'out_of_hours');
  assert.equal(x('raat 9 baje').hint, null);                  // 21:00 is the last slot
});

test('"any time" gets a real slot', () => {
  assert.equal(x('koi bhi time chalega').time_slot, 'Morning 10:00');
});

// -------------------------------------------------------------------- reason
test('medical reasons, including two symptoms in one sentence', () => {
  assert.equal(x('bukhar hai').reason, 'Fever');
  assert.equal(x('bukhar aur khansi hai').reason, 'Fever, Cough');
  assert.equal(x('pet dard ho raha hai').reason, 'Stomach pain');
  assert.equal(x('tabiyat kharab hai').reason, 'General Checkup');
  assert.equal(x('checkup ke liye').reason, 'Checkup');
});

// --------------------------------------------------------------- call states
test('wrong number is detected and ends the call', () => {
  const r = x('galat number hai, appointment nahi chahiye');
  assert.equal(r.is_wrong_number, true);
  assert.equal(r.is_emergency, false);
});

test('emergency phrases are detected', () => {
  for (const t of ['seene me dard', 'saans nahi aa rahi', 'behosh ho gaya', 'bahut bleeding']) {
    assert.equal(x(t).is_emergency, true, `expected emergency: ${t}`);
  }
});

test('"call me later" is detected', () => {
  assert.equal(x('abhi busy hoon, baad me call karta hoon').is_callback, true);
});

// -------------------------------------------------- multi-slot + corrections
test('everything in one sentence is captured at once', () => {
  const r = x('mera naam Priya Sharma hai, kal subah 10 baje bukhar ke liye appointment chahiye');
  assert.equal(r.name, 'Priya Sharma');
  assert.equal(r.date, '23/06/2026');
  assert.equal(r.time_slot, 'Morning 10:00');
  assert.equal(r.reason, 'Fever');
  assert.equal(r.all_collected, true);
});

test('a new answer always overrides the previous one (corrections work)', () => {
  const prev = { name: 'Priya', date: '23/06/2026', time_slot: 'Morning 10:00', reason: 'Fever', booking_for: 'Self' };
  const r = x('nahi nahi, shaam 5 baje', { asked_field: 'time_slot', prev });
  assert.equal(r.time_slot, 'Evening 17:00');
  assert.equal(r.name, 'Priya');            // untouched slots survive
  assert.equal(r.date, '23/06/2026');
  assert.equal(r.reason, 'Fever');
});

test('a rejected new answer re-opens only that slot', () => {
  const prev = { name: 'Priya', date: '23/06/2026', time_slot: 'Morning 10:00', reason: 'Fever', booking_for: 'Self' };
  const r = x('raat 11 baje kar do', { asked_field: 'time_slot', prev });
  assert.equal(r.time_slot, null);
  assert.equal(r.hint, 'out_of_hours');
  assert.equal(r.name, 'Priya');
});

test('no-progress turns are counted, progress resets the counter', () => {
  const a = x('mujhe appointment chahiye', { attempt: 1, prev_missing_count: 4 });
  assert.equal(a.progressed, false);
  const b = x('kal', { attempt: 2, prev_missing_count: 4, asked_field: 'date' });
  assert.equal(b.progressed, true);
});

// ------------------------------------------------------------------ escaping
test('dangerous characters in names are escaped in TwiML', () => {
  const r = x('mera naam R&D hai');
  assert.equal(r.name, 'R&D');
  const twiml = E.wrapTwiml(E.say('Thank you ' + r.name));
  assert.equal(twiml.includes('R&amp;D'), true);
  assert.equal(/R&D/.test(twiml), false);
});

test('Twilio URL parameters are XML-escaped', () => {
  const url = E.gather('hello', 'https://x/webhook/gather?prev_name=A&attempt=2');
  assert.equal(url.includes('&amp;attempt=2'), true);
  assert.equal(url.includes('actionOnEmptyResult="true"'), true);
});

test('every question has three phrasings and the hint map is complete', () => {
  for (const field of ['name', 'date', 'time_slot', 'reason']) {
    assert.equal(E.QUESTIONS[field].length, 3);
    assert.equal(typeof E.questionFor(field, 2), 'string');
  }
  for (const hint of ['past_date', 'closed_day', 'invalid_date', 'too_far', 'out_of_hours', 'invalid_time', 'slot_full', 'already_booked']) {
    assert.equal(typeof E.HINTS[hint], 'string');
  }
});
