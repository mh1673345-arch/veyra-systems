# Engineer quick start

This private repository hosts Veyra Reception, the Veyra Systems AI receptionist. The current source snapshot is imported onto the existing repository history; earlier local development history is intentionally excluded because it contained a private environment file.

The npm workspace monorepo contains `apps/api` (Express, TypeScript, Prisma/PostgreSQL), `apps/web` (React, Vite), `packages/shared` (shared TypeScript types), and `infra/postgres` (local database operations). Optional integrations include Anthropic, Google Calendar, Stripe, Resend, Meta WhatsApp, Twilio, Deepgram, and ElevenLabs. Application source is preserved from the original project.

## First-time local setup

Use Node.js 22, npm 10+, Docker Desktop with Compose v2, and GitHub access to this private repository. The commands below use PowerShell; run them from the repository root.

```powershell
git clone https://github.com/mh1673345-arch/veyra-systems.git
cd veyra-systems
npm ci
Copy-Item .env.example .env
Copy-Item apps/api/.env.example apps/api/.env
Copy-Item apps/api/.env.test.example apps/api/.env.test
Copy-Item apps/web/.env.example apps/web/.env
```

Examples intentionally contain variable names with empty values, including optional variables shown as comments. Fill in the following locally before continuing:

| File | Required local configuration |
| --- | --- |
| `.env` | Set `VEYRA_PG_PASSWORD` to a new random password and `VEYRA_PG_PORT=5434`. |
| `apps/api/.env` | Set `PORT=4000`, `NODE_ENV=development`, `DATABASE_URL=postgresql://veyra:<URL-encoded-password>@127.0.0.1:5434/veyra_dev?schema=public`, `VEYRA_API_KEY` to a new random local key, and `VEYRA_ENCRYPTION_KEY` to a base64-encoded random 32-byte key. |
| `apps/api/.env.test` | Set `NODE_ENV=test`, `DATABASE_URL` as above but with database `veyra_test`, `VEYRA_API_KEY` to a separate local test key, and `VEYRA_ENCRYPTION_KEY` to a separate base64-encoded random 32-byte key. |
| `apps/web/.env` | Set `VITE_API_BASE_URL=http://localhost:4000` and `VITE_API_KEY` to the same development `VEYRA_API_KEY`. This is a development demo key embedded in the browser; never place a provider credential or production secret in any `VITE_*` variable. |

Use the same Postgres password in both database URLs, percent-encoded in the URL. Remove unused empty active settings where appropriate; leave optional integrations commented out until configured. Do not copy another developer's keys. No vendor credentials are needed for the rule-based and fake-provider development paths. Keep all environment files private and ignored. Never commit database exports or provider credentials.

```powershell
docker compose up -d
docker compose ps  # wait until Postgres is healthy
npm run prisma:generate --workspace=apps/api
npm run build --workspace=packages/shared
npm run prisma:deploy --workspace=apps/api
npm run db:seed --workspace=apps/api  # optional development demo data
npm run dev:api
# In a second terminal, from the repository root:
npm run dev:web
```

Open http://localhost:5173. Development and test databases are separate. The normal validation workflow is:

```powershell
npm run typecheck
npm run test:api
npm run test:web
npm run build
```

API tests reset the local `veyra_test` database and include an isolation check against `veyra_dev`; initialize development migrations first. These commands must never point at a production database. The development seed has documented local-only demo accounts; do not use them in production.

Import validation on 11 October 2026 passed typecheck, the full build, and all 131 web tests. The API run passed 780 of 781 tests: `tests/pilotOperations.test.ts`, “gives operators a Console entry point, and refuses a busy slot without changing anything”, failed at line 423. It requests a successful reschedule to a fixed 9 October 2026 slot, while the HTTP route uses the current clock; that slot is now in the past and returns HTTP 409. This existing date-dependent test was preserved without modifying application code or tests.

## Existing repository description

The original GitHub README is preserved below, and its original commit remains an ancestor of this import:

> # veyra-systems
> AI enterpise model

## Project documentation

The original project documentation follows. Some phase-by-phase descriptions describe earlier milestones; use the quick start above for this published snapshot.

---

# Veyra Reception

Veyra Systems' first AI receptionist product prototype.

This is a standalone project, isolated from every other project in this
workspace. It has its own git repository, package configuration,
dependencies, environment variables, source code, tests, and docs.

## What's here

A full-stack monorepo demonstrating the core receptionist loop end to end:

- A business (the client Veyra answers for) has a description, hours,
  location, contact info, services with prices, FAQs, and booking/escalation
  rules — all configured server-side (see `apps/api/prisma/seed.ts` for a
  worked example, "SmileCare Dental").
- A caller starts a conversation and gets the greeting back.
- The caller sends messages; the AI receptionist answers from the business's
  configured information, recognizes appointment requests and human-escalation
  requests, and never invents pricing, hours, or availability.
- The caller can request an appointment, stored against the conversation.
  Phase 1.1 only *collects* the request — nothing is auto-confirmed.

### AI architecture (Phase 1.1)

```
UI → API → Conversation service → AI Provider → Business Context → Structured response → UI
```

The receptionist "brain" sits behind a small `AiResponder` interface
([`apps/api/src/services/ai/types.ts`](apps/api/src/services/ai/types.ts))
with two implementations:

- **`AnthropicResponder`** ([`apps/api/src/services/ai/anthropicResponder.ts`](apps/api/src/services/ai/anthropicResponder.ts)) —
  calls the Claude API (`@anthropic-ai/sdk`) with a system prompt built from
  the business's configured context, plus a bounded window of prior turns.
  The model is forced to reply via a single tool call
  (`submit_receptionist_reply`) so the response always comes back as
  structured `{ text, intent, appointmentRequested, escalationRequested }`
  instead of free text the frontend would have to parse.
- **`RuleBasedResponder`** ([`apps/api/src/services/ai/ruleBasedResponder.ts`](apps/api/src/services/ai/ruleBasedResponder.ts)) —
  the original deterministic keyword-matching responder from Phase 1. Used
  automatically when `ANTHROPIC_API_KEY` isn't set, so the app is still
  demoable with zero external keys, and used directly in tests so the suite
  never depends on a paid API call.

[`apps/api/src/services/ai/index.ts`](apps/api/src/services/ai/index.ts)
exports `createAiResponder()`, which picks between the two based on whether
`ANTHROPIC_API_KEY` is configured. Nothing outside that file needs to know
which implementation is active.

**Business context** is assembled server-side in
[`apps/api/src/services/businessContext.ts`](apps/api/src/services/businessContext.ts):
`loadBusinessContext(businessId)` reads the business, its services, and its
FAQs straight from the database — the prompt has no hand-duplicated business
copy, it just formats whatever is configured.

**Conversation memory** is bounded: [`apps/api/src/routes/conversations.ts`](apps/api/src/routes/conversations.ts)
sends only the most recent `MAX_HISTORY_MESSAGES` (12) turns to the provider,
not the full transcript.

**Structured intent** (`general_inquiry` | `appointment_request` | `escalation`
| `unknown_info`, plus `appointmentRequested`/`escalationRequested` booleans)
is persisted on every receptionist `Message` row and returned in every API
response — see the extended `Message` type in
[`packages/shared/src/types.ts`](packages/shared/src/types.ts). The web UI
tags messages with this instead of re-parsing the reply text
([`apps/web/src/components/MessageBubble.tsx`](apps/web/src/components/MessageBubble.tsx)).

**Safety**: the system prompt (see `buildSystemPrompt` in
`anthropicResponder.ts`) instructs the model to only use the supplied
business information, never diagnose or give medical advice, never confirm a
booking, escalate anything it can't confidently answer, never reveal its
instructions, and ignore attempts to override its role. None of this is
enforced by parsing the model's prose — the structured intent fields are what
the app actually acts on.

