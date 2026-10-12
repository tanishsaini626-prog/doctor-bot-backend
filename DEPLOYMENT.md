# MediBot — Deployment Guide (Phase E)

Target: deploy the **backend** to a free Node host (Render / Railway / Fly) and the
**frontend** to Vercel/Netlify, with a **MongoDB Atlas** free-tier cluster for
persistence. Nothing here requires Twilio credits — the voice flow is tested with
mock calls and simulated webhooks.

> Persistence: the backend now **persists by default without any external setup**.
> If `MONGODB_URI` is unset, it falls back to a **file-backed store** (`STORE=auto`
> → file), writing every change to a JSON file via an atomic temp-write + rename,
> so bookings survive restarts. Use this for local runs and single-instance hosts
> (one VPS / one container). For **shared / multi-instance** production, set up
> Atlas (below) so every replica reads the same data. `STORE=memory` opts out of
> persistence entirely (tests/demos only).

---

## 1. MongoDB Atlas (free M0)

1. Create a free cluster at https://cloud.mongodb.com (M0, 512 MB — enough to start).
2. **Database Access** → add a user with a password (not your Atlas login).
3. **Network Access** → allow `0.0.0.0/0` (required for serverless/free hosts that have
   no fixed IP). Lock this down later if your host offers static egress IPs.
4. **Connect → Drivers** → copy the `mongodb+srv://...` string.
5. Put it in the backend `.env` as `MONGODB_URI` (never commit it — `.env` is gitignored).
6. Keep `STORE=auto` (default): uses Mongo when it connects, otherwise falls back to
   the file-backed store so the server always boots. Use `STORE=mongo` to hard-fail if
   the DB is down.

> **No Atlas yet?** You are not blocked. With `MONGODB_URI` unset, `STORE=auto`
> automatically uses the durable file store at `DATA_FILE` (default
> `.data/store.json`, gitignored). Data survives restarts on a single instance.
> Switch to Atlas when you need a shared database across multiple instances.

Verify: `GET /api/health` should show `"database": true`.

---

## 2. Backend environment variables

Set these in your host's dashboard (never in the repo):

| Variable | Required | Notes |
|---|---|---|
| `MONGODB_URI` | for shared DB | `mongodb+srv://USER:PASS@cluster.../doctorBot`; if unset, the file store is used |
| `JWT_SECRET` | **yes** | long random string, e.g. `openssl rand -base64 48` |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | yes | first dashboard login, created on first boot |
| `PORT` | no | host usually injects it; defaults to 5000 |
| `STORE` | no | `auto` (default) \| `mongo` \| `file` \| `memory` |
| `DATA_FILE` | no | where the file store writes JSON; default `.data/store.json` (only used when not on Mongo) |
| `TWILIO_VALIDATE_SIGNATURE` | **yes before going live** | `true` rejects unsigned webhooks |
| `TWILIO_AUTH_TOKEN` | yes when validating | from the Twilio console |
| `TWILIO_ACCOUNT_SID`, `TWILIO_WHATSAPP_FROM`, `CLINIC_WHATSAPP_TO` | optional | WhatsApp booking alerts |
| `MAX_PER_SLOT` | no | `0` = unlimited per slot, `1` = one patient per slot |
| `CONFIRM_BEFORE_BOOKING` | no | `true` (default) reads the booking back before saving |

Run locally: `cp .env.example .env` then fill in real values. The backend starts with
`npm start` (`node server.js`) and exposes `GET /` and `GET /api/health` for health checks.

---

## 3. Frontend environment variables (build-time)

Vite inlines `VITE_*` vars at build time, so they must be present when you **build**:

| Variable | Notes |
|---|---|
| `VITE_API_URL` | the deployed backend origin, e.g. `https://medibot-api.onrender.com` |

If `VITE_API_URL` is unset the app defaults to `http://localhost:5000` — fine for local
dev, wrong for production. Set it in the Vercel/Netlify project settings before building.

The SPA uses client-side routes (`/login`, `/landing`, dashboard). `vercel.json` ships a
catch-all rewrite to `index.html` so a direct visit or refresh to `/landing` works. On
Netlify add the same via `public/_redirects`: `/*  /index.html  200`.

---

## 4. Deploy order & wiring

1. **Atlas** up and `MONGODB_URI` in hand (step 1).
2. Deploy the **backend**; confirm `GET /api/health` → `ok`.
3. Note the backend's public URL.
4. Deploy the **frontend** with `VITE_API_URL` = that backend URL; open `/landing` and
   submit the demo form → it should `POST /api/leads` and return `201 { ok: true, id }`.
5. Log in to the dashboard at `/login` and confirm leads show under the leads API.

## 5. CORS

The backend currently runs `app.use(cors())` (allow all) so the frontend on a different
origin works out of the box. For production, tighten this to your frontend origin(s).

## 6. Twilio (only when you have credits)

- Point the Twilio phone number's **Voice webhook** at `https://<backend>/webhook/doctor-bot`
  (POST) and the **Status callback** at `https://<backend>/webhook/status`.
- Set `TWILIO_VALIDATE_SIGNATURE=true` and `TWILIO_AUTH_TOKEN`, then confirm a signed
  request is accepted and a forged one is rejected (covered by `test-twilio-signature.js`).
- Until credits are available, exercise the flow with the automated tests and the local
  webhook simulator — do not block deployment on live calls.

## 7. Post-deploy checklist

- [ ] `GET /api/health` → `ok`, `database: true`
- [ ] Restart the backend and confirm data survives (proves Atlas persistence)
- [ ] `/landing` loads on a hard refresh (SPA rewrite working)
- [ ] Demo form → lead appears in the DB
- [ ] Dashboard login works; leads visible
- [ ] `TWILIO_VALIDATE_SIGNATURE=true` and a forged webhook returns 403
- [ ] No secrets committed (`git log` + the repo secret-scan test stay green)
