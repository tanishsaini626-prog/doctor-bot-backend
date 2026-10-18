#!/usr/bin/env node
'use strict';
/* ==========================================================================
 * demo-call.js - a screen-recordable simulated phone call.
 *
 * Boots the real conversation engine over real HTTP (in-memory store) and
 * plays a patient's call turn by turn, printing Twilio-style transcript
 * output with the actual TwiML the server answered.
 *
 *   npm run demo          (backend repo)
 * Perfect B-roll for the demo video: film this terminal while it plays.
 * ========================================================================== */

process.env.PORT = process.env.PORT || '5117';
process.env.STORE = 'memory';
process.env.MONGODB_URI = '';

const app = require('../server.js');
const server = app.listen(process.env.PORT);
const BASE = `http://127.0.0.1:${process.env.PORT}`;

// ---- terminal colours (safe on Windows 10+ terminals) --------------------
const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  blue: (s) => `\x1b[36m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  magenta: (s) => `\x1b[35m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// keep the recording clean: swallow the server's own log lines
const origLog = console.log.bind(console);
console.log = (...args) => {
  const s = args.map(String).join(' ');
  if (/^📞|^🎙|^📴|^🧠|^👤|^⚠|^✅|^=|^MediBot backend|^Storage:|^Signature|^Slot cap|^Twilio webhook|^   Default|^   Fix |^    Fix |^    Copy /.test(s)) return;
  origLog(...args);
};

async function say(callSid, speech, from) {
  const res = await fetch(`${BASE}/webhook/doctor-bot`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ CallSid: callSid, From: from, SpeechResult: speech }).toString(),
  });
  const xml = await res.text();
  // pull the Hindi (or Latin) text out of every <Say> verb; drop the fallback
  // line (it is only spoken when the caller stays silent - not part of the story)
  const said = [...xml.matchAll(/<Say[^>]*>([^<]*)<\/Say>/g)]
    .map((m) => m[1])
    .filter((t) => !/कृपया बाद में कॉल/.test(t))
    .join(' ');
  const gather = /<Gather/.test(xml);
  const ended = xml.includes('<Hangup/>');
  return { said, gather, ended, xml };
}

const SCRIPT = [
  { from: '+919760849372', caller: 'mera naam Priya Sharma hai' },
  { caller: 'kal' },
  { caller: 'subah 10 baje' },
  { caller: 'bukhar aur khansi hai' },
  { caller: 'haan sahi hai' },
];

(async () => {
  await new Promise((r) => setTimeout(r, 900));   // server boot

  console.log('\n' + C.bold('='.repeat(64)));
  console.log(C.bold('  MediBot — simulated live call (real engine, real TwiML)'));
  console.log(C.bold('='.repeat(64)) + '\n');
  console.log(C.dim(`  caller: +91 97608 49372  →  MediBot number\n`));

  const callSid = 'CA-demo-' + Date.now();
  const startCall = await fetch(`${BASE}/webhook/doctor-bot?CallSid=${callSid}&From=${encodeURIComponent('+919760849372')}`).then((r) => r.text());
  const greeting = [...startCall.matchAll(/<Say[^>]*>([^<]*)<\/Say>/g)]
    .map((m) => m[1])
    .filter((t) => !/कृपया बाद में कॉल/.test(t))
    .join(' ');
  console.log(`  ${C.blue('🤖 MediBot:')} ${greeting}`);
  console.log(C.dim('  ────────────────────────────────────────────────────'));

  for (const step of SCRIPT) {
    await wait(1200);
    console.log(`\n  ${C.green('📞 Patient:')} ${step.caller}`);
    console.log(C.dim(`      POST /webhook/doctor-bot  SpeechResult="${step.caller}"`));
    const turn = await say(callSid, step.caller, step.from || '+919760849372');
    await wait(500);
    console.log(`  ${C.blue('🤖 MediBot:')} ${turn.said || C.dim('(silence — waiting for speech)')}`);
    if (turn.ended) {
      console.log('\n  ' + C.magenta('☎  Call completed — appointment saved to the database.') + '\n');
      break;
    }
    console.log(C.dim('  ────────────────────────────────────────────────────'));
  }

  // prove it landed
  const login = await (await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: process.env.ADMIN_EMAIL || 'admin@medibot.local', password: process.env.ADMIN_PASSWORD || 'medibot-admin' }),
  })).json().catch(() => null);

  if (login?.token) {
    const rows = await (await fetch(`${BASE}/api/appointments`, { headers: { Authorization: 'Bearer ' + login.token } })).json();
    const last = rows[0];
    console.log('  ' + C.yellow('📋 Database now contains:'));
    console.log(`     ${C.bold(last?.name)} | ${last?.date} ${last?.time_slot_display || last?.time_slot} | ${last?.reason} | ${last?.status}`);
  }

  console.log('\n' + C.dim('  (This was a real HTTP conversation with the MediBot engine —\n   every reply above is the TwiML Twilio would speak on the phone.)') + '\n');

  server.close();
  process.exit(0);
})().catch((err) => {
  console.error('demo failed:', err);
  process.exit(1);
});