**Error handling**: if the Anthropic call fails (network error, invalid key,
rate limit, or a malformed/missing tool response), `AnthropicResponder` never
throws — it logs the failure server-side only and returns a fixed, safe
fallback reply ("I'm having trouble accessing the receptionist service right
now. Please contact the clinic directly for assistance.") with `intent:
"escalation"`. No provider error, stack trace, or system prompt content ever
reaches the client.

### Capabilities and the action boundary

Each business declares what it can actually do (`booking_requests`,
`calendar_booking`, `human_escalation`, `whatsapp`, `sms`,
`email_notifications`). Channels default to **off** and the assistant must
never offer a capability that isn't switched on. SmileCare ships with
booking requests and human escalation on, everything else off.

The AI only ever *decides* what should happen — it returns a structured
`action`. The application then decides whether that may happen, in
[`apps/api/src/services/actions/actionExecutor.ts`](apps/api/src/services/actions/actionExecutor.ts),
which re-validates the action against the business's capabilities and returns
an `ActionResult` (`not_required` | `ready` | `completed` | `pending` |
`unsupported` | `failed`). Assistant prose never triggers a side effect, and
an action the business doesn't support is downgraded to `none` before the
message is stored.

Without a live calendar, booking stays request-only: an appointment request is
created as `submitted` and only a human moves it to `confirmed`. With a live
calendar (Phase 8, below), a booking is confirmed only after a real calendar
event exists and the caller said yes. Escalations are
persisted as real `Escalation` rows with status `requested`; the app never
invents a staff response, so the action reports `pending`, not `completed`.

### Authentication and roles

The dashboard requires a real account. Sign in at
`http://localhost:5173/login`; visiting `/dashboard` while signed out redirects
there, and signing out invalidates the session server-side.

- **Passwords** are hashed with bcrypt (cost 12) and never logged. Sign-in
  returns one generic message for a wrong password, an unknown email and a
  disabled account, so it can't be used to enumerate users, and repeated
  failures are throttled per email+IP.
- **Sessions** are server-side records keyed by a random token in an httpOnly,
  SameSite=Lax cookie (`secure` in production). Only the token's SHA-256 hash is
  stored. Nothing goes in `localStorage`.
- **Access is per business**, through an explicit `BusinessMembership` with a
  role. A user sees only the businesses they belong to — there is no global
  picker. A business they don't belong to returns `404`, not `403`.
- **Roles** are turned into permissions in one place
  ([`services/auth/permissions.ts`](apps/api/src/services/auth/permissions.ts)),
  and routes ask for a permission rather than comparing roles:

  | Role | Read dashboard | Operational transitions | Members | Manage owners |
  |---|---|---|---|---|
  | OWNER | ✓ | ✓ | ✓ | ✓ |
  | ADMIN | ✓ | ✓ | ✓ | — |
  | OPERATOR | ✓ | ✓ | — | — |
  | VIEWER | ✓ | — | — | — |

- **Audit events** record the authenticated user, so history reads
  "Dev Owner changed submitted → reviewing". Deleting a user nulls the actor
  rather than erasing the history.
- **Owner safety** is enforced server-side: a business always keeps at least one
  owner, only owners grant or change owner access, and nobody can edit their own
  membership.

Development accounts are created by the seed, all with the password from
`VEYRA_DEV_PASSWORD` (default `veyra-dev-password`, local only — the seed
refuses to run in production):

| Email | Role |
|---|---|
| `owner@smilecare.local` | OWNER |
| `operator@smilecare.local` | OPERATOR |
| `viewer@smilecare.local` | VIEWER |

Override with `VEYRA_DEV_OWNER_EMAIL`, `VEYRA_DEV_OPERATOR_EMAIL`,
`VEYRA_DEV_VIEWER_EMAIL` and `VEYRA_DEV_PASSWORD`.

#### Session and CSRF details

- **CSRF**: every unsafe request (POST/PATCH/PUT/DELETE) on an authenticated
  dashboard route must carry an `x-csrf-token` header. The token is minted per
  session, stored on the session row, and sent to the browser in a JS-readable
  `veyra_csrf` cookie; the server compares the header against *that session's*
  token, so a token from another session is rejected. Safe GETs are untouched.
  The web client attaches the header automatically.
- **Rotation**: login always mints a new session token and CSRF secret — a
  pre-authentication cookie can never be promoted. Changing a password revokes
  every session, then issues a fresh one for the browser that made the change.
- **Sign out everywhere**: `POST /api/auth/sessions/revoke-others` ends every
  other session and keeps the caller's. `GET /api/auth/sessions` lists active
  sessions (created / last used / expires) — no device fingerprinting.
- **Pruning**: dead rows are deleted at startup and after each login. Expired
  sessions go immediately; revoked ones are kept 7 days so an unexpected
  sign-out is still diagnosable. Active sessions are never touched.
- **Passwords**: minimum 12 characters, maximum 72 bytes (beyond that bcrypt
  silently truncates), plus a small blocklist and a check against the user's own
  email. No character-class rules — long passphrases and password managers are
  the point.
- **Password reset**: the token mechanism exists and is tested (hash-only
  storage, single use, expiry, superseded by a newer token), but **no route
  exposes it**, because there is no email provider to deliver a token.
- **Rate limiting** sits behind a `RateLimiter` interface with a memory
  implementation. It throttles per email+IP and always expires, so it cannot be
  used to lock someone else out; a shared store (e.g. Redis) is the production
  swap and is deliberately not stubbed in.

#### Expected production cookie configuration

| | development / test | production |
|---|---|---|
| `veyra_session` | httpOnly, SameSite=Lax, Path=/, 12h | same **+ Secure** |
| `veyra_csrf` | readable by JS, SameSite=Lax, Path=/ | same **+ Secure** |

`Secure` follows `NODE_ENV=production`, so production must be served over
HTTPS. Set `VEYRA_WEB_ORIGIN` to the dashboard's exact origin — CORS runs with
credentials, which forbids a wildcard. If the API and web app are served from
different sites in production, `SameSite=Lax` will not send the cookie and the
deployment needs a shared parent domain (or `SameSite=None; Secure`).

The `x-api-key` shared secret still gates the **public reception demo**
endpoints (`/api/businesses`, `/api/conversations`, `/api/.../appointments`).
It is no longer accepted anywhere on the dashboard — presenting it to
`/api/ops/*` returns `401`.

Email invitations are **not** implemented: adding a member requires the user to
already exist, and the API says so rather than pretending to send mail.

### Provider guardrails and observability

Real generative calls are bounded and observable:

- **Timeout** — 8s, with a real `AbortSignal` so a hung call is cancelled, not
  merely abandoned. On timeout the deterministic responder answers instead
  (`provider_timeout`).
- **Retry policy is deliberately conservative.** Only failures that provably
  never reached the model are retried (429, 5xx, connection errors), at most
  twice. A timeout is *not* retried: the outcome is ambiguous after
  transmission, and a second call could produce a different intent and a
  different action. Ambiguity resolves to the deterministic answer with no side
  effect.
- **Cost caps** — output tokens, history turns, per-turn characters and a
  maximum caller message (rejected before paying for a call). Business context
  is capped far above a realistic business, and when a cap *does* bite it is
  logged, because silently truncating grounding is how a model starts inventing
  prices.
- **Prompt version** — `reception_prompt_v1`, recorded in telemetry so a
  behaviour change can be traced to a prompt change.
- **Telemetry** — one structured line per call with responder, model, prompt
  version, duration, attempts, intent, action, confidence and token usage.
  It never contains the system prompt, the caller's message, or the API key;
  there are tests asserting exactly that.

### Durable notification worker

Notifications are delivered by a worker that treats the database as the queue:

- Work is **claimed atomically** with a conditional `UPDATE` that repeats the
  full eligibility check (pending, due, under the attempt limit, lease free or
  expired). On PostgreSQL a concurrent second writer blocks on the row lock,
  re-checks the condition against the committed row and matches zero rows.
- **Every claim has its own random ownership token** (`claimToken`). Every
  later write by that worker — heartbeat, success, retry scheduling, permanent
  failure, release — is `WHERE id = ? AND claimToken = ?`. A worker that has
  lost the claim gets zero rows back, records nothing, and reports
  `lost_ownership` (never "sent"). `claimedBy`/`claimedAt` are for
  observability only.
- **Leases with a heartbeat.** A claim is honoured until `leaseExpiresAt`
  (default 2 minutes, `VEYRA_NOTIFICATION_LEASE_MS`). While a delivery runs, a
  heartbeat renews it every 30 seconds (`VEYRA_NOTIFICATION_HEARTBEAT_MS`, must
  be ≤ half the lease) — one small write per active delivery. Claims waiting
  their turn in a worker's batch are renewed together in one statement. Before
  sending, the worker renews once more as its ownership check, so it never
  starts a send it doesn't own. If a renewal finds the claim gone, the heartbeat
  stops and the provider's `AbortSignal` fires.
- **Dead workers are recovered, live ones are not robbed.** A crashed or hung
  worker stops renewing; only after its lease has genuinely expired can another
  worker reclaim the row. Timers are unref'd, so a dying process simply stops
  renewing.
- Claim fields are cleared on every settled outcome (sent, retry scheduled,
  failed) and on release.
- The fire-and-forget pass after a booking/escalation and
  `npm run notifications:process` use the same leases. (Before Phase 7C they
  delivered without claiming, which could double-send alongside the worker.)
- `nextAttemptAt` and the 5-attempt bound are honoured by the claimer, so
  exhausted or not-yet-due work is never picked up.
- A delivery that throws is caught, the claim is released, and the worker keeps
  running. **Worker failure can never take the API down.**
- It runs in-process today (`VEYRA_DISABLE_WORKER=1` to opt out) and exposes
  `runWorkerPass()`, so moving it to a standalone process is a deployment
  change rather than a rewrite.

### Health and readiness

- `GET /api/health` — liveness. No I/O.
- `GET /api/ready` — readiness. Requires the database; returns 503 if it's
  unreachable. **Anthropic availability deliberately does not gate readiness** —
  Reception stays fully operational on the deterministic responder, so a
  provider outage must not pull an instance out of rotation. Provider
  degradation is reported in the payload instead.

Production startup validation fails loudly on unsafe config (missing
`VEYRA_WEB_ORIGIN`, a non-https origin, a SQLite `DATABASE_URL`, a `…_dev` or
`…_test` database, a missing `VEYRA_API_KEY`) and reports optional integrations
as disabled/unavailable rather than crashing.

### PostgreSQL (Docker, local)

Development and test run on **PostgreSQL 17** in Docker (`docker-compose.yml`).
This is local infrastructure only — production supplies its own
`DATABASE_URL` and must never reuse these credentials.

| | |
|---|---|
| Container | `veyra-postgres` (compose project `veyra-reception`) |
| Image | `postgres:17` |
| Host port | `5434` (`VEYRA_PG_PORT`) — 5432/5433 are used by other projects on this machine |
| Volume | `veyra_pgdata` (named, survives `docker compose down`; only `down -v` deletes it) |
| Databases | `veyra_dev` (via `POSTGRES_DB`), `veyra_test` (via `infra/postgres/init/`) |
| Healthcheck | `pg_isready` over TCP against `veyra_test`, so it can't report healthy during first-run init |
| Password | `VEYRA_PG_PASSWORD` in the repo-root `.env` (gitignored); compose refuses to start without it |

Schema changes go through **checked-in migrations** in
`apps/api/prisma/migrations/` (`npm run prisma:migrate -w apps/api` in
development, `npm run prisma:deploy -w apps/api` anywhere else). The initial
migration `…_init_postgresql` was generated from the schema and applied to
`veyra_dev`; the test reset replays the same migrations into `veyra_test`.

Development data was **re-seeded, not copied** from the old SQLite files: it was
demo data, and a SQLite→Postgres row copy is more risk than it is worth. The
old `apps/api/prisma/dev.db` / `test.db` files are no longer referenced and are
gitignored.

#### Backup and restore

```bash
npm run db:backup                      # veyra_dev -> infra/postgres/backups/*.dump (gitignored)
npm run db:backup -- veyra_test
npm run db:restore -- <file.dump> --into veyra_restore_check          # new scratch DB, touches nothing else
npm run db:restore -- <file.dump> --into veyra_dev --replace --confirm veyra_dev   # destructive
```

- Backups are `pg_dump --format=custom`, run inside the container over its local
  socket (no password on any command line), and are verified with
  `pg_restore --list` before the script reports success.
- Restore **never runs automatically** and has no default target. Restoring over
  an existing database needs `--replace` *and* the name repeated in `--confirm`;
  only local `veyra_*` databases on this container can be targeted.
- Production backups belong to the managed database (point-in-time recovery),
  not to these scripts.

#### Delivery guarantee — stated precisely

**At most one active internal owner per notification**, with provider-level
idempotency where the vendor supports it. This is **not** exactly-once external
delivery, and nothing here claims it is. The remaining at-least-once cases:

- the provider accepts the message and the worker process dies before the
  database records it; after the lease lapses another worker sends again;
- a worker's process freezes mid-send for longer than the whole lease (e.g. a
  long GC pause or a hung host), another worker reclaims and sends, and the
  frozen send then completes. The frozen worker's *finalization* is rejected,
  but its provider call had already left.

