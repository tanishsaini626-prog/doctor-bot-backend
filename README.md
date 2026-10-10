# MediBot Backend (Node + Express + MongoDB)

Twilio voice webhook + REST API for the React dashboard. This is the MERN
migration of the n8n workflow — the whole 4-slot Hindi conversation now runs in
Node instead of n8n.

## Quick start

```bash
npm install
cp .env.example .env        # then fill in MONGODB_URI and JWT_SECRET
npm start                   # http://localhost:5000
npm test                    # 50 unit tests, no database needed
npm run test:live           # 64 checks against a real running server
```

`server.js` loads `.env`, `doctor.env` and `.env.local`, so the old
"environment variables are undefined on Windows" problem is gone. If the file
was named `doctor.env`, it still works.

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/` | – | health + which endpoints exist |
| GET | `/api/health` | – | uptime + database state |
| GET | `/webhook/doctor-bot` | Twilio sig* | Twilio rings → Hindi greeting + first question |
| POST | `/webhook/doctor-bot` | Twilio sig* | every speech turn (TwiML reply) |
| POST | `/webhook/status` | Twilio sig* | Twilio status callback → saves abandoned calls |
| POST | `/api/auth/login` | – | `{ email, password }` → `{ token, user }` |
| GET | `/api/auth/bootstrap` | – | first-run hint: names the admin while the shipped default password is still in use |
| POST | `/api/auth/register` | admin token (after the 1st user) | create clinic_owner / receptionist |
| GET | `/api/me` | JWT | current user |
| GET | `/api/appointments` | JWT | list (`?status=&q=&date=&limit=`) |
| GET | `/api/appointments/:id` | JWT | one appointment |
| PATCH | `/api/appointments/:id` | JWT | `{ "status": "Completed" }` or `Cancelled` |
| GET | `/api/calls` | JWT | call log with full transcripts (`?limit=`) |
| GET | `/api/stats` | JWT | dashboard counters |

\* Twilio signature validation runs when `TWILIO_VALIDATE_SIGNATURE=true`
(recommended once you are on a public URL). Leave it `false` for local curl/ngrok
testing.

## Login

Set `JWT_SECRET` in `.env` (required). On the first boot the server creates one
admin account so you can log in immediately:

```
email:    ADMIN_EMAIL    (default admin@medibot.local)
password: ADMIN_PASSWORD (default medibot-admin)
```

Put **your own** email in `ADMIN_EMAIL` before the first boot and that becomes
the admin account. Already started once? Delete the `users` collection (or drop
the in-memory data by restarting) and it is recreated with the new email.

**Changing the password later:** set `ADMIN_PASSWORD` in `.env` and restart. If
the account still has the shipped default, the server upgrades the hash on boot
(log line: "Admin password updated from ADMIN_PASSWORD"). Once the password is
your own, the `/api/auth/bootstrap` first-run hint disappears from the login page.

After the first user exists, new users can only be created by an admin via
`POST /api/auth/register`, with roles `clinic_owner` or `receptionist`. Tokens
last 12 hours; the dashboard stores one and sends it as
`Authorization: Bearer <token>`.

## Data model (Phase B)

- `appointments` – the bookings (voice-flow internal, created by conversation.js)
- `callsessions` – in-progress call state, keyed by `CallSid`
- `clinics` – one per customer (name, greeting, WhatsApp target, languages)
- `doctors` – belongs to a clinic (specialty, slot length, working hours, holidays)
- `users` – dashboard logins (admin / clinic_owner / receptionist, bcrypt hashes)
- `calllogs` – one per phone call: phone, status, turns[] of { transcript, bot_action, at }

Point your Twilio number's voice webhook at
`https://<your-domain>/webhook/doctor-bot`. Set the number's **status callback**
to `https://<your-domain>/webhook/status` so calls where the patient hangs up
mid-conversation are stored as `Abandoned` instead of being lost.

## What it handles

Same engine as the n8n version (`bot-engine.js`, copied from
`doctor-bot-audio/lib/bot-engine.js` — that repo is the source of truth):

- name / date / time / reason, corrections, 3 rephrasings, give-up after 3
  fruitless turns (saved as `Incomplete`)
- wrong number, "call me later", emergency → 108 advice + `URGENT` row
- impossible dates, past dates, Sundays, out-of-hours times, half-hours
  (`saadhe 4 baje`), phonetic "sam" → Evening
- duplicate booking guard (same phone + date + slot), optional per-slot cap
  (`MAX_PER_SLOT`), abandoned-call rescue via the status callback
- every dynamic value XML-escaped, and the webhook always answers with valid
  TwiML even if the database is down

## Data model

`appointments`: name, phone, date (`24/06/2026`), date_iso, date_speech,
time_slot, time_slot_display, reason, booking_for, status, priority, source,
raw_text, call_sid, timestamps.

Status values: `Confirmed`, `Incomplete`, `Emergency`, `Abandoned`, `Duplicate`,
`Cancelled`, `Completed`.

`callsessions`: the in-progress call state keyed by `CallSid`, so a caller can
pause, correct themselves, or hang up without losing what they already said.

## Notes

- `MAX_PER_SLOT=0` means unlimited. Set it to `1` for one patient per time slot.
- WhatsApp notification to the clinic is optional — set `TWILIO_ACCOUNT_SID`,
  `TWILIO_AUTH_TOKEN` and `CLINIC_WHATSAPP_TO`, otherwise it is skipped.
- Deploy target: Render free tier. Add the same env vars in the Render dashboard.
