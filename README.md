# MediBot Backend (Node + Express + MongoDB)

Twilio voice webhook + REST API for the React dashboard. This is the MERN
migration of the n8n workflow — the whole 4-slot Hindi conversation now runs in
Node instead of n8n.

## Quick start

```bash
npm install
cp .env.example .env        # then fill in MONGODB_URI (and Twilio, optional)
npm start                   # http://localhost:5000
npm test                    # 42 tests, no database needed
```

`server.js` loads `.env`, `doctor.env` and `.env.local`, so the old
"environment variables are undefined on Windows" problem is gone. If the file
was named `doctor.env`, it still works.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/` | health + which endpoints exist |
| GET | `/api/health` | uptime + database state |
| GET | `/webhook/doctor-bot` | Twilio rings → Hindi greeting + first question |
| POST | `/webhook/doctor-bot` | every speech turn (TwiML reply) |
| POST | `/webhook/status` | Twilio status callback → saves abandoned calls |
| GET | `/api/appointments` | list (`?status=&q=&date=&limit=`) |
| GET | `/api/appointments/:id` | one appointment |
| PATCH | `/api/appointments/:id` | `{ "status": "Completed" }` or `Cancelled` |
| GET | `/api/stats` | dashboard counters |

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