For both, every send carries `OutboundMessage.idempotencyKey` =
`veyra-notification:<notificationId>` — identical on every retry and from every
worker, with no recipient or content in it. A vendor adapter with idempotency
keys (`supportsIdempotency: true`) passes it through so the vendor collapses the
repeat. The development console provider implements that behaviour so it can be
tested. Adapters without key support may ignore it.

Lease times come from each worker's clock, so hosts running workers need
synchronised clocks (NTP); skew is tolerated while it stays well below
lease − heartbeat.

#### Worker concurrency on PostgreSQL

```bash
npm run worker:probe -w apps/api                 # 6 worker processes
PROBE_WORKERS=4 npm run worker:probe -w apps/api
```

Spawns separate OS processes — each with its own Prisma client and connections —
against `veyra_test` (refuses any other database), using a 1.5 s lease and 300 ms
heartbeat so expiry happens in seconds on the production code path:

| | Scenario | Checked |
|---|---|---|
| A | fast delivery race (300 rows) | no row claimed or sent twice, attemptCount=1, no lost ownership, claim fields cleared |
| B | each send takes 3× the lease while idle workers keep polling | heartbeats keep every lease; nothing reclaimed; one send each |
| C | a worker holding 5 claims is killed mid-send | nobody reclaims before its leases expire; all 5 reclaimed once after |
| D | an owner's process freezes mid-send past its lease | rescuer reclaims and records it; the frozen owner's finalization is rejected |
| E | retries due / not yet due | due retried on attempt 2; future `nextAttemptAt` untouched |
| F | exhausted retries, expired and live leases | exhausted untouched; expired leases reclaimed; live leases left alone |
| G | rerun over the finished queue | nothing claimed again |

It reports claims, email sends, duplicate sends, duplicate finalizations and
lost-ownership events per worker. `tests/notificationLease.test.ts` covers the
same rules deterministically (injected clock, gated providers) including the
original bug: worker B reclaiming while worker A is still sending.

### Calendar booking (Phase 8)

```
AI / rule engine → requested action → capability + connection check → CalendarService → CalendarProvider
```

- **One entry point.** Routes, the action executor and the Console call
  `services/calendar/service.ts` (CalendarService). Only providers talk to a
  vendor: `GoogleCalendarProvider` (REST over `fetch`, no SDK) and
  `FakeCalendarProvider` (in-memory, for tests and local demos; refused in
  production). A `MicrosoftCalendarProvider` would implement the same
  `CalendarProvider` interface in `services/calendar/types.ts`.
- **Live only when all three are true:** the subscription includes it
  (entitlement), the business's `calendar_booking` capability is on
  (configuration), **and** a healthy connection has a calendar selected. If any
  is false Veyra is booking-request-only. The calendar code never names a plan;
  it asks AccessService (below).
- **Timezone is first-class.** Each business has an IANA `timezone`. Working
  hours, notice, horizon and every caller-facing time are resolved in it (luxon),
  never the server's, browser's or a developer's zone. A local time that does
  not exist (the spring-forward gap) is refused rather than shifted.
- **Booking rules** (`services/calendar/rules.ts`): minimum notice, maximum
  horizon, per-weekday working hours (`BusinessHour`, with a `bookable` flag),
  buffers before/after, slot interval, and per-service `durationMinutes`. A
  service with no duration is never booked live — nothing invents one. A slot
  is bookable only if the rules allow it **and** free/busy says it is free.
- **Structured availability:** `available | unavailable |
  outside_business_hours | too_soon | too_far | calendar_unavailable |
  requires_manual_review`. Alternatives come from the rules, are filtered
  against real free/busy, and are ranked by closeness to the requested time. If
  the calendar cannot be reached, none are offered.
- **The model never supplies facts.** The requested time is parsed from the
  caller's own words in the business zone (`requestedTime.ts`); a "yes" only
  confirms when a slot is actually held; and the sentence the caller reads for
  availability, confirmation or cancellation is written by the application
  (`ActionResult.callerMessage`), not the AI.
- **Two-step confirmation.** "Book me Tuesday at 3" checks availability and, if
  free, *holds* the slot (`awaiting_confirmation`, 30 minutes) and asks. Only
  a "yes" creates the event — after re-checking the slot.
- **One lifecycle, two modes.** `Appointment.mode` is `request` or
  `calendar`. Calendar bookings carry `startTime`/`endTime`/`timezone`,
  `serviceId` and the linkage `calendarProvider`, `externalCalendarId`,
  `externalEventId`, `externalEventStatus` — never matched by event title. An
  availability check creates no row; a reschedule keeps `confirmed` and
  records the move in the audit trail.
- **Idempotent creation.** Each booking gets a stable `bookingKey` (base32hex)
  used as the provider event id; Google rejects a duplicate id with 409, so a
  retry cannot double-book. Before creating, confirmation looks for an event
  already created under the key and adopts it. That is how an ambiguous
  response, or a crash between the provider accepting and Veyra recording, is
  recovered without a second event.
- **Cancel and reschedule go through the provider first.** Cancellation removes
  the external event, then records `cancelled`; if the provider fails, the
  booking stays `confirmed` and the caller is told it was not cancelled.
  Rescheduling verifies the new slot before touching anything and updates the
  event in place, so a failure never leaves the caller with no booking.
  Operators can cancel from the Console; that path also goes through
  CalendarService.
