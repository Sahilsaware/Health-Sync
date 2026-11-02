# HealthSync Edge: Test Cases

## Automated tests

The project uses [Vitest](https://vitest.dev/).

```bash
npm install
npm test        # runs: vitest run
npm run lint    # type check: tsc --noEmit
```

## Manual and API test cases

These cover the main behaviours of the server and the field workflow. "Expected" is what the code is designed to do. Use the live prototype or a local run (`npm run dev`). For API calls, send the session token as `Authorization: Bearer <token>`.

### A. Accounts and verification

| ID | Test | Steps | Expected |
|---|---|---|---|
| TC-01 | ASHA registers with valid enrollment code | `POST /api/auth/register` with `role: "ASHA"` and the correct `ashaEnrollmentCode` | `201`. Account is verified and a session is returned. |
| TC-02 | ASHA registers without a code | Register an ASHA with no enrollment code, then `GET /api/records` | Account is created but pending. `GET /api/records` returns `403` (pending verification). |
| TC-03 | ASHA registers with a wrong code | Register an ASHA with a wrong enrollment code | `403` "Invalid Clinic Enrollment Code". |
| TC-04 | DMO registers without authorization | `POST /api/auth/register` with `role: "DMO"` and no code, not logged in as DMO | `403`. The attempt is written to the audit log. |
| TC-05 | DMO approves a pending ASHA | Log in as DMO, `POST /api/auth/asha/:identifier/verify` | ASHA becomes verified and can access records. |
| TC-06 | DMO revokes an ASHA | Same call with `verified: false` | ASHA sessions are revoked and live WebSocket connections are closed. |
| TC-07 | Wrong password | `POST /api/auth/login` with a wrong secret | `401` "Invalid credentials." (same message for unknown users). |
| TC-08 | Login brute force | Send 16 failed logins from one IP within 15 minutes | `429` with a `Retry-After` header. |

### B. Triage records and permissions

| ID | Test | Steps | Expected |
|---|---|---|---|
| TC-09 | Verified ASHA saves a record | `POST /api/records` with a valid record | `201`. Record saved with `dispatchStatus: "Unassigned"` and owned by that ASHA. Audit entry written. |
| TC-10 | Invalid patient name | Send an empty name, or a name longer than 100 characters | `400` "Valid patientName (1-100 chars) is required." |
| TC-11 | Invalid village code | Send a village code that is not allowed | `400` "Invalid clinic villageCode". |
| TC-12 | Minor without consent | Save a record with age under 18 and no guardian consent | Rejected with a DPDP Section 9 consent error. |
| TC-13 | Edit another worker's record | ASHA B updates a record owned by ASHA A | `403` (object-level authorization). |
| TC-14 | ASHA tries to dispatch | ASHA sends `dispatchStatus: "Dispatched"` on a record | `403` "Only District Medical Officers (DMO) can authorize ambulance dispatch." |
| TC-15 | DMO dispatches ambulance | `PATCH /api/records/:id/dispatch` as DMO with `etaMinutes: 500` | `200`. Status becomes `Dispatched`. ETA is capped at 180. |
| TC-16 | Dispatch as ASHA | Same call as an ASHA | `403`. |
| TC-17 | Erase patient data as ASHA | `DELETE /api/records/:id` as ASHA | `403`. |
| TC-18 | Erase patient data as DMO | `DELETE /api/records/:id` as DMO | Record erased and the action is written to the audit log. |
| TC-19 | No token | `GET /api/records` without a token | `401`. |

### C. Real-time updates

| ID | Test | Steps | Expected |
|---|---|---|---|
| TC-20 | DMO sees new case live | Keep the DMO dashboard open. An ASHA saves an emergency record. | A `record:created` event arrives and the case appears in the priority queue. |
| TC-21 | Other ASHA does not see it | Keep a second verified ASHA connected. | The second ASHA does not receive the event. |
| TC-22 | Siren only for emergencies | Save a record with `triggerEmergencySiren: true` and severity below emergency | No siren flag is sent. |

### D. Offline and SMS workflow (field app)

| ID | Test | Steps | Expected |
|---|---|---|---|
| TC-23 | Capture while offline | Turn off network. Record a visit in the PWA. | Visit is saved locally and the app keeps working. |
| TC-24 | Deferred sync | Turn the network back on. | The stored record syncs to the server once, with no duplicate. |
| TC-25 | Installable PWA | Open the app in Chrome on Android. | "Add to Home screen" is offered. App opens full screen. |
| TC-26 | Emergency SMS rate limit | Send 6 emergency SMS from one user within 15 minutes | The 6th is blocked with `429`. |
| TC-27 | SMS recipient allowlist | Set `ALLOWED_SMS_RECIPIENTS` and send to a number not on the list | Request is rejected. |

### E. AI and security

| ID | Test | Steps | Expected |
|---|---|---|---|
| TC-28 | Gemini unavailable | Remove `GEMINI_API_KEY` and request a summary | A built-in fallback summary is returned, labelled as decision support. |
| TC-29 | Gemini rate limit | Request 11 summaries as one user within 15 minutes | The 11th returns `429`. |
| TC-30 | Public health check | `GET /api/health` without a token | Returns only `{ "status": "ok" }`. |
| TC-31 | DMO health check | Same call with a DMO token | Also returns device count, persistence mode and SMS gateway status. |
| TC-32 | Security headers | Inspect response headers | CSP, HSTS, `X-Content-Type-Options: nosniff`, `Referrer-Policy` and `Permissions-Policy` are present. |

## Sample data

Use [../sample-data/fhir-encounter-bundle.json](../sample-data/fhir-encounter-bundle.json) as an example of a visit record in FHIR form. It is synthetic.
