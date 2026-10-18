# PayrollHub

PayrollHub is a multi-tenant payroll platform, built for Project 2 from the Project 1 threat model (STRIDE over DFD
levels 0 to 2), the Assignment 4 prioritized threats (15: 4 Critical, 11 High), and the Assignment 5 architecture. It
is implemented with Node.js, SQLite, Next.js 16, and React 19.

**Contents**

1. [Summary of PayrollHub and the system](#1-summary-of-payrollhub-and-the-system)
2. [Prerequisites and versions](#2-prerequisites-and-versions)
3. [Install and run, step by step](#3-install-and-run-step-by-step)
4. [Configuration](#4-configuration)
5. [Walking the full flow](#5-walking-the-full-flow)
6. [Running the tests](#6-running-the-tests)
7. [Threat-to-control mapping](#7-threat-to-control-mapping)
8. [How the build follows Assignment 5](#8-how-the-build-follows-assignment-5)
9. [Design decisions](#9-design-decisions)
10. [Third-party dependencies](#10-third-party-dependencies)
11. [Red-team findings and resolutions](#11-red-team-findings-and-resolutions)
12. [Known limitations](#12-known-limitations)

Longer material is in [`docs/`](docs/): [platform setup and troubleshooting](docs/platform-setup.md),
[operations](docs/operations.md) (key rotation, logs, reverse proxy), [threat-to-control details](docs/threat-controls.md),
[full deviation log](docs/deviations.md), [full design decisions](docs/design-decisions.md),
[developer rules](docs/developer-rules.md), and the [red-team report](docs/red-team.md). How AI was used to build
PayrollHub is documented in the [build session log](docs/ai-usage-session-log.pdf) (PDF): every prompt word for word,
a summary of each reply, and the AI mistakes and scope incidents that were caught.

## 1. Summary of PayrollHub and the system

PayrollHub lets companies (tenants) run payroll. Three roles use it:

- **HR Admin** creates payroll runs, manages employees' pay accounts, and can request a bank-account change for an
  employee (which the employee must confirm).
- **Payroll Approver** reviews a run, approves it with a fresh MFA code, runs it, and sends the payment batch to the bank.
  The person who created a run can never approve it.
- **Employee** signs in through their company's own identity provider (SSO), reads pay statements, and changes their
  bank account, which takes effect only after they confirm it from their email.

The system follows the five Assignment 5 layers:

| Assignment 5 layer | In PayrollHub |
|---|---|
| Client apps (§2.1) | One Next.js/React codebase: HR Admin and Payroll Approver consoles, the Employee portal, sign-in pages |
| Edge security layer (§2.2) | Next.js Proxy (`proxy.ts`, `edge/`): request filtering and a Redis-backed rate limiter, before any route code |
| Next.js application layer (§2.3) | Route handlers through one wrapper (Zod validation, tenant from verified claims only), session and MFA checks in a Data Access Layer |
| Core backend services (§2.4) | Identity & Access, Payroll Approval, Payroll Engine, Bank Account, ACH Disbursement (`services/`), each called with scoped service tokens |
| Data, secrets & partners (§2.5) | SQLite with tenant-filtered views and triggers (in place of PostgreSQL row-level security), a local key store, a redacting log pipeline, and local stand-ins for each tenant's identity provider, employees' email, and the originating bank |

**Demo partners.** A real deployment talks to each tenant's SSO identity provider, employees' real email, and a bank.
Locally these are stand-ins that ship with the project: the stand-in IdP (`/mock-idp/<organization>`), a development
mailbox (`/dev/outbox`), and a stand-in bank (`npm run bank`, HTTPS with mutual TLS). They exist only so the system can
be exercised end to end; a production deployment removes them (RT-10).

**Seed data.** Two tenants, `acme` and `globex`, each with an HR Admin, a Payroll Approver, and three employees with
verified bank accounts. Every password, TOTP secret, and mailbox password is random per install and written to
`.data/dev-credentials.txt` (section 4).

## 2. Prerequisites and versions

| Tool | Version | Notes |
|---|---|---|
| Node.js | 22 LTS (22.12 or later) or 24 LTS | `package.json` declares `"engines": { "node": ">=22.12.0" }`; npm warns (it does not refuse) on an older version, and better-sqlite3 then fails to install. Tested with Node 24.19. |
| npm | 10 or later | Ships with Node.js. Tested with npm 11.17. |
| Docker | Docker Desktop (Windows, macOS) or Docker Engine with Compose v2 (Linux) | Runs Redis 7.4 (`docker-compose.yml`). Without Docker, see [Redis without Docker](docs/platform-setup.md#redis-without-docker). Tested with Docker 29.8, Compose 5.5. |
| A browser | current Chrome, Edge, or Firefox; Safari 16.4 or later | For the browser tests, `npx playwright install chromium` downloads Chromium (step 9 below). |

- **No C/C++ build tools are needed:** better-sqlite3 ships prebuilt binaries for Windows, macOS, and Linux.
- **Supported browsers:** browsers older than Safari 16.4, Firefox 90, or Chrome 76 do not send Fetch Metadata, so
  their form posts are refused (D39). Session cookies are `Secure` with the `__Host-` prefix, which these browsers
  accept on `http://localhost`.
- **Free ports:** 3000 (app), 8443 (stand-in bank), 6379 (Redis); the browser tests also use 3100, 3102, and 8444.
- **One PayrollHub Redis per machine:** `docker-compose.yml` names its container `payrollhub-redis`, so two copies of
  this project share it. Use one copy at a time, and after switching copies run `docker compose up -d --force-recreate`
  ([details](docs/platform-setup.md#only-one-payrollhub-redis-at-a-time)).
- **Windows: use the folder's exact casing.** Windows accepts `cd project` for a folder named `Project`, but Next.js
  then loads React twice and every page fails with "Invalid hook call". Always `cd` into the folder with the casing
  File Explorer shows. More OS notes: [docs/platform-setup.md](docs/platform-setup.md).

## 3. Install and run, step by step

Every command runs in a terminal opened in this folder (the one containing this README and `package.json`). They
work in PowerShell, Command Prompt, Git Bash, and macOS/Linux shells. Start Docker before step 4.

1. **Open a terminal in the project folder** (exact casing on Windows, see above).
2. **Install dependencies:** `npm install` (about a minute). Near the end it reports "9 vulnerabilities (4 moderate,
   5 high)" and suggests `npm audit fix --force` (do not run it), after some deprecation warnings: these are all in development tools that never ship (section 10 explains;
   `npm audit --omit=dev` reports 0).
3. **Create your configuration:** `npm run setup`
   Creates `.env` from `.env.example` and generates this install's secrets: the field-encryption key, the Redis
   password, and a local certificate authority with the bank's and PayrollHub's mTLS certificates (in `.data/pki/`).
   It ends with `Setup complete. Next: docker compose up -d, ...`.
4. **Start Redis:** `docker compose up -d`
   Starts Redis on `127.0.0.1:6379` with the password from `.env`. `docker compose ps` shows it as `healthy` after a
   few seconds.
5. **Create the database and seed data:** `npm run db:reset`
   Creates `.data/payrollhub.db`, applies every migration, loads both tenants, and writes the logins to
   **`.data/dev-credentials.txt`**.
6. **Start the stand-in bank** in a second terminal (same folder): `npm run bank`
   It listens on `https://localhost:8443`. Leave it running.
7. **Start PayrollHub** in a third terminal (same folder): `npm run dev`
   When it prints `Ready` (it shows the address as `http://127.0.0.1:3000`; `localhost` is the same), open
   **http://localhost:3000**. The first load of each page compiles it and takes a few seconds; after the first page,
   the server log shows `startup.redis_connected {"ping":"PONG"}`.
8. **Sign in and walk the flow:** section 5.
9. **Run the tests** (section 6): `npm test`. For the browser tests, once: `npx playwright install chromium` (it prints
   a download progress bar, or nothing if Chromium is already installed), then `npm run test:e2e`.

For a production build instead of step 7: `npm run build`, then `npm run start`. To stop: Ctrl+C in each terminal,
then `docker compose down`. Every server listens on `127.0.0.1` only (RT-02, D44); serving to other machines is
described in [docs/operations.md](docs/operations.md#serving-to-other-machines). If a step fails, see
[Troubleshooting](docs/platform-setup.md#troubleshooting).

## 4. Configuration

### Environment variables

All secrets, key locations, and connection strings come from environment variables in `.env`, validated at startup by
`config/env.ts`, which names any missing or invalid variable (never its value) and refuses to start. `.env.example` is
the template with safe development placeholders; `npm run setup` copies it to `.env` and fills in the generated
values. `.env`, `.data/`, and every database file are gitignored.

| Variable | Purpose |
|---|---|
| `DATABASE_PATH` | SQLite database file (default `.data/payrollhub.db`) |
| `REDIS_PASSWORD` | Password Docker Compose starts Redis with. Generated per install by `npm run setup` (RT-05, D47) |
| `REDIS_URL` | Connection string the app uses for the rate-limit store; must use the same password. Generated with it. The app refuses to start with the password older versions of `.env.example` published |
| `FIELD_ENCRYPTION_KEY` | 32-byte AES-256-GCM key (base64) for bank numbers, TOTP secrets, and ACH file bodies. Generated by `npm run setup` |
| `MOCK_IDP_DIR` | The stand-in IdP's per-tenant signing keys and employee directory (default `.data/mock-idp`, written by `npm run db:reset`) |
| `KEYSTORE_DIR` | The local key store's versioned signing keys (default `.data/keys`) |
| `RATE_LIMIT_PREFIX` | Prefix for rate-limit keys in Redis (default `rl`; tests use a random one per test file) |
| `TRUSTED_CLIENT_IP_HEADER` | **Leave unset locally.** Set only behind a reverse proxy that overwrites this header with the real client address; turns on per-IP limits ([docs/operations.md](docs/operations.md#client-ip-and-per-ip-limits-d26)) |
| `INTERNAL_API_ORIGIN` | Where the application layer calls its own `/api/internal/*` routes (default `http://127.0.0.1:3000`). Must be a loopback address, or the server refuses to start (DV-36). Change it if you run on another port |
| `MOCK_MAIL_DIR` | The stand-in email provider's mailboxes and mailbox passwords (default `.data/mock-mail`) |
| `APP_ORIGIN` | Origin used in links inside emails (default `http://localhost:3000`) |
| `DEV_CREDENTIALS_FILE` | Where `npm run db:reset` writes the test logins (default `.data/dev-credentials.txt`, owner-only) |
| `PKI_DIR` | Local CA, the bank's server certificate, PayrollHub's client certificate, and the pinned bank fingerprint (default `.data/pki`, created by `npm run setup`) |
| `BANK_URL` | Where ACH Disbursement sends signed batches (default `https://localhost:8443`) |
| `BANK_TIMEOUT_MS` | How long to wait for the bank before reporting a timeout (default 10000); a retry resends the same batch |
| `MOCK_BANK_DIR` | The stand-in bank's trusted ACH keys and its ledger of accepted batches (default `.data/mock-bank`) |
| `LOG_DIR` | Where the redacted, append-only log file `.data/logs/payrollhub.log` is written (default `.data/logs`) |
| `TEST_REDIS_URL` | Optional, for `npm test` only: a Redis to use instead of `REDIS_URL` from `.env` |
| `PAYROLLHUB_DIST_DIR` | Set only by `npm run test:e2e`, for its development server's separate build folder (`.data/e2e/next-dev`). Leave unset |

### Database setup

SQLite, through Drizzle ORM over better-sqlite3. The schema is in `data/db/tables.ts`; `migrations/` holds the SQL
migrations `0000` to `0015`, including the hand-written tenant-isolation views and triggers
(`migrations/0001_tenant_isolation.sql`).

| Script | What it does |
|---|---|
| `npm run db:reset` | Deletes the database and the stand-ins' data (IdP keys, mailboxes, the bank's ledger), applies every migration, and seeds. Every run generates new random passwords, TOTP secrets, and mailbox passwords and registers a new ACH public key with the bank. Keeps certificates and logs. |
| `npm run db:migrate` | Applies pending migrations only. |
| `npm run db:seed` | Seeds an empty, migrated database (refuses if the tenants already exist). |
| `npm run db:generate` | Developer use: generates a new migration after editing `data/db/tables.ts`. |

### Seed data and test accounts

| Organization | Role | Accounts |
|---|---|---|
| `acme` (Acme Corporation, 22% withholding) | HR Admin | `admin@acme.test` |
| `acme` | Payroll Approver | `approver@acme.test` |
| `acme` | Employees | `alice@acme.test`, `bob@acme.test`, `carol@acme.test` |
| `globex` (Globex Inc., 20% withholding) | HR Admin | `admin@globex.test` |
| `globex` | Payroll Approver | `approver@globex.test` |
| `globex` | Employees | `dana@globex.test`, `eli@globex.test`, `fay@globex.test` |

- Staff (HR Admins and Payroll Approvers) sign in with a password and a TOTP code (required MFA). Employees have no
  PayrollHub password: they sign in at their organization's stand-in IdP (D22), and the database rejects a password
  for them.
- Each employee has one verified bank account. Routing numbers are publicly listed ABA numbers with valid check
  digits; account numbers are made up (`scripts/lib/seed.ts`). Valid routing numbers for trying a change:
  `091000019`, `122105278`.

### Where the test credentials are written

`npm run db:reset` writes **`.data/dev-credentials.txt`** (gitignored, readable only by you). It holds, one record per
line, tab-separated, with comment lines explaining each section:

- `staff`: organization, email, role, password, TOTP secret, and an `otpauth://` link;
- `employee`: organization, email, and the password at the stand-in IdP;
- `mailbox`: address and password for the development mailbox.

They are random per install and change on every `npm run db:reset` (D40, D44). No password is in the source or this
README.

### TOTP helper

`npm run totp -- admin@acme.test` prints that staff account's current 6-digit code and how many seconds it stays
valid (`npm run -s totp -- admin@acme.test --code-only` prints just the digits). Each code works once: for a second
code (for example the approval step-up right after signing in), wait for the next 30-second window. Instead of the
script you can add the TOTP secret or `otpauth://` link from the credentials file to any authenticator app; after
another `npm run db:reset`, add it again.

### Mailbox access

The development mailbox at **http://localhost:3000/dev/outbox** stands in for each person's own email (D13, D30). It
receives bank-change confirmation links, notices, and staff unlock links. Enter the address (for example
`alice@acme.test`) and that mailbox's password from the `mailbox` lines of the credentials file. There is no list of
mailboxes, and no PayrollHub session (an HR Admin's included) opens one.

### Scripts

| Script | What it does |
|---|---|
| `npm run setup` | Creates `.env` and generates the encryption key, Redis password, and certificates. Never overwrites values you set. |
| `npm run dev` / `npm run build` / `npm run start` | Development server, production build, production server (all on `127.0.0.1:3000`). |
| `npm run bank` | The stand-in bank at `BANK_URL` (mTLS, signed batches only). |
| `npm run totp -- <email> [--code-only]` | A staff account's current TOTP code. |
| `npm run keys:rotate -- <approval-token \| service-token \| ach-batch>` | Rotates a signing key ([docs/operations.md](docs/operations.md#rotating-a-signing-key-l2-18)). |
| `npm test`, `npm run test:e2e`, `npm run traceability`, `npm run docs:check` | Section 6. |
| `npm run lint` | ESLint, including the security rules in [docs/developer-rules.md](docs/developer-rules.md). |

## 5. Walking the full flow

Prerequisites: steps 1 to 7 of section 3 (the bank and `npm run dev` running). Open http://localhost:3000. Logins come
from `.data/dev-credentials.txt`; codes from `npm run totp -- <email>`. Use a second browser profile or a private
window for each additional person, so their sessions stay separate.

1. **HR Admin signs in with MFA.** At `/login`, in the "HR Admins and Payroll Approvers" form: **Organization id**
   `acme`, **Email** `admin@acme.test`, **Password** from the file, then **Continue**. On the next page enter the
   code from `npm run totp -- admin@acme.test` in **Code** and press **Verify**. You land on the HR Admin console
   (`/admin`).
2. **Create a draft run.** On `/admin`, set **Pay date** to a date at least two days ahead and press **Create draft run**.
   The run is listed with a "Runs on" date one day before the pay date (the day-early schedule). The
   Employees table shows each pay account as its last 4 digits only ("ending in 0101").
3. **The Payroll Approver approves with step-up.** In a private window, sign in as `approver@acme.test` the same way;
   you land on `/approver`. Click the **Review** link in the row with your pay date. Enter a fresh code from
   `npm run totp -- approver@acme.test` in **Authenticator code** (wait for the next 30-second window if you just used
   one) and press **Approve**. The single-use approval token stays in the page's memory only (5 minutes).
4. **Run payroll.** Press **Run payroll**. The review shows each employee's gross, withholding, and net pay, the
   account's last 4 digits, totals ($9,416.67 gross, $7,345.00 net for acme), exceptions, and a **Late (D29)** warning
   if the run started after its scheduled date. A failed run says why.
5. **Send to bank** (D33: the approver sends). The batch is built from the pay results, signed, and sent over mTLS to
   the stand-in bank. The button is replaced by "Sent to the bank" with the bank reference. If a send fails or times
   out, the button stays, and pressing it again resends the same signed batch, never a new one. Creating a second run
   for the same pay date is refused: "A payroll run already exists for this pay date" (D43).
6. **An employee reads a pay statement.** In another private window, at `/login`, in the "Employees" form enter
   **Organization id** `acme` and press **Sign in with your organization**. At the stand-in IdP, enter **Email**
   `alice@acme.test` and **Password** (her IdP password from the file), press **Sign in**, then **Continue to PayrollHub**. On the
   portal (`/employee`), click the **View statement** link for the pay date. (Under `npm run dev`, the first load of each page
   compiles it, so a page may show only its heading for a second.)
7. **The employee requests a bank change.** On the portal, enter **Routing number** `091000019` and an **Account
   number** (4 to 17 digits), then press **Request change**. The portal shows the pending change as **unverified**, and
   the HR Admin console shows it as "unverified, waiting for the employee to confirm"; pay still goes to the old account.
8. **Confirm it through the mailbox.** In Alice's window, open http://localhost:3000/dev/outbox, enter **Email
   address** `alice@acme.test` and her **Mailbox password** from the file, and press **Open mailbox**. Open the
   confirmation link in the newest message. The page shows the new account's last 4 digits; press **Confirm new
   account**. The portal now shows the new account. (An HR Admin can also enter a change with **Request bank change**
   on `/admin`; it stays pending until the employee confirms it.)

- If pay data changes after approval, or the computation fails, the run shows as failed and must be approved again.
  If a bank change is confirmed between computing and sending, the run is closed and HR creates a new run for the same
  pay date (D35).
- If a staff sign-in answers "Too many requests" (429) after many failed attempts, use **Locked out after too many
  attempts?** on `/login`: an unlock link goes to that staff member's mailbox (D46). It restores a sign-in budget for the
  browser that opens it; the password and code are still required.

## 6. Running the tests

| Command | What it runs | Needs |
|---|---|---|
| `npm test` | The vitest suite (`tests/`), in two steps. First the threat tests, data-layer tests, and the rest, about 280 tests in 37 files, run in parallel. Then `npm run test:isolated` runs on its own (D55). Each test file gets its own throwaway database, key store, and Redis key prefix, so it never touches `.data/` or your dev data; the ACH tests start their own stand-in bank. | Redis running (`docker compose up -d`) |
| `npm run test:isolated` | Latency comparisons that must not share the machine with other test files, run alone after the parallel step: the L0-01 sign-in timing test (`tests/isolated/`). `npm test` runs it; run it by itself to repeat just that check. | Redis |
| `npm run test:e2e` | Builds, resets a separate database, starts the app (production build) on port 3100, a development server on 3102, and the bank on 8444, and walks the full flow in Chromium (Playwright, `e2e/`), checking headers, CSP, browser storage, Referer, and the back button; it also confirms a bank change under `next dev` (`e2e/dev-mode.spec.ts`). Its data stay under `.data/e2e/`, so your dev data are untouched, and a running `npm run dev` keeps working. It does rebuild `.next`, so restart a running `npm run start` afterwards. Step screenshots are saved in `.data/e2e/screenshots/`. | Redis; `npx playwright install chromium` once; ports 3100, 3102, and 8444 free |
| `npm run traceability` | Checks that each of the 15 threats has tests of its primary control (and of its defense-in-depth controls), that every tag names a real threat, and that every control file listed in `tests/threat-registry.ts` exists. | nothing |
| `npm run docs:check` | Checks that every file path this README and the `docs/` pages mention exists. | nothing |
| `npm run lint`, `npx tsc --noEmit` | ESLint (security rules included) and the type checker. | nothing |

**Harmless warnings:** `npm test` prints a Vite notice about `configLoader` and a `vite:dynamic-import-vars` warning, and
`npm run test:e2e` prints "NO_COLOR env is ignored" lines. Neither affects the results.

**Tests by threat.** Every threat test carries its Assignment 4 threat ID in its title (or its `describe` title):
`[L2-11]` attacks the threat's primary control, `[L2-11 DiD]` a defense-in-depth control (D41).

- `npm test -- L2-11` runs only the vitest tests tagged with that threat (several IDs work: `npm test -- L2-11 L2-12`);
  `npm run test:e2e -- L0-01` does the same for the browser tests.
- `npm run traceability -- --run` runs the tests and prints the results grouped by threat ID (add `--e2e` for the
  browser suite); `--write-readme` regenerates the table in section 7.

**About the rate-limiter tests:** they exercise the real atomic Lua script, so they need a real Redis. They use
`REDIS_URL` from `.env` (or `TEST_REDIS_URL`). If Redis is down they fail with 503s, which is the D20 fail-closed
behavior; only `tests/threats/D20-redis-down.test.ts` is meant to run without Redis.

**On a slow or busy machine:** some tests measure real latency. The sign-in timing comparison runs alone for this
reason (D55). The 330-login burst and the "slow Redis is not Redis down" checks run in the parallel step; there, a
Redis reply later than 1.5 s fails closed by design (D20, D45). If the machine is saturated (for example two test runs
at once), those can fail even though the controls work. Close other heavy programs, or run with fewer parallel test
files: `npm test -- --maxWorkers=2`.

## 7. Threat-to-control mapping

All 15 Assignment 4 threats, generated by `npm run traceability -- --write-readme` from the test tags and
`tests/threat-registry.ts` (do not edit by hand). "Tests" counts every vitest and browser test tagged with the threat;
a test tagged both ways for one threat counts in both figures. What each control does, threat by threat, is in
[docs/threat-controls.md](docs/threat-controls.md).

<!-- traceability:start (generated by npm run traceability -- --write-readme; do not edit) -->
| Threat ID | Threat | Primary control file(s) | Defense-in-depth control file(s) | Test file(s) | Tests |
|---|---|---|---|---|---|
| L1-05 | Credential-stuffing flood on the API Gateway login route | `proxy.ts`, `edge/rate-limiter.ts`, `edge/login-routes.ts`, `edge/route-policy.ts`, `edge/known-devices.ts`, `edge/client-ip.ts`, `edge/unlock.ts`, `services/identity/unlock.ts`, `app/api/auth/unlock/` | `scripts/setup.ts`, `config/env.ts`, `docker-compose.yml` | `tests/threats/D20-redis-down.test.ts`, `tests/threats/D25-known-devices.test.ts`, `tests/threats/L0-01-admin-mfa.test.ts`, `tests/threats/L1-05-credential-stuffing.test.ts`, `tests/threats/L1-05-redis-password.test.ts`, `tests/threats/L1-05-trusted-ip.test.ts`, `tests/threats/L1-05-unlock-link.test.ts` | 31 (27 primary, 4 DiD) |
| L1-14 | Missing row-level predicate lets one tenant read another tenant's rows | `migrations/0001_tenant_isolation.sql`, `data/db/views.ts`, `data/db/tenant-scope.ts`, `data/db/scope-state.ts` | `eslint.config.mjs` | `tests/data/async-interleaving.test.ts`, `tests/data/views-only.test.ts`, `tests/threats/L1-14-cross-tenant-reads.test.ts` | 18 (16 primary, 2 DiD) |
| L2-04 | tenantId path and token mismatch writes a run into another tenant | `application/http/route.ts`, `application/validation/`, `app/api/tenants/[tenantId]/runs/` | `data/db/tenant-scope.ts`, `services/identity/service-tokens.ts` | `tests/data/route-wrapper.test.ts`, `tests/threats/L2-04-route-handlers.test.ts`, `tests/threats/L2-04-tenant-from-scope.test.ts` | 16 (12 primary, 4 DiD) |
| L2-16 | App-code-only tenant isolation writes results to the wrong tenant | `migrations/0001_tenant_isolation.sql`, `migrations/0000_tables.sql` | `eslint.config.mjs` | `tests/data/async-interleaving.test.ts`, `tests/data/views-only.test.ts`, `tests/threats/L2-16-cross-tenant-writes.test.ts` | 16 (14 primary, 2 DiD) |
| L2-01 | Captured approval token replayed to launch an unauthorized payroll run | `services/approval/approval-service.ts`, `services/approval/repository.ts` | `app/api/tenants/[tenantId]/runs/[runId]/approve/route.ts`, `services/identity/step-up.ts`, `app/(console)/approver/approve-run.tsx`, `migrations/0007_approval_immutability.sql`, `services/engine/engine-service.ts`, `edge/security-headers.ts`, `eslint.config.mjs` | `e2e/full-flow.spec.ts`, `tests/data/browser-storage.test.ts`, `tests/data/ui-layer.test.ts`, `tests/threats/D20-redis-down.test.ts`, `tests/threats/L0-01-admin-mfa.test.ts`, `tests/threats/L2-01-approval-tokens.test.ts`, `tests/threats/L2-02-engine-failure.test.ts`, `tests/threats/L2-02-payroll-engine.test.ts` | 29 (7 primary, 22 DiD) |
| L2-02 | Unverified approval-token signature authorizes a run as any admin | `services/engine/engine-service.ts`, `services/approval/approval-service.ts`, `services/engine/run-content.ts` | `app/api/internal/engine/`, `app/api/tenants/[tenantId]/runs/[runId]/start/route.ts`, `application/validation/runs.ts`, `migrations/0009_engine_integrity.sql` | `tests/threats/L2-02-engine-failure.test.ts`, `tests/threats/L2-02-payroll-engine.test.ts` | 16 (13 primary, 4 DiD) |
| L1-19 | Unchecked service-to-service call reaches internal Payroll Engine endpoints | `services/identity/service-tokens.ts`, `data/keys/kms.ts`, `app/api/internal/`, `application/mint-as-bff.ts` | `application/http/route.ts`, `config/env.ts`, `instrumentation-node.ts`, `scripts/lib/seed.ts` | `tests/data/mint-handles.test.ts`, `tests/data/ui-layer.test.ts`, `tests/threats/DV-36-internal-origin.test.ts`, `tests/threats/L1-19-service-tokens.test.ts`, `tests/threats/L2-02-payroll-engine.test.ts`, `tests/threats/L2-16-cross-tenant-writes.test.ts` | 31 (24 primary, 7 DiD) |
| L2-13 | Missing idempotency key double-submits the ACH batch and double-pays | `services/ach/ach-service.ts`, `migrations/0000_tables.sql`, `migrations/0013_ach_integrity.sql`, `migrations/0015_one_live_run_per_pay_date.sql`, `services/engine/engine-service.ts` | `partners/mock-bank/server.ts`, `app/api/tenants/[tenantId]/runs/[runId]/disburse/route.ts` | `tests/threats/L1-22-ach-signing.test.ts`, `tests/threats/L2-13-ach-idempotency.test.ts`, `tests/threats/L2-13-one-run-per-pay-date.test.ts` | 20 (16 primary, 4 DiD) |
| L0-01 | HR Admin account takeover with no MFA | `application/auth/dal.ts`, `services/identity/totp.ts`, `services/identity/login.ts` | `services/identity/sessions.ts`, `services/identity/step-up.ts`, `application/auth/session-cookies.ts`, `application/http/forms.ts`, `proxy.ts`, `edge/security-headers.ts`, `app/(console)/`, `app/(employee)/`, `app/_components/bfcache-guard.tsx`, `partners/mock-mail/mail.ts`, `migrations/0011_bank_change_integrity.sql`, `scripts/lib/seed.ts` | `e2e/full-flow.spec.ts`, `tests/data/route-wrapper.test.ts`, `tests/data/ui-layer.test.ts`, `tests/isolated/L0-01-login-timing.test.ts`, `tests/threats/D25-known-devices.test.ts`, `tests/threats/L0-01-admin-mfa.test.ts`, `tests/threats/L0-01-mfa-known-device.test.ts`, `tests/threats/L0-01-route-groups.test.ts`, `tests/threats/L2-11-bank-changes.test.ts` | 45 (8 primary, 38 DiD) |
| L0-11 | Platform-wide PayrollHub outage on a pay date | `edge/waf.ts`, `edge/route-policy.ts`, `proxy.ts`, `next.config.ts`, `edge/rate-limiter.ts`, `services/identity/service-tokens.ts` | `services/engine/engine-service.ts`, `data/db/tables.ts`, `edge/rate-limiter.ts` | `e2e/full-flow.spec.ts`, `tests/threats/D20-redis-down.test.ts`, `tests/threats/L0-01-route-groups.test.ts`, `tests/threats/L0-11-authenticated-budgets.test.ts`, `tests/threats/L0-11-edge-filtering.test.ts`, `tests/threats/L0-11-route-ceilings.test.ts`, `tests/threats/L0-11-waf-path-rules.test.ts`, `tests/threats/L2-02-payroll-engine.test.ts`, `tests/threats/L2-04-route-handlers.test.ts` | 20 (15 primary, 5 DiD) |
| L2-18 | Approval tokens do not expire or rotate | `services/approval/approval-service.ts`, `data/keys/kms.ts`, `scripts/rotate-key.ts` | `migrations/0007_approval_immutability.sql` | `tests/threats/L2-01-approval-tokens.test.ts`, `tests/threats/L2-02-payroll-engine.test.ts` | 6 (5 primary, 1 DiD) |
| L1-20 | Forged SSO assertion signs in as any employee of a tenant | `services/identity/sso.ts`, `app/api/auth/sso/[tenantId]/callback/route.ts` | `services/identity/repository.ts`, `partners/mock-idp/idp.ts`, `scripts/lib/seed.ts`, `package.json` | `tests/threats/L1-20-seeded-idp-passwords.test.ts`, `tests/threats/L1-20-sso-assertion.test.ts` | 19 (11 primary, 8 DiD) |
| L2-11 | ACH generator pays a bank account whose change was never verified | `services/bank-account/bank-account-service.ts`, `services/bank-account/repository.ts`, `app/api/tenants/[tenantId]/bank-account/`, `app/(employee)/employee/bank-change/`, `partners/mock-mail/mail.ts` | `migrations/0011_bank_change_integrity.sql`, `services/bank-account/validation.ts`, `services/bank-account/notify.ts`, `services/engine/run-content.ts`, `services/ach/ach-service.ts`, `application/http/forms.ts`, `app/(console)/admin/admin-console.tsx`, `eslint.config.mjs` | `e2e/dev-mode.spec.ts`, `e2e/full-flow.spec.ts`, `tests/data/route-wrapper.test.ts`, `tests/data/ui-layer.test.ts`, `tests/threats/L0-01-route-groups.test.ts`, `tests/threats/L2-02-payroll-engine.test.ts`, `tests/threats/L2-11-bank-changes.test.ts`, `tests/threats/L2-11-pending-change-ownership.test.ts`, `tests/threats/L2-13-ach-idempotency.test.ts` | 30 (12 primary, 19 DiD) |
| L2-12 | Generated ACH file in logs exposes bank and routing numbers | `data/log/logger.ts`, `instrumentation.ts`, `instrumentation-node.ts`, `application/http/route.ts` | `services/ach/ach-service.ts`, `services/ach/repository.ts`, `data/crypto/field-encryption.ts` | `tests/data/encryption-at-rest.test.ts`, `tests/threats/L1-19-service-tokens.test.ts`, `tests/threats/L2-11-bank-changes.test.ts`, `tests/threats/L2-12-log-redaction.test.ts`, `tests/threats/L2-13-ach-idempotency.test.ts` | 20 (14 primary, 6 DiD) |
| L1-22 | Unsigned ACH batch altered in transit to redirect funds | `services/ach/ach-service.ts`, `services/ach/nacha.ts`, `data/keys/kms.ts`, `partners/mock-bank/server.ts` | `services/ach/bank-client.ts`, `scripts/lib/pki.ts` | `tests/threats/L1-22-ach-signing.test.ts` | 7 (4 primary, 3 DiD) |
<!-- traceability:end -->

## 8. How the build follows Assignment 5

The folders mirror the Assignment 5 layers and services, and the build went layer by layer, each reviewed before the
next.

| Build layer | Assignment 5 | What was built | Where |
|---|---|---|---|
| 0 Foundation | §1.1, §2.5 | Folder structure per layer and service, environment validation, Redis via Docker Compose, ESLint security rules | `config/`, `docker-compose.yml`, `eslint.config.mjs` |
| 1 Data | §2.5, §3 | The 12 Section 3 tables (plus additions, DV-14), tenant-filtered views and write triggers in place of RLS, the synchronous tenant scope, one repository per service, encrypted bank fields, seed data | `data/db/`, `data/crypto/`, `migrations/`, `services/*/repository.ts`, `scripts/lib/seed.ts` |
| 2 Identity & Access | §2.1, §2.3, §2.4 | Two-step staff sign-in with required TOTP MFA, server-side sessions, the Data Access Layer, approval step-up, the stand-in IdP, SSO assertion validation | `services/identity/`, `application/auth/`, `app/(auth)/`, `app/mock-idp/`, `partners/mock-idp/` |
| 3 Application layer | §2.3, §2.4 | One route wrapper (strict Zod schemas, tenant from verified claims only), scoped service tokens checked against ServiceGrant, `/api/internal/*` routes | `application/http/`, `application/validation/`, `services/identity/service-tokens.ts`, `app/api/internal/` |
| 4 Edge | §2.2 | WAF-style request filtering and the Redis rate limiter in Proxy | `proxy.ts`, `edge/` |
| 5 Payroll Approval | §2.4 | Step-up approval, signed single-use approval tokens, key rotation | `services/approval/`, `data/keys/kms.ts`, `scripts/rotate-key.ts` |
| 6 Payroll Engine | §2.4, §3.2 | Token verification, atomic redemption, gross-to-net, pay results and exceptions | `services/engine/` |
| 7 Bank Account | §2.4, §3.3 | Pending changes, out-of-band confirmation, the development mailbox | `services/bank-account/`, `partners/mock-mail/`, `app/dev/outbox/` |
| 8 ACH and logs | §2.4, §2.5, §3.3 | Idempotent, signed NACHA batches over mTLS to the stand-in bank; the redacting log pipeline | `services/ach/`, `partners/mock-bank/`, `data/log/`, `instrumentation-node.ts` |
| 9 Client apps | §2.1 | HR Admin and Approver consoles, the Employee portal, browser security headers, browser tests | `app/(console)/`, `app/(employee)/`, `edge/security-headers.ts`, `e2e/` |
| 10 Threat tests | §1.2 | Tests tagged by threat ID, the traceability check | `tests/`, `tests/threat-registry.ts`, `scripts/traceability.ts` |
| Turns 13 to 15 | all | Independent red team, fixes with regression tests, clean-install check | section 11 |

### Deviations from Assignment 5

Each was accepted by the author. Full text, including what Assignment 5 said: [docs/deviations.md](docs/deviations.md).

| # | Deviation | Justification |
|---|---|---|
| DV-01 | SQLite (better-sqlite3) through Drizzle ORM, not PostgreSQL | Required stack; the ORM keeps queries parameterized |
| DV-02 | Tenant-filtered views and write triggers keyed on `current_tenant()`, not row-level security | SQLite has no RLS; with no tenant set, views return nothing and writes are refused |
| DV-03 | One repository module per service, not per-service database roles | SQLite has no roles; weakens L1-19 defense in depth (documented) |
| DV-04 | Next.js 16 Proxy (renamed Middleware) pre-filters; the Data Access Layer re-checks every session | Next.js says Proxy must not be the only auth check |
| DV-05 | Custom SQLite sessions, not Auth.js | Auth.js Credentials cannot use database sessions or do TOTP step-up |
| DV-06 | Services are modules in one Next.js app; Engine and ACH also behind `/api/internal/*` with service tokens | One runnable app; L1-19 still testable over HTTP |
| DV-07 | Local versioned key store, not KMS | No KMS locally; services still never see private keys |
| DV-08 | Request filtering in Proxy, route-class ceilings, day-early schedule, not a managed WAF | No managed WAF locally (L0-11 limitation) |
| DV-09 | The atomic `redeemed_at` update is the replay check; no separate replay cache | One durable check cannot disagree with a cache |
| DV-10 | Per-tenant stand-in IdP with signed JWT assertions; `signing_cert` holds a public key | No real IdP locally |
| DV-11 | Local stand-in bank with a CA generated at setup | No real bank locally |
| DV-12 | Development mailbox stands in for the employee's verified email | No mail delivery locally |
| DV-13 | Local append-only log file with redaction at ingest | Ops-only read access cannot be enforced locally |
| DV-14 | Schema additions (password hash, TOTP secret, pay rate, withholding rate, verification codes, encrypted ACH file body) | Needed for login, MFA, pay, out-of-band confirmation, idempotent replay |
| DV-15 | Flat withholding rate; no tax tables or forms | Out of scope for the security evaluation |
| DV-16 | Integer cents, BLOB ciphertext, epoch-ms timestamps, ISO date text, CHECK enums | SQLite has none of Section 3's types |
| DV-17 | `Tenant` read through a filtered view; `tenant_id` is a short slug | Stricter than Section 3; sign-in needs no cross-tenant lookup |
| DV-18 | `ServiceGrant` reachable only inside `withPlatform()` (Identity & Access and scripts) | SQLite has no roles (as DV-03) |
| DV-19 | Extra constraints (staff MFA enrollment, no employee password, day-early schedule, net pay bounds, composite keys) | Database backstop for L0-01, L0-11, §2.1 |
| DV-20 | Employee passwords belong to the stand-in IdP, not `app_user` | Keeps the §2.1 trust boundary |
| DV-21 | Session ids stored as SHA-256; device binding via a separate device cookie | A database leak yields no usable cookies |
| DV-22 | `totp_last_used_step` and unique SSO subject per tenant | Blocks TOTP replay; one user per subject |
| DV-23 | Stand-in IdP served by the same app; the assertion consumer requires a same-origin POST | Covers login CSRF for the local stand-in |
| DV-24 | Step-up also rotates the session id | Same rule as login: the pre-step-up id dies |
| DV-25 | `sso_assertion` table (tenant-scoped) | Single-use SSO assertions |
| DV-26 | One minting handle per caller, enforced by ESLint | Tokens scoped to the calling service; residual in-process risk accepted |
| DV-27 | Per-account, per-tenant, per-session, per-route-class limits; per-IP only behind a trusted reverse proxy | Next.js gives Proxy no unforgeable client IP; what holds on one IP is listed in the full log |
| DV-28 | Rate limiter in Proxy, after Next.js buffers up to 64 KiB of body | No separate gateway locally |
| DV-29 | `service_token_use` table | Single-use tokens for internal money routes |
| DV-30 | Payroll Approval reads runs through the engine repository and changes draft to approved | Section 3.2 shares the run tables; direct module call behind a token |
| DV-31 | Approval token returned to the approver's browser and held in React state | Lets the run start as a separate, auditable step; 5-minute, single-use |
| DV-32 | Triggers freeze approved runs and make approval-token records write-once | Database backstop for approvals |
| DV-33 | Known-device records (D25) in Redis | Same store and lifetime model as the counters |
| DV-34 | Redemption in two steps (ticket, then redeem inside Payroll Engine's transaction) | A token is never redeemed without its results |
| DV-35 | `failure_reason` and `pay_exception` | A clear failed state and reported exceptions |
| DV-36 | "Run payroll" reaches Payroll Engine over HTTP at a loopback-only `INTERNAL_API_ORIGIN` | Engine reachable only via its internal route with a single-use token |
| DV-37 | Bank-change `resolution`, `resolved_by`, integrity triggers, immutable user email | Who confirmed and why; L2-11 backstops |
| DV-38 | Confirming a bank change needs the link **and** the employee's own session | A forwarded or leaked link alone cannot confirm |
| DV-39 | HR Admin bank-change entry is a JSON route, used by the console form | Built in Layer 7 before the consoles |
| DV-40 | AchBatch totals, bank reference, rejection reason, and integrity triggers | L2-13 and L1-22 backstops |
| DV-41 | Build and sign in one transaction; send separately | No stored unsigned batch to protect |
| DV-42 | Bank answers a duplicate batch with 409; an identical duplicate counts as delivered | Safe retry after a lost response |
| DV-43 | Separate full-number reader granted to ACH Disbursement only | Least privilege for full account numbers |
| DV-44 | Cache Components turned off | A nonce CSP needs per-request rendering |
| DV-45 | Pay statements only, no tax forms | No tax data in Section 3 |
| DV-46 | `computed_at` on PayrollRun | Shows the D29 late flag after the fact |
| DV-47 | Confirmation page reads the link token once, then loads the change through a POST | The token appears in no other URL, log line, or history entry |
| DV-48 | Proxy looks up sessions and checks service-token signatures to decide what to count | Budgets keyed on who is calling (RT-03) |
| DV-49 | Redis also holds unlock-link token hashes and unlocked-device hashes | Atomic single-use `GETDEL` (D46) |

## 9. Design decisions

Every decision, in one line; the full text is in [docs/design-decisions.md](docs/design-decisions.md), and the
developer rules that keep them true are in [docs/developer-rules.md](docs/developer-rules.md).

| # | Decision |
|---|---|
| D1 | The app is at the project root, so this README is at the root of the ZIP |
| D2 | Proxy pre-filters sessions; the Data Access Layer re-checks the Session table on every request |
| D3 | Custom SQLite sessions instead of Auth.js |
| D4 | Views for reads and triggers for writes, keyed on `current_tenant()`, deny when no tenant is set |
| D5 | One repository module per service |
| D6 | Services as modules in one app; Engine and ACH also at `/api/internal/*` behind service tokens |
| D7 | Local versioned key store that signs without handing out private keys |
| D8 | Request filtering, route-class limits, and the day-early schedule instead of a managed WAF |
| D9 | Rate-limit counters in Redis (atomic Lua), login throttle in Proxy |
| D10 | The atomic `redeemed_at` update replaces a separate replay cache |
| D11 | Per-tenant stand-in IdP issuing signed JWT assertions |
| D12 | Stand-in bank over mTLS with a local CA |
| D13 | Development mailbox as the out-of-band channel |
| D14 | Local append-only log file |
| D15 | Schema additions; the ACH file body is encrypted at rest |
| D16 | Flat withholding rate per tenant |
| D17 | No caching of tenant or user data (inactive while Cache Components is off) |
| D18 | better-sqlite3 as the driver |
| D19 | Node.js 22 or 24 LTS |
| D20 | Redis down: login and money routes fail closed (503); others continue. Slow is not down (Turn 14) |
| D21 | Dev-only npm audit findings accepted (`npm audit --omit=dev` reports 0) |
| D22 | Employees sign in only through their tenant's stand-in IdP |
| D23 | The `sql` tag only as a `check(...)` expression in `data/db/tables.ts` |
| D24 | Two-step staff sign-in, indistinguishable at step 1, one code attempt per password entry |
| D25 | Two sign-in budgets per account: known devices, and unknown devices with progressive delays |
| D26 | Per-IP limits only behind a reverse proxy that overwrites a client-IP header |
| D27 | Separation of duties: a run's creator can never approve it (service and trigger) |
| D28 | The approval covers the run's content (hash); any change after approval needs a new approval |
| D29 | Late runs proceed, flagged and logged |
| D30 | Each development mailbox opens only with its own random password |
| D31 | Contact email changes are out of scope; a trigger refuses them |
| D32 | Every bank change is pending until the employee confirms a single-use, hash-stored, 60-minute link |
| D33 | The Payroll Approver sends the batch to the bank |
| D34 | ACH key rotation retires keys for signing only; old batches stay verifiable |
| D35 | An account retired between compute and send: the run fails and a new run is created |
| D36 | One signed ACH batch per run, idempotency key from tenant and run, exact bytes signed and re-verified |
| D37 | One redacting logger; `console.*` banned and wrapped |
| D38 | Per-request nonce CSP and the other browser security headers |
| D39 | Cross-site check with Fetch Metadata, falling back to an exact Origin match |
| D40 | Tester credentials in `.data/dev-credentials.txt`; `npm run totp` helper |
| D41 | Threat tags in test titles and the traceability check |
| D42 | Existing controls also counted as defense in depth in the mapping |
| D43 | One live run per tenant and pay date (RT-01) |
| D44 | Random per-install IdP passwords; servers on 127.0.0.1 (RT-02) |
| D45 | Proxy identifies the caller before counting; per-tenant and per-session budgets (RT-03) |
| D46 | Self-service unlock link to the staff member's mailbox (RT-04) |
| D47 | Redis password generated per install; the published one refused (RT-05) |
| D48 | MFA-step known device must match the pending session's account (RT-06) |
| D49 | An HR Admin cannot supersede the employee's own pending change (RT-07) |
| D50 | WAF path rules match what Proxy can see (RT-09) |
| D51 | RT-15 is a known limitation: the unhandled `aborted` error comes from Next.js's Proxy body buffering, outside PayrollHub's code |
| D52 | The bank-change confirmation page reads its link token once (React Strict Mode under `next dev`), and the browser tests also run step 8 against `next dev` |
| D53 | README in the Project 2 order, long material in `docs/`, nothing the README needs outside the project folder |
| D54 | `npm run docs:check` checks every path and link in the README and `docs/`; `npm run submission` builds the ZIP folder |
| D55 | The L0-01 sign-in timing test uses its original sampling again and runs alone, after the parallel tests (reverses the Turn 14 change) |
| D56 | The author's presentation outline and code walkthrough stay out of the ZIP; the build session log ships in `docs/` |

## 10. Third-party dependencies

| Package | Version | Why |
|---|---|---|
| next | 16.4.2 | Required framework: routing, Proxy, route handlers |
| react, react-dom | 19.3.0 | Required UI library |
| better-sqlite3 | 13.0.3 | Required SQLite driver; registers `current_tenant()` for the isolation views and triggers |
| drizzle-orm | 0.45.4 | ORM for consistent query parameterization; the tenant-scoped repository wraps it |
| redis | 6.3.0 | Official Redis client for the shared rate-limit store |
| zod | 4.6.7 | Payload and environment validation (named in Assignment 5) |
| jose | 6.2.12 | Sign and verify approval tokens, service tokens, and SSO assertions with pinned algorithms |
| otplib | 13.5.0 | TOTP for required MFA and approval step-up |
| server-only | 0.0.1 | Build error if server modules are imported into client code |
| drizzle-kit (dev) | 0.31.11 | Generates schema migrations |
| vitest (dev) | 5.0.5 | Threat tests |
| @playwright/test (dev) | 1.63.0 | Browser tests: the full flow, CSP, browser storage, Referer, and the back button can only be proven in a browser |
| tsx (dev) | 4.23.15 | Runs the TypeScript scripts (setup, migrate, seed, reset, bank, totp, traceability) |
| selfsigned (dev) | 5.5.0 | Generates the local CA and mTLS certificates without OpenSSL |
| typescript, @types/node (22), @types/better-sqlite3, @types/react, @types/react-dom (dev) | from create-next-app | Type checking |
| eslint, eslint-config-next (dev) | from create-next-app | Linting, including the project's security rules |
| tailwindcss, @tailwindcss/turbopack (dev) | from create-next-app | UI styling |

`package.json` denies install scripts for better-sqlite3, esbuild, and unrs-resolver (`allowScripts`); none need them.
**npm audit (D21):** `npm audit --omit=dev` reports 0 vulnerabilities. A full `npm audit` reports findings only in
dev tooling (`braces` inside `eslint-config-next`, and the `esbuild` copy inside `drizzle-kit`), which never ship;
the suggested `npm audit fix --force` would downgrade the lint config to Next.js 14, so they are accepted.

## 11. Red-team findings and resolutions

**Turn 13:** five independent reviewer agents, with no access to the build conversation, attacked running installs
and read the code. **Turn 14** fixed the findings the author chose; each fix has a regression test, tagged with its
threat ID, that reproduces the original attack and was shown failing before the fix and passing after. Fresh
independent reviewers then retried RT-01 to RT-05 against running installs. Full report, reproductions, what held up,
and the retest details: [docs/red-team.md](docs/red-team.md).

| ID | Severity | Finding | Decision | Resolution | Regression test |
|---|---|---|---|---|---|
| RT-01 | High | Two runs for one pay date both pay out | Fix | One live run per tenant and pay date (D43) | `tests/threats/L2-13-one-run-per-pay-date.test.ts` |
| RT-02 | High | Fixed, published employee IdP passwords; server on all interfaces | Fix | Random per-install IdP passwords; servers on 127.0.0.1 (D44) | `tests/threats/L1-20-seeded-idp-passwords.test.ts` |
| RT-03 | Medium | Global per-class ceilings spent before authentication; slow Redis tripped the breaker | Fix | Identify before counting; per-tenant and per-session budgets; slow is not down (D45, DV-48) | `tests/threats/L0-11-authenticated-budgets.test.ts` |
| RT-04 | Medium | Targeted lockout on a new device | Fix | Self-service unlock link to the staff member's mailbox (D46) | `tests/threats/L1-05-unlock-link.test.ts` |
| RT-05 | Medium | Shared Redis password from the README | Fix | Generated per install; placeholder refused at startup (D47) | `tests/threats/L1-05-redis-password.test.ts` |
| RT-06 | Low | MFA step: a device known for any account skipped the ceiling | Fix | Known device must match the pending session's account (D48) | `tests/threats/L0-01-mfa-known-device.test.ts` |
| RT-07 | Low | A new request silently superseded the employee's pending change | Fix | An HR Admin request answers 409 instead (D49) | `tests/threats/L2-11-pending-change-ownership.test.ts` |
| RT-08 | Info | One encryption key and CA across installs in one clone | Accept | Confirmed: `npm run setup` generates a fresh key and CA per install (tested) | `tests/threats/L1-05-redis-password.test.ts` |
| RT-09 | Info | WAF `..` / encoded-dot rule never fired; the comment overstated it | Fix | Dead rules removed, comment corrected, encoded control characters added (D50) | `tests/threats/L0-11-waf-path-rules.test.ts` |
| RT-10 | Info | Stand-in IdP and mailbox served by the production build | Accept | Documented as demo partners a production deployment removes (section 1) | none |
| RT-11 | Info | `X-Powered-By: Next.js` header | Fix | `poweredByHeader: false` | `tests/data/ui-layer.test.ts`, `e2e/full-flow.spec.ts` |
| RT-12 | Info | Internal routes skip the origin check | Accept | Token-only routes; no ambient credentials to abuse | none |
| RT-13 | Info | Architecture text says PostgreSQL RLS | Accept | Already DV-01, DV-02 | none |
| RT-14 | Info | Old fixed staff credentials in git history | Accept | The submission ZIP excludes `.git`; the values are dead on any reset install | none |
| RT-15 | Low | *Found in the Turn 14 retest.* Clients that drop connections mid-request surface as process-level `uncaughtException` (`Error: aborted`); the app recovered every time | Known limitation | The error is raised inside Next.js's own request-body handling, not in PayrollHub code; section 12 | none |
| RT-16 | Info | *Found in the Turn 14 retest.* With the placeholder Redis password, `next start` prints "Ready" just before the configuration check exits it | Accept | It never serves a request | none |

**Turn 14 retest (live, against running installs, loopback only):**

| Finding | Result | What was retried |
|---|---|---|
| RT-01 | PASS | A second run for the same pay date: 409; moving another run onto it: 409; two concurrent creates: one 201, one 409; the bank accepted one batch for the date. (The failed-then-new-run path is covered by tests, not by the retest.) |
| RT-02 | PASS | The original script with the old published password: no assertion, no session, every employee route 401. The per-install password works (control). Two resets gave different passwords for all six employees. App and bank listen on 127.0.0.1 only. No credential in the source or README. |
| RT-03 | PASS | 125 unauthenticated money POSTs: all 401, no 429, nothing counted; the other tenant unaffected. 330 concurrent logins: 300 × 303 and 30 × 429, no 503 (was 183 × 503). 130 forged cookies or bearer tokens: all 401. One signed-in session flooding a money route: 429 at request 31, other sessions and tenants unaffected. During an anonymous login flood, signed-in users reached every route. |
| RT-04 | PASS | The new-device lockout can still be triggered (documented), but the unlock link restores the real user's sign-in, and every condition held. |
| RT-05 | PASS | The old password gets `WRONGPASS`; the app exits at startup with it; `npm run setup` generated different passwords for two installs. |

## 12. Known limitations

- **Platform-wide outage (L0-11):** a local app cannot absorb a volumetric flood the way a managed WAF does. The
  controls are request filtering, per-class ceilings, signed-in budgets that anonymous traffic cannot spend (D45), and
  the day-early payroll schedule. Next.js still buffers up to 64 KiB of each request body before Proxy runs.
- **Anonymous ceilings on one IP (DV-27):** a flood of anonymous sign-ins can, for up to a minute at a time, block a
  first sign-in from a new browser that has not been unlocked, employee sign-in at the stand-in IdP, the public pages,
  and unlock requests. Signed-in users, known devices, and unlocked browsers are unaffected. Per-IP limits behind a
  trusted reverse proxy reduce this (D26).
- **Lockout on unknown devices (D25, D46):** an attacker can still slow an account's sign-in from *new* browsers
  until the real user opens an unlock link from their mailbox. Anyone can make an account's owner receive unlock mails
  (at most 3 an hour): noise, not access.
- **Dropped connections are logged as uncaught exceptions (RT-15, Low).** When a client disconnects in the middle of a
  POST, Next.js's request-body buffering for Proxy (`node_modules/next/dist/server/body-streams.js`) replaces the
  request's stream internals, including its error listener, so Node's `aborted` error has no handler and reaches
  `uncaughtException`. Turn 15 confirmed this with a script that runs Next.js's own body-cloning code on a real request: the request has one
  error listener before and none after, and a client disconnect then raises `uncaughtException`; without the cloning
  step it does not. Next.js's own handler logs it and the server keeps running (90 such events in the Turn 14
  retest, all recovered), but under a flood of aborted connections the logs fill and recovery depends on that handler.
  Fixing it means patching Next.js or running a custom server, which is not a small change.
- **Day-early schedule (D29):** a run started after its scheduled date is allowed, flagged `late`, and logged; the
  ACH batch may then settle after the pay date.
- **`INTERNAL_API_ORIGIN` must match the port** the app runs on, or "Run payroll" returns 502. It must also be a
  loopback address, or the server exits at startup.
- **Demo partners (RT-10):** the stand-in IdP, development mailbox, and stand-in bank are served by the same build for
  local testing; a real deployment removes them. The bank's pinned ACH keys are registered by a script, not exchanged
  out of band, and it settles no money.
- **Browsers without Fetch Metadata cannot submit forms** (Safari before 16.4, Firefox before 90, Chrome before 76),
  and non-browser clients calling session or public routes must send an `Origin` header naming the app's origin (D39).
- **Local HTTP:** no HSTS, and the CSP omits `upgrade-insecure-requests`; a deployment behind TLS adds both.
- **No tax forms** in the Employee portal (DV-45).
- **A bank change confirmed between compute and send forces a new run** (D35).
- **A user's contact email cannot be changed** (D31).
- **Logs are a local file** (D14): append-only by code, but anyone with file access can edit or read it. A real
  deployment ships logs to append-only storage with restricted readers.
- **Redaction is pattern-based for free text:** any run of 7 or more digits is masked (timestamps and hash fragments
  too), and an account number shorter than 7 digits in free text is not recognized unless it is in a schema field.
  Code never logs bank details; redaction is the backstop.
- **A confirmation link is a bearer secret in a URL** until used or expired (60 minutes); only its hash is stored,
  `Referrer-Policy: no-referrer` is set, and confirming also needs the employee's own session (DV-38).
- **No hardware key isolation:** private keys are files under `.data/keys`, in the same process as the services; the
  field-encryption key is in `.env` (DV-07).
- **Weaker L1-19 defense in depth** without database roles (DV-03), and the raw database handle could read base
  tables if code bypassed the ESLint rules, type restriction, runtime check, and source-scan test (DV-02); the
  triggers still enforce writes.
- **Single Redis node,** not clustered locally; `npm test` needs it running.
- **Most service tokens are multi-use for 60 seconds;** only tokens for the internal money routes are single-use.
  Others are bound to one caller, endpoint, and tenant and never leave the server.