- **Events and notifications:** `booking.confirmed`, `booking.cancelled` and
  `booking.rescheduled` feed the existing event → notification pipeline.

#### Connecting a calendar

- Google OAuth: `POST /api/ops/businesses/:id/calendar/connect` (OWNER/ADMIN,
  CSRF) returns the consent URL; Google redirects to
  `GET /api/calendar/google/callback`. The callback is validated by a
  single-use, 10-minute state whose **hash** is stored, so an unknown, expired
  or replayed state is rejected. The redirect URI comes from
  `GOOGLE_REDIRECT_URI`.
- **Tokens are encrypted at rest** with AES-256-GCM
  (`services/crypto/secretBox.ts`) under `VEYRA_ENCRYPTION_KEY`, never logged,
  never returned to the browser. Disconnecting destroys them. Startup refuses to
  run in production, or with Google configured, without a key.
- Connection management (`calendar:manage`) is OWNER/ADMIN only. OPERATOR and
  VIEWER can see the connection; OPERATOR can still cancel a booking.
- The Console **Business Settings** page shows the capability, connection status
  (connected / needs re-authentication / error / not connected), provider,
  selected calendar, business timezone, booking rules and service durations,
  with Connect / Reconnect / Change calendar / Disconnect for managers. Booking
  detail shows the appointment time in the business zone and the calendar event
  linkage.

**Status of the real Google integration: not verified.** No Google OAuth client
has been configured, so `GoogleCalendarProvider` and the callback's code
exchange have never talked to Google. Everything above is exercised against the
fake provider through the real service. For a local demo of the live flow:

```bash
npm run db:seed -w apps/api
npm run calendar:dev-connect -w apps/api -- "SmileCare Dental"   # FAKE provider, dev only
```

SmileCare is the "Growth" demo (calendar booking on); **Bright Smile Studio** is
the "Starter" demo (request-only).

### Plans, entitlements and access (Phase 9)

One configurable core, no per-customer codebases:

```
Business → Subscription → Plan → Entitlements / Limits → Business configuration → Runtime health
```

| Plan | Promise | Adds |
|---|---|---|
| **Starter** | Answer | AI receptionist, business knowledge, service and pricing answers, booking requests, human handoff, Veyra Console, operator email alerts |
| **Pro** | Act | Live calendar availability, automatic booking, rescheduling, cancellations, advanced integrations (not built yet) |
| **Max** | Speak | Voice reception, inbound and outbound calls, advanced automation (none built yet) |

WhatsApp and SMS are defined entitlements on **no** plan until the channel
strategy is decided. No price is hard-coded: prices come from environment
configuration (see Billing, Phase 11), and the development values are labelled
as examples, not final pricing.

- **One catalog.** `packages/shared/src/plans.ts` defines the plans, every
  entitlement (with whether it is implemented), and the limits. The backend
  enforces from it and the Console's plan comparison renders from the same data
  the API derives from it — one feature matrix, not two.
- **Entitlement vs configuration.** An entitlement answers "has this business
  paid for it?"; a capability flag or a calendar connection answers "has it set
  it up?". `AccessService` (`services/access/accessService.ts`) is the only
  place that combines them: `hasEntitlement`, `requireEntitlement`,
  `effectiveCapabilities`, `getPlanLimits`, `assertWithinLimit`. The AI
  context, the action executor, booking requests, email eligibility and the
  calendar all read *effective* capabilities, so a stray capability flag can
  never grant what the plan does not include. Nothing compares plan codes.
- **Server-side enforcement** with a stable error:
  `{ "error": "...", "code": "ENTITLEMENT_REQUIRED", "entitlement": "calendar_booking", "requiredPlan": "PRO" }`
  (403). Calendar connect, calendar listing and selection, live availability,
  booking, rescheduling and cancellation are each gated on their own
  entitlement. Disconnecting is deliberately never gated, so a downgraded
  business can always remove stored credentials.
- **Callers never see plans.** When a feature isn't included, the action is
  refused with an operator-facing reason only and Reception falls back to its
  normal request-only reply. No "upgrade" message ever reaches a caller.
