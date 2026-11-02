# HealthSync Edge

**Voice-first, offline-first tele-triage for ASHA workers in rural Maharashtra.**

Built by Team Rebels for *Hack for Social Cause* (VBYLD 2027).
Theme: Healthcare & Wellbeing. State: Maharashtra.

- Live prototype: https://healthsync-edge.vercel.app/
- Architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- Test cases: [docs/TEST_CASES.md](docs/TEST_CASES.md)
- Sample data: [sample-data/](sample-data/)
- License: [MIT](LICENSE)

## The problem

In tribal districts like Gadchiroli and Nandurbar, weak mobile networks and monsoon cut-offs delay emergency calls and referrals. ASHA workers keep records on paper, serious cases reach the district office late, and officers cannot see what is happening in the villages.

## What it does

1. **Field capture.** The ASHA worker records a visit (patient, vitals, symptoms) in a PWA that works without internet.
2. **Offline store.** Records are kept locally on the phone and checked before sending.
3. **Edge check.** Simple on-device screening (for example anemia and cough) runs in the browser. It is decision support only.
4. **SMS signal.** For a serious case, a short bit-packed SMS alert goes out so the district office knows right away, even on a weak network.
5. **District action.** The District Medical Officer (DMO) sees a live priority queue and can dispatch an ambulance.
6. **Deferred sync.** The full record syncs when the network comes back.

Other things the server does: role-based access (ASHA and DMO), ASHA verification, audit log, parent/guardian consent check for minors (DPDP Act, Section 9), DMO-only data erasure, and a stipend (incentive) ledger for field visits.

## Tech stack

| Area | Tools |
|---|---|
| Frontend | React 19, Vite, Tailwind CSS, vite-plugin-pwa (installable PWA) |
| Offline data | IndexedDB in the browser |
| Backend | Node.js, Express, `ws` (WebSockets), Helmet (security headers) |
| Database | SQLite (`better-sqlite3`), optional Turso/LibSQL for serverless deployments |
| Security | AES-256-GCM encryption at rest, session tokens, rate limiting, audit log |
| AI | Google Gemini (`@google/genai`) for a server-side triage summary, with a non-AI fallback |
| SMS | Twilio or Fast2SMS (optional) |
| Standards | FHIR-aligned JSON, ABHA ID fields (ABDM) |
| Tests | Vitest |

## Getting started

### Prerequisites

- A recent Node.js LTS (20 or newer) and npm. Bun also works because `bun.lock` is included.
- A Gemini API key if you want the AI triage summary. The app still runs without it.

### Setup

```bash
git clone https://github.com/harshtiwari88/healthsync-edge.git
cd healthsync-edge
npm install
cp .env.example .env
```

Open `.env` and fill in the values (see the table below). Then:

```bash
npm run dev      # start the dev server (server.ts, serves API + frontend)
```

Open the URL printed in the terminal.

Other commands:

```bash
npm run build    # production build (vite build)
npm start        # run the server
npm run lint     # type check (tsc --noEmit)
npm test         # run the test suite (vitest)
```

### First run

1. Set `ASHA_ENROLLMENT_SECRET` and `DMO_PROVISIONING_SECRET` in `.env` to your own values (at least 12 characters).
2. Register a **DMO** account using the provisioning code.
3. Register an **ASHA** account with the clinic enrollment code. Without the code, the ASHA account stays pending until a DMO approves it.
4. Log in as ASHA, record a visit, and watch it appear on the DMO dashboard.

## Environment variables

Copy `.env.example` to `.env`. Never commit your real `.env`.

| Variable | Required | What it is for |
|---|---|---|
| `GEMINI_API_KEY` | For AI summary | Server-side Gemini triage summary. |
| `APP_URL` | No | URL where the app is hosted. |
| `SQLITE_DB_PATH` | No | SQLite file path. Default `./data/healthsync.sqlite`. |
| `VAULT_ENCRYPTION_KEY` | Yes in production | Master key (32+ characters) for AES-256-GCM encryption of patient data at rest. |
| `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` | Serverless only | Durable remote database so records survive cold starts (for example on Vercel). |
| `DMO_PROVISIONING_SECRET` | Yes | Code needed to create a new DMO account (12+ characters). |
| `ASHA_ENROLLMENT_SECRET` | Yes | Clinic enrollment code that lets an ASHA worker verify at registration (12+ characters). |
| `DMO_EMERGENCY_PHONE` | No | Phone number (E.164) that receives emergency SMS alerts. |
| `ALLOWED_SMS_RECIPIENTS` | No | Comma-separated allowlist of phone numbers for `/api/sms/send`. |
| `SMS_DAILY_GLOBAL_LIMIT` | No | Maximum outbound SMS per UTC day. Default 200. |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` | Optional | Live SMS through Twilio. |
| `FAST2SMS_API_KEY` | Optional | Live SMS through Fast2SMS. |
| `SMS_WEBHOOK_SECRET` | Optional | Shared secret for inbound `/api/sms/webhook` calls. |
| `TRUST_PROXY` | No | Express trust-proxy setting. |
| `SESSION_TTL_MINUTES`, `SESSION_IDLE_TIMEOUT_MINUTES` | No | Session lifetime and idle timeout. |
| `CSP_FRAME_ANCESTORS` | No | Override for the CSP `frame-ancestors` directive. |

## Project structure

```
.
|-- server.ts            Express + WebSocket server, API routes, security middleware
|-- src/
|   |-- server/          Database (db.ts), Gemini service, SMS gateway
|   |-- types/           Shared types (triage records, incentives)
|   `-- ...              React app (PWA)
|-- api/                 API code used by the Vercel deployment
|-- public/              PWA icons and static assets
|-- docs/                Architecture and test cases
|-- sample-data/         Synthetic sample records
`-- vercel.json          Vercel configuration
```

## Sample data

[sample-data/fhir-encounter-bundle.json](sample-data/fhir-encounter-bundle.json) is a synthetic FHIR R4 bundle that shows the kind of record HealthSync Edge produces for one ASHA visit (patient, vitals, and a flagged condition). It contains no real person's data.

## AI usage disclosure

- Most of the code, UI and drafting was built with AI assistance. We estimate about **75%** of the work involved AI. The repository was generated from the Google AI Studio template, and we reviewed and edited the output.
- Inside the product, AI is used for on-device screening (anemia, cough) and for a server-side Gemini summary. Both are **decision support only** and are labelled as such. They do not replace a clinician.
- Clinical validation is required before any field use.

## Limitations

- This is a prototype. A field pilot with ASHA workers and district health officers is the next step.
- On-device screening has not been clinically validated.
- ABDM/ABHA API integration is planned. ABHA ID is captured as a field today.
- The interface is Hindi and English. Marathi is planned.

## License

MIT. See [LICENSE](LICENSE).