- **Subscription status policy:**

  | Status | Access |
  |---|---|
  | `trialing`, `active` | the plan's entitlements |
  | `past_due` | the plan's entitlements, flagged for billing attention — Reception is not cut off over a late payment |
  | `cancelled`, `expired`, or no subscription | core only (Starter's Answer set): callers are still answered and booking requests still collected; paid automation is off |

- **Limits** are `{ kind: "count", value }` or `{ kind: "unlimited" }`, never
  an implied infinity. Values are development defaults, not pricing promises.
  - `team_members` is **enforced**: adding a member past the limit returns
    `PLAN_LIMIT_REACHED` (403) with the plan that allows more. It is checked
    after every RBAC/owner-safety check, so it cannot weaken them.
  - `monthly_conversations` and `calendar_connections` are **tracked**: real
    counts are shown, not enforced (callers are never cut off mid-month).
  - `business_locations` and `monthly_voice_minutes` are **planned**: no
    counter exists, so usage shows as unknown rather than a fake zero.
- **No HTTP route sets a plan.** A plan changes in exactly two ways: a verified
  billing webhook (Phase 11) or the admin script — never a request from a
  Console member, whatever their role:

  ```bash
  npm run subscription:set -w apps/api -- "SmileCare Dental" PRO
  npm run subscription:set -w apps/api -- "SmileCare Dental" STARTER active --actor owner@smilecare.local
  ```

  Script changes are effective immediately and audited in `SubscriptionEvent`
  (previous/new plan and status, actor, timestamp — never billing payloads).
  New businesses start on Starter; the migration gave every existing business an
  audited Starter subscription.
- **Downgrade never damages appointments.** Pro → Starter keeps confirmed
  bookings and their calendar events, and keeps the calendar connection and its
  encrypted tokens stored — just not usable. New live booking stops and
  Reception resumes request-only. A slot held before the downgrade cannot be
  confirmed after it. Upgrading again makes the same stored connection live
  without reconnecting.
- **Lapsed-plan cleanup (the one exception).** A *confirmed* booking Veyra
  created in the calendar before a downgrade can still be cancelled by **staff**
  from the Console, using the stored connection, so nobody is left with an
  orphaned event they cannot remove. It is not a Starter entitlement: callers
  cannot cancel, nothing new can be booked or rescheduled, a booking with no
  external event is refused, and the audit note records that the booking was
  made under a previous plan.
- **Console:** Business Settings → **Plan & billing** (OWNER/ADMIN,
  `subscription:read`) shows the plan, status, period, usage, included and
  locked features, and a plan comparison. A feature that is in a plan but not
  built yet is shown as "Included with Max — Coming soon" rather than sold as
  working. The Calendar section shows Google Calendar as a locked Pro feature
  when the plan doesn't include it.

Demo tiers from the seed: **Bright Smile Studio** on Starter, **SmileCare
Dental** on Pro. There is no Max demo business; Max is covered by tests, and its
voice features are shown as included but not built.

### Billing and the paid subscription lifecycle (Phase 11)

```
Console (plan only) → provider-hosted checkout → signed webhook → verified
  → one transaction: Subscription + audit + event id → entitlements follow
```

**A payment provider's verified webhook is the only thing that grants a plan.**
Returning from checkout, a success URL, or anything the browser says changes
nothing.

- **One boundary.** `services/billing/types.ts` defines `BillingProvider`
  (customer, checkout session, customer portal, get/change/cancel/resume
  subscription, `verifyWebhook`) and provider-neutral shapes. No vendor object,
  status string or payload crosses it, and nothing outside `services/billing/`
  knows which provider is configured.
- **Prices live in configuration, never in the client.** The Console sends
  `{ "targetPlan": "PRO" }` and nothing else; the server maps the plan to a
  price id (`VEYRA_BILLING_PRO_PRICE_ID`, …). A price id, amount or plan claim
  in a request body is ignored, and a webhook's plan is derived from the price
  id alone — never from checkout metadata. Provider price ids are never sent to
  the browser.
- **Webhook security:** signature verified over the **raw body** (the webhook
  route is mounted before `express.json()`), timestamp tolerance, constant-time
  compare. Unverified → `400`, nothing recorded. Every event id is persisted in
  `BillingWebhookEvent`; the state change and that row commit in **one
  transaction**, so five duplicate deliveries change Veyra once, and a failure
  rolls everything back and returns `500` for the provider to retry — nothing
  is acknowledged before the transaction commits. An event older than the last
  one applied (`lastBillingEventAt`) is ignored, so a late delivery cannot roll
  newer state back.
- **Status mapping** is explicit: `trialing`→trialing, `active`→active,
  `past_due`/`unpaid`→past_due, `incomplete`→no change (payment unconfirmed),
  `canceled`→back to Starter when Starter is free (otherwise `cancelled`),
  `incomplete_expired`→expired. Access then follows from the Phase 9 status
  policy — `AccessService` was not touched.
- **Upgrade** applies as soon as the webhook confirms it, and a stored calendar
  connection goes live without reconnecting. **Downgrade** is scheduled for the
  end of the period already paid for (`scheduledPlan`, `scheduledChangeAt`) and
  applies when the provider says the period ended. **Cancel** is at period end
  with the date shown, and can be **resumed** while it is still scheduled.
  Every change writes a `SubscriptionEvent` with `actorType: "billing_provider"`,
  the provider's event id in `externalEventRef`, and a short human reason —
  never provider JSON.
- **Nothing is deleted, ever.** After a downgrade the business keeps its users,
  services, FAQs, bookings, calendar connection and audit history. Members over
  the new limit stay; the Console warns and adding more is refused with
  `PLAN_LIMIT_REACHED`.
- **Past due keeps answering.** Service continues and the owner sees a warning.
  A caller is never told anything about a business's subscription.
- **Roles:** `billing:manage` (OWNER only) for checkout, plan change, cancel,
  resume and the portal; ADMIN sees billing through `subscription:read` but gets
  `403` on every mutation; OPERATOR/VIEWER get `403`; another business's billing
  is `404`.
- **Trials** are wired but off: no trial is offered unless
  `VEYRA_BILLING_TRIAL_DAYS` is set, and the Console shows nothing about one.

#### Providers

| `VEYRA_BILLING_PROVIDER` | State |
|---|---|
| unset | No billing. The Console shows plans and says plainly that online billing isn't set up — no fake checkout. |
| `fake` | **Development only, refused in production.** An in-memory provider that signs real webhooks so the whole flow can be exercised. No money moves; the Console labels it "Development billing — no real payments". |
| `stripe` | Requires `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET`. **Not verified:** no credentials exist, so the adapter has never made a real (test-mode) call. Signature verification follows Stripe's documented scheme and is unit-tested with a known secret; scheduled downgrades between two paid prices are reported as unsupported and sent to Stripe's portal rather than guessed at. |

**Billing has not been exercised against a real payment provider.** Everything
above is verified against the development provider only.

Exercising the flow locally:

```bash
# apps/api/.env
VEYRA_BILLING_PROVIDER=fake

npm run dev   # Console → Settings → Plan & billing → Upgrade to Pro
```

The fake checkout page has "Simulate successful payment" / "Cancel"; paying
queues signed events that are POSTed to `/api/billing/webhooks/fake` a moment
later, exactly like a provider's delivery. `POST /api/billing/fake/simulate`
(`{ "businessId", "action": "fail_payment" | "recover_payment" | "period_end" }`)
simulates what a provider does on its own, and `POST /api/billing/fake/deliver`
delivers queued events by hand. All of these 404 in production.

### Self-service onboarding (Phase 10)

A new customer goes from nothing to a live Reception without a developer:

```
/signup → create workspace → Setup wizard (10 steps) → readiness → Go live
```

- **Account:** `POST /api/auth/signup` — same password policy as a password
  change, throttled per IP, signs the user in. No email verification yet (no
  email provider exists to send one).
- **Workspace:** `POST /api/workspaces` (signed in + CSRF) creates, in one
  transaction, the business **in draft**, the creator's OWNER membership, a
  Starter subscription, safe booking defaults from the industry template, an
  onboarding record and an audit entry. No services, FAQs or hours are
  invented — a new workspace starts empty. An account can own up to 5
  workspaces.
- **Setup wizard** (Console → Setup, `/dashboard/:id/setup/:step`): business
  details, services, FAQs, working hours, booking, escalation, team,
  integrations, review, go live. Save & continue / Back / Skip optional steps /
  leave and resume. Progress is stored server-side, and a step is only marked
  complete after the server checks its data exists (for example, "services"
  needs an active service or an explicit skip). Required steps can't be
  skipped; "go live" is completed only by activating.
- **Configuration API** (all business-scoped; reads need `settings:read`,
  changes need `settings:write` = OWNER/ADMIN + CSRF): `profile`,
  `services` (create/edit/archive/restore — never deleted, so past bookings
  keep their service), `faqs` (create/edit/disable/enable/reorder),
  `hours` (a weekly schedule with several periods per day, validated for
  inverted and overlapping periods), `booking-settings` (switching live
  calendar on needs the `calendar_booking` entitlement — Starter gets
  `ENTITLEMENT_REQUIRED`), `escalation-settings` (team phone/email, fallback
  message), `reception-settings` (assistant name, greeting, tone, closing
  style — structured choices only; there is no free-form prompt field),
  `readiness`, `reception/activate`, `reception/pause`, `knowledge`.
  Service and FAQ ids are always looked up inside the caller's business, so
  another tenant's id is simply not found.
- **Runtime effect is immediate.** Reception reads the business on every turn —
  active services and FAQs only, hours from the structured schedule, the
  presentation settings — so a price edited in the Console is what the very
  next caller hears. No restart, reseed or rebuild.
- **Readiness** (`services/setup/readiness.ts`): each check is `ready`,
  `warning` or `blocking`. Only a missing name, an invalid timezone or no way
  to reach the business (phone or email) blocks going live. No services, no
  FAQs or no hours are warnings. A plan without live calendar is never a
  problem — booking requests are a complete way to take bookings.
- **Reception status:** `draft` (new self-service workspaces), `active`,
  `paused`. Only OWNER/ADMIN can activate or pause, and activation is refused
  while anything blocks. While draft or paused, Reception runs no AI and no
  actions: it answers with the business's fallback message, or a plain pointer
  to its phone and email, and booking requests are refused. Businesses that
  existed before this phase were backfilled as `active` with onboarding
  complete.
- **Knowledge preview** shows the facts Reception uses — business, hours,
  services, FAQs, booking, escalation, integrations, plan restrictions — never
  the system instructions around them.
- **Industry templates** (`packages/shared/src/setup.ts`: dental, salon,
  clinic, real estate, legal, restaurant, general) only *suggest*: service names
  to start from, questions callers ask (never pre-answered), safe booking
  defaults and an escalation hint. They carry no prices, durations or answers.
- **Team:** existing members and the plan's team limit. There are no invitation
  emails, so a colleague creates their own account first and is then added.
- **Audit:** `ConfigAuditEvent` records workspace creation and every change to
  the profile, services, FAQs, hours, booking, escalation and Reception
  settings, and every activation or pause — actor, entity, change type and the
  **names** of changed fields, never their values.

### Voice — Max = Speak (Phase 13)

Veyra answers the phone with the **same brain** it answers everything else
with. Voice is a channel, not a second product: a call is a Conversation with
audio on both ends.

```
caller audio → transcript → handleReceptionTurn() → reply + action → speech
```

`services/reception/turn.ts` is that shared path. The chat endpoint and the
phone line both call it, so a caller asking a price by phone gets the same
grounded answer, from the same business information, through the same action
boundary, as someone typing. **No pricing, calendar, booking, escalation,
entitlement, audit or metrics logic was duplicated for voice.**

**Voice has not been proven on a real phone call.** There are no telephony,
speech-recognition or speech-synthesis credentials, so everything below is
verified against a development provider that places no calls and produces no
audio. Max grants the entitlement; the phone line still has to be connected
and proven, which is why the Console labels voice features
"Voice setup / rollout required".

- **Provider boundaries.** `VoiceProvider` (telephony), `SpeechToTextProvider`
  and `TextToSpeechProvider` in `services/voice/types.ts`. No vendor object,
  status string or payload crosses them; a call is a sequence of normalised
  `VoiceEvent`s and a reply is a `CallInstruction` (say / transfer / hang up).
- **Four checks before any call**, every time, in this order: the plan includes
  voice; the direction (inbound/outbound) is included; the business switched it
  on and gave a number; a provider is configured and healthy. The first two
  fail with `ENTITLEMENT_REQUIRED`, so Starter and Pro are refused by the
  backend whatever the Console shows. A caller on an unentitled number hears a
  neutral line and never anything about plans.
- **Booking by phone** uses the existing confirmation rules unchanged: Veyra
  checks availability, offers the slot, and books only after an explicit yes. A
  repeated yes is a safe no-op. Rescheduling and cancelling reuse the same
  propose-then-confirm path built in Phase 12.
- **Handoff** transfers the call when a transfer number is configured and the
  provider supports it. When it cannot, the escalation the pipeline already
  created stands and the caller is told the truth — Veyra never claims a
  transfer that did not happen.
- **Call state machine** (`services/voice/callState.ts`) rejects impossible
  moves, so a late or duplicated carrier event cannot resurrect a finished call.
- **Webhooks** are verified over the raw body (mounted before `express.json()`),
  and every event id is claimed before any work — a retry cannot create a second
  call, transcript turn, booking or escalation. A failure releases the claim so
  the provider's retry is processed properly rather than dismissed.
- **Latency** is recorded per turn (responder, action, synthesis, total) and
  summarised as median/p95 on the call. Measured, not promised: there is no
  latency target and none is claimed.
- **Metering** counts completed call minutes into the existing plan-usage
  counters, so `monthly_voice_minutes` is now **enforced** rather than planned.
  Policy when the allowance runs out: **new** calls are refused and a call
  already in progress is never cut off mid-sentence.
- **Privacy.** Phone numbers are personal data: stored because a callback needs
  them, masked in the Console and never logged. Recording is **off** and cannot
  be switched on from the Console. A business can choose `metadata_only`, and
  what was said is replaced with a placeholder when the call ends — intents,
  actions and outcomes survive, so measurement still works without keeping
  anyone's words.
- **Outbound** is deliberately minimal: one operator-initiated call to one
  number, gated on `voice_outbound`. There is no scheduler, no queue and no
  campaign runner — nothing in Veyra can decide by itself to ring somebody.
- **Console.** Business Settings → **Voice** (status, provider, number,
  greeting, language, voice, after-hours behaviour, transcript policy, minutes
  used) and a **Calls** page with per-call transcript, outcome, links to the
  booking/escalation/conversation, and the latency summary. Calls feed the
  existing pilot metrics rather than a separate analytics stack.

#### Streaming voice: what exists, and what is still unproven (Phase 14)

**No real phone call has been made.** There are no Twilio, Deepgram or
ElevenLabs credentials on this machine, so the streaming path below has never
carried a second of real audio. It is written, typechecked and exercised with
in-memory transports; treat every vendor detail as unproven.

The live path, once credentials exist:

```
caller → Twilio → wss /api/voice/media/twilio → Deepgram (streaming STT)
       → handleReceptionTurn()  ← the same pipeline the chat endpoint uses
       → ElevenLabs (streaming TTS) → Twilio → caller
```

- `LiveCall` (`services/voice/liveCall.ts`) is the only voice-specific
  orchestration: it moves audio, decides when the caller has finished, stops
  speaking when interrupted, and records where each turn's time went. What
  Veyra *says* is still decided entirely by the shared Reception pipeline.
- `MediaTransport`, `StreamingSpeechToTextProvider` and
  `StreamingTextToSpeechProvider` keep Twilio's framing, Deepgram's results and
  ElevenLabs' audio chunks out of the domain. Every vendor URL, model and voice
  id is overridable from the environment, so a vendor changing an endpoint does
  not need a code change.
- **Barge-in** is implemented in both halves: the synthesis stream is cancelled
  *and* the carrier is told to drop audio it has already buffered. Without the
  second, a caller who interrupts keeps hearing the old sentence.
- Recognition failure asks the caller to repeat; synthesis failure keeps the
  call alive and records the turn without audio; the carrier dropping the line
  closes recognition. None of these ends a call silently.

**Two Phase 13 defects were found by auditing this path, both of which would
have broken the very first real call:** the Twilio adapter never emitted
`call.incoming`, so no `CallSession` was created and every transcript was
dropped as an unknown call; and the webhook answered Twilio with JSON when it
had no instruction, which makes a carrier play an error message to the caller.
Both are fixed and covered by tests.

##### What a real call needs

| Setting | Purpose |
|---|---|
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | Carrier. A dedicated Veyra **test** number only — never a client's line. |
| `DEEPGRAM_API_KEY` | Streaming recognition. `DEEPGRAM_MODEL`, `DEEPGRAM_ENDPOINTING_MS`, `DEEPGRAM_UTTERANCE_END_MS` tune it. |
| `ELEVENLABS_API_KEY` | Streaming synthesis. `ELEVENLABS_MODEL` and the three `ELEVENLABS_VOICE_*` ids map Veyra's fixed voice profiles. |
| `VEYRA_PUBLIC_API_URL` | The public HTTPS base Twilio calls back on. Also how the media stream URL is built. |

Twilio's number needs exactly two things pointed at Veyra:

```
A CALL COMES IN     → POST  https://<public-host>/api/voice/webhooks/twilio
CALL STATUS CHANGES → POST  https://<public-host>/api/voice/webhooks/twilio
```

The media stream URL is not configured at Twilio: Veyra returns it in TwiML as
`wss://<public-host>/api/voice/media/twilio`.

##### Development tunnel vs production

A tunnel is for acceptance only and must never become the production
configuration. The media bridge refuses to start in production unless
`VEYRA_PUBLIC_API_URL` is an `https://` URL, and production additionally
requires real provider credentials (the development voice, speech and
synthesis stand-ins are all refused outside development), secrets held outside
the repository, and the callback URLs registered at Twilio pointing at that
same host — the signature is computed over the exact URL, so a mismatch fails
verification rather than silently accepting anything.

Only the API port is exposed through a tunnel. The database is never exposed.

#### Providers

| `VEYRA_VOICE_PROVIDER` | State |
|---|---|
| unset | No voice. Max still grants the entitlement; the Console says voice needs setting up. |
| `fake` | **Development only, refused in production.** Signs real webhooks and drives the real pipeline; no call is placed and no audio exists. |
| `twilio` | Requires `TWILIO_ACCOUNT_SID` + `TWILIO_AUTH_TOKEN`. **Not verified:** no credentials exist, so the adapter has never placed or answered a call. Signature verification follows Twilio's documented scheme and is unit-tested against a known secret; everything else is written from the documented API and is unproven. |

Speech recognition and synthesis now have real adapters — Deepgram for
recognition, ElevenLabs for synthesis — but **no credentials, so neither has
ever run**. Without a key, the development stand-ins are used outside
production and nothing is used inside it.

Trying it locally:

```bash
# apps/api/.env
VEYRA_VOICE_PROVIDER=fake
```

Then, on a Max business with voice switched on, Console → **Calls** → *Simulate
a call*: type what a caller would say and read what Veyra says back. The
simulator goes through the same signed webhook route and the same Reception
turn as a carrier would, so a demo cannot show behaviour the phone line would
not.

### Pilot operations and measurement (Phase 12)

Running a pilot means being able to say, afterwards, what actually happened.
This phase makes the existing product measurable, reviewable and recoverable —
it adds no new caller-facing capability.

**What it does not do:** nothing here demonstrates revenue, time saved, booking
conversion improvement, customer satisfaction or missed leads recovered. Those
need real pilot evidence from a real customer. The system reports observed
activity and stops there.

- **Pilot state** is separate from the subscription: `pilotStatus`
  (none → preparing → active → paused → completed), with a label, notes and the
  window it ran for. A Pro business may run no pilot; a pilot may sit on any
  plan. A completed pilot is final.
- **Pilot readiness** is a different question from Reception readiness. That one
  asks "can this business go live?"; this asks "can we put real calls through it
  and explain the result?" — an owner to act on findings, services to answer
  from, somewhere for a handoff to go, a valid subscription, a notification path
  and a working audit trail. Activation is refused while anything blocks. A
  request-only pilot never requires a calendar; a pilot with live booking
  switched on does.
- **Metrics** are derived from records Veyra already holds, in the business's own
  timezone. Two rules: a value that cannot be derived is **"Not available", never
  0**, and a rate only appears once its denominator is explicit and large enough
  to mean anything. Every number carries the definition it was calculated from.
- **Responder outcomes** are stored per reply — which responder answered
  (`anthropic` / `rule_based`), why the primary one was skipped, and what the
  action executor did. Operator-visible only: no prompt, no reasoning, no
  provider payload, and none of it reaches the caller-facing API.
- **Conversation outcomes** are derived at read time from evidence (bookings,
  handoffs, intents), so analytics cannot drift from the records. Where the
  evidence does not support a classification the answer is `undetermined` — never
  a guess. An operator can correct any conversation, and their correction wins.
- **Feedback and issues.** An operator can rate a reply (correct / partially
  correct / incorrect / needed a human) and report that Veyra got something
  wrong. Reporting creates a `PilotIssue` with its own queue
  (open → reviewing → resolved / dismissed). Neither ever edits the conversation:
  the transcript stays exactly as the caller experienced it.
- **Knowledge gaps** record what callers asked that the business never told Veyra.
  Detection is deterministic — the reply must genuinely have failed, and the
  question must match a fixed topic vocabulary or a gap the business's own record
  names (a service with no price). Anything else is counted as "couldn't answer"
  rather than given an invented label. One signal per conversation per topic.
- **Pilot safety controls** (`allowAutoBooking`, `allowAutoReschedule`,
  `allowAutoCancellation`, `allowEscalation`, `allowNotifications`) are brakes
  that sit **below** entitlements. Effective access is
  `plan entitlement AND business configuration AND pilot safety AND integration
  health` — switching a control on can never grant a feature the plan excludes,
  and the Console marks the ones the plan doesn't include anyway.
- **Reports and exports.** Every recommendation in the weekly report is
  arithmetic on a count the report also shows, and carries its evidence ("Parking
  came up in 8 separate conversations with nothing on file"). CSV exports are
  business-scoped and contain counts, outcomes, timestamps and references — no
  message text, credentials or provider details. An unmeasurable metric exports
  as `not_available`, because an empty cell reads as zero in a spreadsheet.
- **Alerts** come from `PILOT_ALERT_DEFAULTS` in `@veyra/shared`, and each one
  quotes the threshold that produced it. They are development defaults, not
  findings.
- **RBAC:** OWNER and ADMIN manage the pilot (`pilot:manage`); OPERATOR sees it,
  reports issues and works the queue (`pilot:read`, `pilot:report`,
  `pilot:triage`); VIEWER reads analytics only. Another business's pilot is 404.

#### Known limitations this phase closed

| Was | Now |
|---|---|
| The public demo opened whichever business was created most recently, so any throwaway workspace silently became the demo. | The server resolves it: `VEYRA_DEMO_BUSINESS_ID` if set, otherwise the **oldest** presentable business (Reception live, at least one service). A new workspace can never take it over. |
| A held slot the caller never confirmed stayed `awaiting_confirmation` for good. | Lapsed holds are released to `expired` — terminal, with a status-history entry saying why. Nothing is deleted, and the slot is free again. Swept lazily whenever holds are read or changed, plus `npm run holds:release -w apps/api`. |
| The rescheduling service had no entry point, and would have moved a booking the moment a caller mentioned a date. | Two steps: Veyra checks the new time, offers it ("2pm Wednesday is available. Would you like me to move your appointment?") and only moves it after an explicit yes. Plus a Console reschedule action. A second yes is a safe no-op, and a slot taken in between leaves the original booking untouched. |

#### Demo mode and reset

```bash
# apps/api/.env
VEYRA_DEMO_BUSINESS_ID=<the business id to demo>

npm run demo:reset -w apps/api
```

The reset clears the demo business's conversations, bookings, handoffs,
notifications, reported issues and knowledge gaps, and leaves its
configuration, members and subscription alone. It refuses to run in
production, against a non-local database, or against any business that is not
the configured demo, and it is deliberately not reachable over HTTP.

### Events, notifications and the work queue

Operational work reaches people instead of waiting to be discovered.

```
AI → validated action → database mutation → domain event → notifications
```

- **Domain events** (`DomainEvent`) are persisted after a mutation succeeds —
  `booking_request.created`, `booking_request.status_changed`,
  `escalation.created`, `escalation.assigned`, `escalation.resolved`. They are
  emitted by the application layer, never by the AI responder, and carry only
  small safe metadata (no transcripts, no secrets).
- **Notifications** (`Notification`) are a separate record per event ×
  recipient × channel (`in_app`, `email`), with `pending | sent | failed`,
  attempt counts and backoff. A unique constraint on
  `(eventId, userId, channel)` makes reprocessing an event idempotent.
- **Work queue** (`/dashboard/:businessId/work-queue`) lists everything still
  waiting on a person — submitted/reviewing bookings and requested/assigned
  escalations, oldest first — derived from the real records, not a table that
  could drift.
- **Recipients**: everyone with access sees an in-app notification. Email needs
  *both* the business capability (`email_notifications`) and the person's own
  preference. Operational roles default to email on; **VIEWER defaults to off**
  and can opt in. Disabled users are never notified.

#### Email delivery is not configured

There is no email vendor in this project, and none is faked:

| Environment | Provider | Behaviour |
|---|---|---|
| development / test | `console` | Captures the message to the server log. Reports itself as `console`, and the notification records "no email was sent". |
| production, no credentials | `unconfigured` | Always fails with a clear reason, so an undelivered email is recorded as `failed` — never as sent. |

Every notification stores `providerName`, so a `sent` row always says what sent
it. Wiring a real vendor means implementing `NotificationProvider` and
returning it from `createEmailProvider()`.

**There is no background worker.** Processing runs opportunistically after an
event is emitted (fire-and-forget, so no request waits on delivery) and on
demand via `npm run notifications:process -w apps/api`. A scheduled job would
call the same `processPendingNotifications()`.

A delivery failure never undoes the business action: the booking or escalation
stays exactly as it was, and only the notification is marked failed. Retries are
bounded (5 attempts with 1/5/15/60-minute backoff), then abandoned.

### Operations dashboard

`/dashboard` is the operator surface for the requests Veyra creates: Overview,
Conversations, Bookings, Escalations and Business Settings. Open
`http://localhost:5173/dashboard`, enter the operator key (the value of
`VEYRA_API_KEY`), and pick a business.

- **Bookings** and **Escalations** are inboxes over the real records, with
  detail views that expose only the transitions the server considers legal.
- **Transitions are validated server-side** in
  [`apps/api/src/services/ops/transitions.ts`](apps/api/src/services/ops/transitions.ts);
  an illegal move is rejected with `422` even if the UI is bypassed.
- Every change writes a `StatusEvent` (from status, to status, timestamp). There
  is no authentication yet, so `actorId` is deliberately `null` rather than a
  fabricated user.
- **The AI cannot move a booking or escalation along.** It may only create a
  request through the validated action system; lifecycle changes are operator-only.
- Every query is scoped by `businessId`, and a record belonging to another
  business returns `404` rather than `403`.
- The conversation viewer shows intent and action but never confidence,
  clarification flags, responder identity, prompts or keys — those stay in logs.

The operator key is a **shared secret, not authentication**: there are no
accounts, roles, or operator identities yet.

## Structure

```
veyra-reception/
├── apps/
│   ├── api/     Express + TypeScript + Prisma (PostgreSQL) REST API
│   │   └── src/services/ai/   AiResponder interface + Anthropic/rule-based implementations
│   └── web/     React + Vite chat demo UI
└── packages/
    └── shared/  Shared TypeScript DTOs used by both apps
```

## Prerequisites

- Node.js >= 18.18 (tested on Node 22)
- npm 10+
- Docker Desktop (WSL 2 backend on Windows) with Docker Compose v2
- Optional: an Anthropic API key for real AI replies — get one at
  https://console.anthropic.com/settings/keys. Without one, the app runs on
  the rule-based mock responder.

## Setup

```bash
npm install
cp .env.example .env                        # set VEYRA_PG_PASSWORD to a long random value
cp apps/api/.env.example apps/api/.env      # put the same password in DATABASE_URL
cp apps/api/.env.test.example apps/api/.env.test   # and here
cp apps/web/.env.example apps/web/.env
docker compose up -d                        # wait for "healthy": docker compose ps
npm run build --workspace=packages/shared
npm run prisma:deploy --workspace=apps/api  # apply checked-in migrations to veyra_dev
npm run db:seed --workspace=apps/api        # optional: seeds "SmileCare Dental" demo data
```

`DATABASE_URL` in `apps/api/.env` points at `veyra_dev` and in
`apps/api/.env.test` at `veyra_test`, both on the local Docker Postgres. All
three `.env` files are gitignored; only the `.example` files are committed.

To enable real AI replies, set `ANTHROPIC_API_KEY` (and optionally
`ANTHROPIC_MODEL`, default `claude-sonnet-5`) in `apps/api/.env`. This key is
read only on the server (`process.env` inside `apps/api`) and is never sent
to, embedded in, or readable by the browser bundle — the web app only talks
to Veyra's own API, never to Anthropic directly.

## Running it

In two terminals:

```bash
npm run dev:api   # http://localhost:4000
npm run dev:web   # http://localhost:5173
```

Open http://localhost:5173, start a call, and chat with the receptionist. If
you ran the seed script, ask it things like "How much is whitening?", "Do you
offer implants?", "When are you open?", or "Can I talk to a real person?".

All `/api/*` routes (except `/api/health`) require an `x-api-key` header
matching `VEYRA_API_KEY` from `apps/api/.env` — this is a placeholder for
real per-business auth, not production-grade security.

## Testing

```bash
npm test              # both apps
npm run test:api      # Express routes + AI services via supertest/vitest, against real PostgreSQL (veyra_test)
npm run test:web      # React components via Testing Library
npm run typecheck     # API src, API tests + scripts (apps/api/tsconfig.test.json), web
```

The test suite never makes a real (paid) call to Anthropic:

- `apps/api/tests/anthropicResponder.test.ts` mocks `@anthropic-ai/sdk`
  entirely (`vi.mock`), so it can assert on the exact system prompt and
  message payload sent, and exercise failure/fallback paths, without any
  network access.
- `apps/api/tests/ruleBasedResponder.test.ts`, `businessContext.test.ts`, and
  the `conversations.test.ts` integration suite exercise the real
  rule-based responder (which is also what the app itself falls back to
  when `ANTHROPIC_API_KEY` is unset), so they need no key either.
- `apps/api/tests/aiFactory.test.ts` covers the "no API key configured"
  behavior directly.

## Database environments

Development and test use **separate PostgreSQL databases** on the same local
container, so running the suite can never wipe the data you've been poking at
by hand:

| Environment | Config | Database | Reset with |
|---|---|---|---|
| development | `apps/api/.env` | `veyra_dev` | `npm run db:reset:dev -w apps/api` (asks first) |
| test | `apps/api/.env.test` | `veyra_test` | `npm run test:reset -w apps/api` (automatic via `pretest`) |
| production | real environment vars | its own Postgres database | n/a — migrations via `prisma migrate deploy` |

How it's enforced, rather than just documented:

- Database URLs are classified by their **parsed database name**
  (`describeDatabaseUrl()`), never by a substring of the whole URL — a password
  or host containing "test" can't change the verdict.
- `apps/api/tests/setup.ts` loads `.env` then `.env.test` **with `override: true`**,
  pinning `DATABASE_URL` to the test database before anything constructs a
  `PrismaClient`.
- `pretest` runs `scripts/reset-test-db.mjs`, which replays the migrations with
  `prisma migrate reset --force` **only** if `DATABASE_URL` is a PostgreSQL
  database whose name ends in `_test` on a loopback host
  (`scripts/testDbTarget.mjs`). `veyra_dev`, production-looking or remote URLs,
  SQLite and unparseable URLs are refused, and the refusal never prints the URL.
- `assertDatabaseEnvironment()` (`src/config/database.ts`) runs at API startup
  and in the test setup, and throws if test runs against anything but a `_test`
  database, if dev or production runs against a `_test` database, or if
  production runs against a `_dev` database or SQLite.
- `apps/api/tests/databaseIsolation.test.ts` proves it: it writes a marker row
  through the suite's client, then connects to `veyra_dev` directly (checking
  `current_database()`) and asserts the row isn't there.
- Test files run one at a time (`fileParallelism: false`): they share one
  database whose notification queue is global, so parallel files interfered
  with each other on PostgreSQL.

Seed the development database with the demo business via
`npm run db:seed -w apps/api`.

## API surface

| Method | Path                                          | Purpose                          |
|--------|-----------------------------------------------|-----------------------------------|
| GET    | `/api/health`                                 | Liveness check, no auth           |
| GET    | `/api/businesses`                             | List businesses                   |
| POST   | `/api/businesses`                             | Create a business (name, hours, location, contact, services, FAQs, ...) |
| GET    | `/api/businesses/:id`                         | Fetch a business                  |
| POST   | `/api/conversations`                          | Start a call, returns greeting    |
| GET    | `/api/conversations/:id`                      | Full transcript, with structured intent per message |
| POST   | `/api/conversations/:id/messages`             | Send a caller message, get an AI reply|
| POST   | `/api/conversations/:conversationId/appointments` | Request an appointment       |
| GET    | `/api/businesses/:businessId/appointments`    | List a business's appointments    |
| GET    | `/api/ops/businesses/:id/calendar`            | Calendar settings (settings:read); never tokens |
| POST   | `/api/ops/businesses/:id/calendar/connect`    | Start Google OAuth (calendar:manage, CSRF) |
| GET    | `/api/calendar/google/callback`               | OAuth callback, validated by single-use state |
| GET    | `/api/ops/businesses/:id/calendar/calendars`  | Calendars on the connection (calendar:manage) |
| POST   | `/api/ops/businesses/:id/calendar/select`     | Choose the calendar (calendar:manage, CSRF) |
| POST   | `/api/ops/businesses/:id/calendar/disconnect` | Disconnect and destroy tokens (calendar:manage, CSRF) |
| GET    | `/api/ops/businesses/:id/subscription`        | Plan, status, usage, locked features, comparison, billing state and available actions (subscription:read) |
| POST   | `/api/ops/businesses/:id/billing/checkout`    | Start checkout for `{targetPlan}` (billing:manage, CSRF); returns the provider's URL |
| POST   | `/api/ops/businesses/:id/billing/change-plan` | Ask the provider to change plan (billing:manage, CSRF); `202`, applied by webhook |
| POST   | `/api/ops/businesses/:id/billing/cancel` \| `.../resume` | Cancel at period end / withdraw it (billing:manage, CSRF) |
| POST   | `/api/ops/businesses/:id/billing/portal`      | Provider-hosted billing portal URL (billing:manage, CSRF) |
| POST   | `/api/billing/webhooks/:provider`             | Provider webhooks: raw body, signature verified, idempotent by event id |
| GET    | `/api/demo/business`                          | Which business the public Reception demo uses, decided server-side |
| GET    | `/api/ops/businesses/:id/pilot`               | Pilot overview: state, readiness, health, alerts, metrics (pilot:read) |
| GET    | `/api/ops/businesses/:id/pilot/series` \| `/knowledge-gaps` \| `/timeline` \| `/report` | Charts, gaps, timeline and the pilot report (pilot:read) |
| GET    | `/api/ops/businesses/:id/pilot/export/:kind`  | CSV export, business-scoped (pilot:read) |
| POST   | `/api/ops/businesses/:id/pilot/status`        | Move the pilot along (pilot:manage, CSRF) |
| PUT    | `/api/ops/businesses/:id/pilot/targets` \| `/safety` | Pilot targets and safety controls (pilot:manage, CSRF) |
| GET/POST/PATCH | `/api/ops/businesses/:id/pilot/issues[/:issueId]` | Issue queue: report (pilot:report), triage (pilot:triage) |
| GET/POST | `/api/ops/businesses/:id/conversations/:id/feedback` | Rate a reply (pilot:report) |
| GET/PUT | `/api/ops/businesses/:id/conversations/:id/outcome` | Derived outcome, and an operator's correction |
| POST   | `/api/ops/businesses/:id/bookings/:id/reschedule` | Move a calendar booking (operations:write, CSRF) |
| POST   | `/api/voice/webhooks/:provider`               | Telephony webhooks: raw body, signature verified, idempotent by event id |
| GET/PUT | `/api/ops/businesses/:id/voice`              | Voice status and configuration (settings:read / settings:write) |
| GET    | `/api/ops/businesses/:id/calls[/:callId]`     | Call history and one call's transcript, links and latency (dashboard:read) |
| POST   | `/api/ops/businesses/:id/calls`               | Place one outbound call (operations:write, CSRF; Max + voice_outbound) |
| POST   | `/api/ops/businesses/:id/voice/simulate/*`    | Development call simulator: call, say, hangup (refused in production) |
| POST   | `/api/auth/signup`                            | Create an account (throttled; signs in) |
| POST   | `/api/workspaces`                             | Create a workspace; caller becomes OWNER (session + CSRF) |
| GET/POST | `/api/ops/businesses/:id/onboarding[/steps/:step]` | Onboarding progress; complete/skip a step (validated server-side) |
| GET/PATCH | `/api/ops/businesses/:id/profile`          | Business profile |
| GET/POST/PATCH | `/api/ops/businesses/:id/services[/:serviceId[/archive\|/restore]]` | Services (archive, never delete) |
| GET/POST/PATCH | `/api/ops/businesses/:id/faqs[/:faqId[/disable\|/enable]]`, `/faqs/reorder` | FAQs |
| GET/PUT | `/api/ops/businesses/:id/hours`              | Weekly schedule, several periods per day |
| GET/PATCH | `/api/ops/businesses/:id/booking-settings` \| `escalation-settings` \| `reception-settings` | Settings |
| GET    | `/api/ops/businesses/:id/readiness` \| `knowledge` | Readiness checks; knowledge preview |
| POST   | `/api/ops/businesses/:id/reception/activate` \| `pause` | Go live / pause (OWNER/ADMIN; activation needs no blocking checks) |

## Not in this phase

No real telephony/voice integration, no WhatsApp/SMS, no verified Google
Calendar connection (the integration exists but has not been exercised against
Google), no verified payment provider (billing is exercised end to end against
the development provider only; the Stripe adapter has never run against
Stripe), **no verified voice**: the voice channel is complete and exercised
against a development provider, but no real phone call has been made through a
real carrier, and there is no speech-recognition or speech-synthesis vendor
behind the interfaces yet. No multi-tenant dashboard, no CRM/analytics, no
RAG/vector database, no multi-agent orchestration, no autonomous browser
agents, no fine-tuning. One LLM call per turn, with server-assembled context —
that's the whole "brain" by design.
