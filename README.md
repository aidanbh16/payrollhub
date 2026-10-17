# PayrollHub

PayrollHub is a multi-tenant payroll platform for HR Admins, Payroll Approvers, and Employees. It is built for
Project 2 from the Project 1 threat model, the Assignment 4 prioritized threats, and the Assignment 5 architecture.

> **Status:** Layer 0 (foundation), Layer 1 (data layer: schema, tenant isolation, repositories, seed data), and
> Layer 2 (Identity & Access: staff sign-in with required MFA, stored sessions, approval-time step-up, the stand-in
> IdP, and SSO assertion validation), Layer 3 (the route-handler pattern, tenant from verified claims only, and
> scoped service-to-service tokens with the `/api/internal/*` routes), Layer 4 (the edge layer: WAF-style request
> filtering and the Redis-backed rate limiter in Proxy), Layer 5 (Payroll Approval: MFA step-up, signed single-use
> approval tokens, and key rotation), Layer 6 (Payroll Engine: token verification, atomic redemption, gross-to-net,
> pay results), Layer 7 (Bank Account service: pending changes, out-of-band confirmation, the development mailbox),
> Layer 8 (ACH Disbursement: idempotent, signed batches sent over mTLS to the stand-in bank; the central log
> pipeline with field redaction), and Layer 9 (the React UI: HR Admin and Payroll Approver consoles, the Employee
> portal, browser security headers, and browser end-to-end tests) are in place. Sections marked *(pending)* are filled in as each layer lands.

## Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Node.js | 22 LTS (22.12+) or 24 LTS | Enforced by `engines` in package.json. better-sqlite3 13 requires Node 22+. |
| npm | 10+ | Ships with Node. |
| Docker Desktop / Docker Engine | Compose v2+ | Runs Redis. See the manual fallback below if Docker is unavailable. |

No C/C++ build tools are needed: better-sqlite3 ships prebuilt binaries for Windows, macOS, and Linux.

## Install and run

```bash
cd project
npm install
npm run setup                 # creates .env, generates FIELD_ENCRYPTION_KEY, the local CA and mTLS certificates
docker compose up -d          # starts Redis on 127.0.0.1:6379
npm run db:reset              # creates .data/payrollhub.db, applies migrations, loads seed data
npm run bank                  # (separate terminal) the stand-in bank, https://localhost:8443, mTLS
npm run dev                   # http://localhost:3000
npm test                      # runs the test suite (needs Redis running: see "Running the tests")
npx playwright install chromium   # once, for the browser tests
npm run test:e2e              # builds, then runs the full flow in a real browser (needs Redis; ports 3100 and 8444)
```

**Trying it yourself:** after `npm run db:reset`, every login you need is in **`.data/dev-credentials.txt`**, and
`npm run totp -- <staff email>` prints that account's current 6-digit authenticator code. "Walk the full flow" below
goes through it step by step.

### Running the tests

`npm test` runs every test file with a throwaway SQLite database and key store per file (it never touches `.data/` or
`.env`); the ACH tests start their own stand-in bank and certificates. **The rate-limiter and edge tests need a real
Redis**, because they test the atomic Lua script itself:

- Start it first with `docker compose up -d` (or the manual Redis install below). The tests use the development
  default `redis://:dev-only-redis-password-change-me@127.0.0.1:6379`, with a random key prefix per test file, so they
  never collide with each other or with a running dev server.
- To use a different Redis, set `TEST_REDIS_URL`, e.g. `TEST_REDIS_URL=redis://:secret@127.0.0.1:6380 npm test`.
- If Redis is not running, the rate-limiter tests fail with 503s, which is the D20 fail-closed behavior. Only
  `tests/threats/D20-redis-down.test.ts` is meant to run without Redis; it points at an unused port on purpose.

**Browser end-to-end tests** (`npm run test:e2e`, Playwright, `e2e/`): a production build, a clean seed, the app on
port 3100 and the stand-in bank on 8444, with their own data under `.data/e2e/` and their own rate-limit prefix, so a
run never touches your development data. They sign in with the credentials file and `npm run totp`, walk the full
flow in Chromium, and check the browser-level controls (headers, CSP, storage, Referer, back button). Screenshots of
each step are written to `../Docs/layer9-screenshots/`.

For a production build: `npm run build`, then `npm run start`.

On startup the server log prints `[info] startup.redis_connected {"ping":"PONG"}`. If it prints
`startup.redis_unreachable`, Redis is not running or `REDIS_URL` does not match `REDIS_PASSWORD`.

**Logs (L2-12, D14).** Every log line goes through one logger (`data/log/logger.ts`), which redacts before anything
is written, and is appended as JSON to `.data/logs/payrollhub.log` (`LOG_DIR`); the console shows the same, redacted.

**Windows: run commands from the folder's exact on-disk casing.** Windows accepts `cd project` for a folder named
`Project`, but Next.js then loads React twice and `npm run build` fails with "Invalid hook call" / "Cannot read
properties of null (reading 'useContext')" on every page. `cd` into the folder using the casing Explorer shows.

Use Chrome, Edge, or Firefox at `http://localhost:3000`. Session cookies are `Secure` with the `__Host-` prefix, which
these browsers accept on `localhost` without HTTPS.

### Walk the full flow

Use Chrome, Edge, or Firefox at `http://localhost:3000` (after `npm run db:reset`, with `npm run bank` and `npm run dev`
running). Logins are in `.data/dev-credentials.txt`; authenticator codes come from `npm run totp -- <email>`. Each code
works once, so for a second code (the approval step-up) wait for the countdown the script prints.

1. **HR Admin signs in with MFA.** At `/login`, under "HR Admins and Payroll Approvers": organization `acme`,
   `admin@acme.test`, the password from the file, then the code from `npm run totp -- admin@acme.test`.
2. **Create a draft run.** On `/admin`, pick a pay date at least two days ahead and press **Create draft run**. The
   Employees table shows each pay account as its last 4 digits only.
3. **The Payroll Approver approves with step-up.** Sign in as `approver@acme.test` (another browser profile or a private
   window), open the run with **Review**, enter a fresh code from `npm run totp -- approver@acme.test`, and press
   **Approve**. The single-use approval token stays in the page's memory only (5 minutes).
4. **Run payroll.** Press **Run payroll**. The review shows each employee's gross, withholding, and net pay, the account's
   last 4 digits, totals ($9,416.67 gross, $7,345.00 net for acme), exceptions, and a **Late (D29)** warning if the run
   started after its scheduled date. A failed run says why.
5. **Send to bank** (D33: the approver sends). The batch is built from the pay results, signed, and sent over mTLS to
   the stand-in bank; the page shows the bank reference. Pressing again resends the same batch, never a new one.
6. **An employee reads a pay statement.** At `/login`, under "Employees", organization `acme`; at the stand-in IdP sign
   in as `alice@acme.test` with the IdP password from the file and press **Continue to PayrollHub**. Open the
   statement for the pay date.
7. **The employee requests a bank change.** Enter routing `091000019` and an account number (4 to 17 digits). The
   portal (and the HR Admin console) shows it as **pending, unverified**; pay still goes to the old account.
8. **Confirm it through the mailbox.** Open `/dev/outbox` (in the employee's browser), sign in as `alice@acme.test`
   with her mailbox password from the file, and open the link. The page shows the new account's last 4 digits; press
   **Confirm new account**. The portal now shows the new account. An HR Admin can also enter a change for an employee
   with **Request bank change** on `/admin`; it stays pending until the employee confirms it the same way.

- Staff sessions require MFA; employees sign in only through their organization's stand-in IdP (no PayrollHub
  password).
- If pay data changes after approval, or the computation fails, the run shows as failed and must be approved again.
  If a bank change is confirmed between computing and sending, the run is closed and HR creates a new run (D35).
- The mailbox (`/dev/outbox`, D13, D30) stands in for each person's own email provider. A mailbox opens only with its
  own random password; there is no list of mailboxes, and no PayrollHub session (an HR Admin's included) opens one.

### Rotating a signing key (L2-18)

```bash
npm run keys:rotate -- approval-token     # or: service-token, ach-batch
```

**Approval and service tokens:**

- The script writes the next key version and moves every older version to `.data/keys/<name>/retired/`.
- From that moment, every token signed with an old version fails verification. A running server picks this up
  immediately; no restart is needed, because the key store re-reads the key folder on each use.
- Approvers whose tokens died can approve the same runs again at once. Tokens signed with a retired key are ignored by
  the "a token for this run is still valid" check.
- Use it on a schedule, and immediately if a key may be compromised.
- Retired key files are kept for audit only; delete them when no longer needed.

**The ACH batch key (`ach-batch`, L1-22) rotates differently:** old versions are retired for *signing* only. Their
private keys are deleted, their public keys move to `.data/keys/ach-batch/verify-only/`, and they keep verifying. The
script also registers the new public key with the stand-in bank, which keeps trusting the old ones.

- **Why it differs:** an approval token is a short-lived bearer credential, so rotation is the compromise response
  and every outstanding token must die at once. A batch signature is evidence attached to a stored record: batches
  already signed and sent must stay verifiable (audit, disputes, resending the same signed bytes after a timeout),
  long after their key stops signing.
- **If an ACH key is compromised:** rotate it, and have the bank stop trusting the old version (with the stand-in
  bank, delete `.data/mock-bank/trusted-keys/ach-batch-v<N>.pem`). Batches signed with it then stop being accepted.

| Script | What it does |
|---|---|
| `npm run setup` | Creates `.env` if missing and fills in generated development secrets, and creates the local CA and mTLS certificates in `PKI_DIR`. Never overwrites existing values or certificates. |
| `npm run bank` | Runs the stand-in originating bank at `BANK_URL` (mTLS, signed batches only, D12). |
| `npm run totp -- <email> [--code-only]` | Prints a seeded staff account's current authenticator code, from `.data/dev-credentials.txt`. |
| `npm run test:e2e` | Builds, then runs the browser end-to-end tests (Playwright; needs Redis; ports 3100 and 8444). |
| `npm run db:reset` | Deletes the database and the stand-ins' data (IdP keys, mailboxes, the bank's ledger), applies every migration, and seeds: new random mailbox passwords, the ACH public key registered with the bank. Keeps certificates and logs. |
| `npm run db:migrate` | Applies pending migrations only. |
| `npm run db:seed` | Seeds an empty, migrated database (refuses if the tenants already exist). |
| `npm run db:generate` | Developer use: generates a new migration after editing `data/db/tables.ts`. |

### Manual Redis install (fallback if Docker is unavailable)

Run Redis 7+ bound to localhost with the password from your `.env` (`REDIS_PASSWORD`):

- **Windows:** install WSL (`wsl --install`), then inside Ubuntu: `sudo apt update && sudo apt install -y redis-server`
  and run `redis-server --bind 127.0.0.1 --requirepass dev-only-redis-password-change-me --save ""`.
  WSL forwards `127.0.0.1:6379` to Windows automatically.
- **macOS:** `brew install redis`, then `redis-server --bind 127.0.0.1 --requirepass dev-only-redis-password-change-me --save ""`.
- **Linux (Debian/Ubuntu):** `sudo apt install -y redis-server`, then the same `redis-server` command.

Check it with `redis-cli -a dev-only-redis-password-change-me ping` (expects `PONG`). If you change the password,
update both `REDIS_PASSWORD` and `REDIS_URL` in `.env`.

## Configuration

All secrets, key locations, and connection strings come from environment variables, validated at startup by
`config/env.ts` (which reports missing variable names, never values). `.env.example` holds safe development
placeholders. `.env`, `.data/`, and every database file are gitignored.

| Variable | Purpose |
|---|---|
| `DATABASE_PATH` | SQLite database file (default `.data/payrollhub.db`) |
| `REDIS_PASSWORD` | Password Docker Compose starts Redis with |
| `REDIS_URL` | Connection string the app uses for the rate limiter store; must match `REDIS_PASSWORD` |
| `FIELD_ENCRYPTION_KEY` | 32-byte AES-256-GCM key (base64) for bank numbers, TOTP secrets, and ACH file bodies. Generated by `npm run setup`. |
| `MOCK_IDP_DIR` | Where the stand-in IdP keeps its per-tenant signing keys and employee directory (default `.data/mock-idp`, written by `npm run db:reset`) |
| `KEYSTORE_DIR` | The local key store's versioned signing keys (default `.data/keys`, created by `npm run db:reset` if missing) |
| `RATE_LIMIT_PREFIX` | Prefix for rate-limit counters in Redis (default `rl`; tests use a random one per test file) |
| `TRUSTED_CLIENT_IP_HEADER` | **Leave unset locally.** Set only behind a reverse proxy that overwrites this header with the real client address (e.g. `x-real-ip`); turns on per-IP limits. See "Client IP" below. |
| `TEST_REDIS_URL` | Optional, for `npm test` only: Redis to use instead of the development default |
| `INTERNAL_API_ORIGIN` | Where the application layer calls its own `/api/internal/*` routes (default `http://127.0.0.1:3000`). Set it if you run on another port. It is configured, never taken from a request's Host header, so a client cannot redirect service tokens to another server. **It must be a loopback address** (`127.x.x.x`, `localhost`, `[::1]`): the server refuses to start otherwise, so a misconfiguration cannot send service tokens off the machine (DV-36). |
| `MOCK_MAIL_DIR` | Where the stand-in email provider keeps mailboxes and mailbox passwords (default `.data/mock-mail`, written by `npm run db:reset`) |
| `DEV_CREDENTIALS_FILE` | Where `npm run db:reset` writes the development credentials for testers: staff passwords, TOTP secrets and `otpauth://` links, employee IdP passwords, and the random mailbox passwords (D30, D40; default `.data/dev-credentials.txt`, gitignored, owner-only) |
| `PKI_DIR` | Local CA, the bank's server certificate, PayrollHub's client certificate, and the pinned bank fingerprint (`bank-pin.txt`), created by `npm run setup` (default `.data/pki`) |
| `BANK_URL` | Where ACH Disbursement sends signed batches (default `https://localhost:8443`); `npm run bank` listens there |
| `BANK_TIMEOUT_MS` | How long to wait for the bank's answer before reporting a timeout (default 10000). A retry resends the same batch. |
| `MOCK_BANK_DIR` | The stand-in bank's own data: the ACH public keys it trusts and its ledger of accepted batches (default `.data/mock-bank`) |
| `LOG_DIR` | Where the redacted, append-only log file `payrollhub.log` is written (default `.data/logs`) |
| `APP_ORIGIN` | Public origin used in links inside emails, such as bank-change confirmations (default `http://localhost:3000`) |

**Client IP (D26).** Next.js 16 gives Proxy no client address that a client cannot forge. There is no `request.ip`, and
Next.js copies the socket address into `X-Forwarded-For` only when the client did not send that header itself, so any
client can put any value there. PayrollHub therefore never reads `X-Forwarded-For`.

Locally, rate limits are keyed per targeted account and per route class, not per IP. On localhost every request comes
from one address anyway, so per-IP limits would add nothing there.

**Deploying behind a reverse proxy (adds per-IP limits).** Put nginx, Caddy, or a load balancer in front of the app.
Have it **overwrite** (never append to) a header with the real client address. Bind the app to localhost so the proxy
is the only way in. Then set `TRUSTED_CLIENT_IP_HEADER` to that header's name.

```nginx
# nginx: the app listens only on 127.0.0.1:3000; nginx terminates TLS and sets X-Real-IP itself.
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header X-Real-IP $remote_addr;      # overwrites anything the client sent
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header Host $host;
}
```

```text
# Caddy equivalent
reverse_proxy 127.0.0.1:3000 {
    header_up X-Real-IP {remote_host}
}
```

Then start the app with `TRUSTED_CLIENT_IP_HEADER=x-real-ip` (and `npm run start -- -H 127.0.0.1`).
`tests/threats/L1-05-trusted-ip.test.ts` covers this mode.

**Key material comes from one place: the key store, `data/keys/kms.ts`** (the local stand-in for KMS, DV-07).
- **Signing keys** (service tokens now; approval tokens and ACH batches later) are versioned Ed25519 keys under
  `KEYSTORE_DIR/<name>/v<N>.pem`. Callers ask the store to sign or verify; no function returns a private key.
- **The field-encryption key** is also read only through the key store (`fieldEncryptionKey()`).
  - `npm run setup` writes 32 random bytes (base64) into `.env`, which is gitignored and never copied into the
    database.
  - Next.js loads `.env` at startup; scripts load it with `tsx --env-file=.env`.
  - `config/env.ts` checks that it decodes to exactly 32 bytes, and the key store reads it once into memory.
  - **Documented limitation:** the key sits in a file next to the app rather than in an HSM.
- Tests use a fresh random key and a temporary key store for each test file.

## Seed data and test accounts

`npm run db:reset` loads two tenants and writes **`.data/dev-credentials.txt`** (gitignored): every login below, each
staff account's TOTP secret with an `otpauth://` link (paste it into an authenticator app, or turn it into a QR code
with any QR tool), and the random mailbox passwords. `npm run totp -- <staff email>` prints the current code instead.
Every password and TOTP secret here is a **development-only** value.

| Tenant id (organization) | Role | Email | Password | TOTP secret (base32) |
|---|---|---|---|---|
| `acme` (Acme Corporation, 22% withholding) | HR Admin | `admin@acme.test` | `Acme-Admin-Dev-2026!` | `MFRW2ZJNMFSG22LOFVSGK5RNORXXI4BB` |
| `acme` | Payroll Approver | `approver@acme.test` | `Acme-Approver-Dev-2026!` | `MFRW2ZJNMFYHA4TWFVSGK5RNORXXI4BB` |
| `acme` | Employees | `alice@acme.test`, `bob@acme.test`, `carol@acme.test` | `Acme-Employee-Dev-2026!` (at the stand-in IdP) | n/a (SSO) |
| `globex` (Globex Inc., 20% withholding) | HR Admin | `admin@globex.test` | `Globex-Admin-Dev-2026!` | `M5WG6YTYFVQWI3LJNYWWIZLWFVXXI4BB` |
| `globex` | Payroll Approver | `approver@globex.test` | `Globex-Approver-Dev-2026!` | `M5WG6YTYFVQXA4DSOYWWIZLWFVXXI4BB` |
| `globex` | Employees | `dana@globex.test`, `eli@globex.test`, `fay@globex.test` | `Globex-Employee-Dev-2026!` (at the stand-in IdP) | n/a (SSO) |

- MFA codes: `npm run totp -- admin@acme.test` (add `--code-only` for just the digits), or add the TOTP secret or
  `otpauth://` link to any authenticator app (Google Authenticator, 1Password, etc.).
- Employees sign in only through their tenant's SSO identity provider (Assignment 5, Section 2.1; D22), so they have
  no PayrollHub password; the database rejects one (`app_user_password_check`). Their passwords are stored by the
  stand-in IdP in `MOCK_IDP_DIR`, which `npm run db:reset` provisions with a new signing key per tenant.
- Each employee has one verified bank account. Routing numbers are publicly listed ABA numbers with valid check
  digits; account numbers are made up. The data lives in `scripts/lib/seed.ts`.
- Every account above also has a development mailbox at `/dev/outbox`. Its password is random, generated by
  `npm run db:reset`, and listed only in `.data/dev-credentials.txt` (D30). Valid ABA routing numbers for trying
  a change: `091000019`, `122105278`.

## Project structure

The top-level folders mirror the Assignment 5 layers and services.

| Folder | Assignment 5 layer / component |
|---|---|
| `app/(console)/`, `app/(employee)/`, `app/(auth)/` | Client apps: admin and approver consoles, employee portal, sign-in |
| `proxy.ts`, `edge/` | Edge security layer: request filtering and the Redis-backed rate limiter |
| `app/api/`, `application/` | Next.js application layer: route handlers, session and MFA checks, tenant guard, Zod schemas |
| `services/<service>/` | Core backend services: identity, approval, engine, bank-account, ach. Each has its own `repository.ts` (D5). |
| `data/db/` | Payroll DB: schema (`tables.ts`), tenant-filtered views (`views.ts`), the tenant scope (`tenant-scope.ts`) |
| `data/crypto/`, `data/keys/`, `data/log/` | Field encryption, key store, logger |
| `partners/`, `app/mock-idp/` | Local stand-ins for the tenant SSO IdP and the originating bank |
| `migrations/` | `0000_tables.sql` (generated by drizzle-kit) and `0001_tenant_isolation.sql` (hand-written views and triggers) |
| `config/` | Environment validation |
| `scripts/` | Setup, migrate, seed, reset |
| `tests/threats/`, `tests/data/` | One test file per Assignment 4 threat, plus data-layer tests |

## Third-party dependencies

| Package | Version | Why |
|---|---|---|
| next | 16.4.2 | Required framework: routing, Proxy, route handlers |
| react, react-dom | 19.3.0 | Required UI library |
| better-sqlite3 | 13.0.3 | Required SQLite database driver; registers `current_tenant()` for the isolation views and triggers |
| drizzle-orm | 0.45.4 | ORM for consistent query parameterization; the tenant-scoped repository wraps it |
| redis | 6.3.0 | Official Redis client for the shared rate-limit store |
| zod | 4.6.7 | Payload and environment validation (named in Assignment 5) |
| jose | 6.2.12 | Sign and verify approval tokens, service tokens, and SSO assertions with pinned algorithms |
| otplib | 13.5.0 | TOTP for required MFA and approval step-up |
| server-only | 0.0.1 | Build error if server modules are imported into client code |
| drizzle-kit (dev) | 0.31.11 | Generates schema migrations |
| vitest (dev) | 5.0.5 | Threat tests |
| tsx (dev) | 4.23.15 | Runs TypeScript scripts (setup, migrate, seed, reset, mock bank) |
| selfsigned (dev) | 5.5.0 | Generates the local CA and mTLS certificates without OpenSSL |
| @playwright/test (dev) | 1.63.0 | Browser end-to-end tests in real Chromium: the full flow, CSP enforcement, browser storage, Referer, and the back button can only be proven in a browser. Dev only; adds no npm audit findings. |
| @types/node (22), @types/better-sqlite3, @types/react, @types/react-dom, typescript, eslint, eslint-config-next, tailwindcss, @tailwindcss/turbopack (dev) | from create-next-app | Type checking, linting, UI styling |

`package.json` sets `allowScripts` to deny install scripts for better-sqlite3, esbuild, and unrs-resolver. None of
them need their scripts: better-sqlite3 ships prebuilt binaries, and esbuild and unrs-resolver install their
platform binaries as optional dependencies.

**npm audit (D21):** `npm audit --omit=dev` reports **0 vulnerabilities**. A full `npm audit` reports 5 high findings,
all in `braces` inside `eslint-config-next`'s lint toolchain, and 4 moderate findings in the `esbuild` copy inside
`drizzle-kit`'s migration generator (development-server issues; drizzle-kit is only run by hand to write migrations). They are dev-only and never shipped; the suggested
`npm audit fix --force` would downgrade the lint config to Next.js 14, so they are accepted.

## Developer rules

These are enforced by ESLint (`eslint.config.mjs`), the type checker, runtime checks, and tests where possible.

1. **No raw SQL in application code.** ESLint rejects the Drizzle `sql` tag (and `sql.raw` and friends), SQL strings
   passed to `run/all/get/values`, any string passed to the driver's `exec/prepare`, the raw driver handle
   (`$client`), and imports of `better-sqlite3`. Raw SQL is allowed only in `migrations/`, for the isolation views and
   triggers. **The single exception (D23)** is `data/db/tables.ts`, where the `sql` tag may appear only as the
   expression of a `check(...)` constraint; ESLint and the source-scan test both fail on any other `sql` use there or
   anywhere else, including `data/`.
2. **The database is reached only through `withTenant()`** from `@/data/db/tenant-scope`. Everything else under
   `data/db/` (base tables, connection, migrations) is off-limits outside `data/db/`. `withPlatform()` is allowed only
   in `services/identity/` and `scripts/`. The test `tests/data/views-only.test.ts` fails if any application file
   imports the raw handle or base tables, reads a base table with raw SQL, or disables these lint rules.
3. **Scopes are synchronous.** `withTenant(tenantId, (s) => ...)` sets the tenant, runs the callback in one
   transaction, and clears the tenant with no `await` in between. An async callback is a compile error, and at runtime
   it is rolled back and rejected. A scope object used after its block ends throws. Do all async work (network calls,
   password hashing) before or after the block, never inside.
4. **Reads go through views.** `s.read(view)` accepts only the tenant-filtered views (checked by type and at runtime).
   Writes name a table; the scope fills `tenant_id` itself and rejects a caller-supplied one.
5. **The tenant id comes from verified claims only,** never from request input (L2-04).
6. **No caching of tenant or user data (D17).** Cache Components is enabled in `next.config.ts`, so nothing that
   holds tenant or user data may be marked `"use cache"`; it would be served across users and tenants.
7. **Every route handler uses the one wrapper** in `application/http/route.ts`:
   `export const POST = route.session({...})`, `route.service({...})`, or `route.public({...})`. ESLint rejects any
   other export from a `route.ts` file, and `tests/data/route-wrapper.test.ts` scans every route file and fails on one
   that skips the wrapper. The wrapper:
   - checks the caller: a session with an allowed role, or a scoped service token;
   - refuses a path `[tenantId]` that differs from the verified tenant (`tenantInPath: true`);
   - validates params, query, and body with schemas that must be `z.strictObject` and may not contain a tenant field,
     checked when the module loads;
   - hands the handler the verified claims and tenant;
   - turns every error into a fixed generic response.

   Pages call `requirePageSession(roles)` from `application/auth/dal.ts`. Proxy's cookie check is only a pre-filter.
   The privileged-role MFA requirement lives inside the DAL, so no route can opt out of it.
8. **Session reads in pages go inside `<Suspense>`** (a Cache Components rule). `requirePageSession()` calls
   `connection()` first, so the check runs at request time, never during a prerender or prefetch.
9. **State-changing requests check their origin.** The route wrapper refuses any non-GET request from another origin
   on session and public routes, on top of `SameSite=Strict` cookies. Internal service routes authenticate by token
   instead.
10. **Calls into a backend service carry a scoped service token, minted only as yourself (DV-26).** Each caller
    has one handle: `mintAsBff` (`application/mint-as-bff.ts`, for `app/` and `application/`), and `mintAsApproval`,
    `mintAsEngine`, `mintAsAch`, `mintAsBankAccount` (`services/<service>/mint-as-<service>.ts`). ESLint lets a handle
    be imported, through its `@/` path, only from inside its own folder, and lets nothing but a handle import
    `mintServiceToken`.
    - Every service entry point starts with `authorizeServiceCall(auth, { endpoint, tenantId })`.
    - A new endpoint needs an entry in `SERVICE_ENDPOINTS` (mark money-moving ones `singleUse: true`) and a
      ServiceGrant row (`scripts/lib/seed.ts`).
11. **Not found is not found.** A resource in another tenant returns the same 404 body as one that does not exist,
    because reads go through the tenant-filtered views and services throw `NotFoundError` for both.
12. **New routes join the edge policy.** A route that checks a password or code goes in `edge/login-routes.ts`; a
    money-moving route goes in `MONEY_ROUTES` (`edge/route-policy.ts`). Both fail closed when Redis is down (D20).

## Design decisions

| # | Decision |
|---|---|
| D20 | **Redis outage policy.** If Redis is unreachable (or does not answer within 300 ms), Proxy **fails closed with HTTP 503** on login routes and money-moving routes (`MONEY_ROUTES`: the internal Engine and ACH routes, and the approve/start/disburse routes). Other routes continue, and a warning is logged at most every 30 s. After a failure, Redis is skipped for 2 s and then a fresh connection is opened, so the app recovers on its own when Redis returns. |
| D21 | Dev-only npm audit findings are accepted (see Third-party dependencies). |
| D25 | **Two sign-in budgets per account.** A *known device* is a browser that completed MFA for this account (cookie `__Host-ph_known`, set only after MFA; Redis stores only its SHA-256, under that account). It gets its own budget (20 per 15 min) and skips the login-class ceiling, at both sign-in steps. Any other device gets 5 immediate attempts, then must wait 1 s, 2 s, 4 s ... (up to 15 min) between attempts. Early attempts are refused at once with 429 + `Retry-After`; the server never sleeps, and refusals do not add to the penalty. |
| D26 | Per-IP limits only behind a reverse proxy that overwrites a client-IP header (see Client IP); none locally. |
| D22 | Employees sign in only through their tenant's stand-in IdP, which stores their development passwords. |
| D23 | The `sql` tag is allowed only as a `check(...)` expression in `data/db/tables.ts` (see Developer rule 1). |
| D24 | Staff sign-in stays two-step and indistinguishable at step 1, with one code attempt per password entry. |
| — | **Approval tokens** (L2-01, L2-18): EdDSA JWTs signed by the key store's `approval-token` key. Claims: `iss` payrollhub:approval, `aud` payrollhub:engine, `sub` approver, `tid`, `run`, unique `jti`; `kid` names the key version; 5-minute expiry. Issued only with a fresh step-up proof, for a draft run (or by the same approver after an earlier token expired or its key was rotated), at most one live token per run. Each is recorded in `approval_token`. Redemption checks signature, active key, expiry, tenant, run, approver, and record, then sets `redeemed_at` in one atomic UPDATE. |
| D27 | **Separation of duties:** the user who created a run can never approve it. Checked in Payroll Approval, in Payroll Engine, and by database triggers on `payroll_run` insert and update (migration `0009`). |
| D28 | **The approval covers the run's content.** The token's `rh` claim is the SHA-256 of a canonical encoding of the run:<br>- a JSON array with a version tag, in fixed field order: tenant, run id, pay date, scheduled run date, creator, withholding rate;<br>- the active employees sorted by id (plain code-unit order), each with pay rate and verified bank account id (or null);<br>- integers for money, UTF-8 (`services/engine/run-content.ts`).<br>Payroll Engine recomputes it from the database before computing anything. **A pay-rate change, an employee added or removed, a withholding change, or a bank change confirmed after approval all invalidate the token, and the run must be approved again. This is intended:** an approver approves what will actually be paid. |
| D29 | **Late runs proceed.** A run started after its scheduled run date still computes, returns `late: true`, and logs a warning, because not paying is worse than paying late. The approver UI shows the flag in Layer 9. |
| D30 | **How the development mailbox is gated.** Each mailbox opens only with its own password, stored as a scrypt hash by the stand-in provider (`partners/mock-mail/`), separate from PayrollHub and the IdP; no browsing or listing; no PayrollHub session grants access; failed opens are throttled per mailbox by Proxy (fail closed, D20); pages are `no-store` and `no-referrer`. **The passwords are random per install** (`npm run db:reset`), written only to `.data/dev-credentials.txt` (gitignored, owner-only), so taking over an HR Admin account says nothing about any mailbox password. |
| D31 | **Contact email changes are out of scope.** No feature changes a user's email, and the trigger `app_user_email_immutable` (migration `0011`) refuses any change, so nothing can redirect confirmations. Changing an address would need confirmation from the old one; it is left for a later project. |
| D32 | **Bank-account changes.** Any change, by the employee or an HR Admin, is stored as pending (`bank_account_change`) and never paid. One pending change per employee: a new request supersedes the old one (status `rejected`, resolution `superseded`) and kills its link; a partial unique index enforces it. Links: 256 random bits, only the SHA-256 stored (`verification_code`), bound to tenant, change, and employee, valid 60 minutes, consumed atomically. GET only shows the change; Confirm and Reject are POSTs that need the employee's own session (origin-checked, SameSite=Strict cookie). Confirming retires every verified account and inserts the new one in one transaction, recording requester, confirmer, and time. Notices go to the existing address on request, confirmation, rejection, and supersession. Routing numbers must pass the ABA checksum; account numbers are 4 to 17 digits. Responses, notices, and logs show only the last 4 digits. |
| D33 | **The Payroll Approver sends to the bank**, from the run's review page after a successful compute (`POST /api/tenants/<org>/runs/<runId>/disburse`; HR Admins and employees get 403). |
| D34 | **ACH key rotation retires for signing only** (see "Rotating a signing key"). Old ACH key versions keep verifying, so existing batches remain verifiable; approval and service keys stop verifying at once. |
| D35 | **An account in PayResult retired after compute** (a bank change confirmed before the batch was built): refuse. The run moves to `failed` (`bank_account_changed`), no batch is built, the run can never be approved again (service check and trigger), and a new run pays everyone into their current verified accounts. |
| D36 | **ACH Disbursement design.** One batch per run: the idempotency key is SHA-256 of a version tag, the tenant, and the run; the batch ID (20 characters) is derived from it and written inside the signed file (batch header, company discretionary data). `UNIQUE(run_id)`, `UNIQUE(idempotency_key)`, and the derived primary key enforce it. The file (NACHA PPD, credits only) is built from PayResult rows and verified accounts only; control totals (entry count, entry hash, total credit, block count) are re-read from the exact text and must equal the pay results before signing, and a trigger checks the stored totals again. Built and signed in one transaction, then sent: the exact bytes are signed (Ed25519, `ach-batch` key, through `data/keys/kms.ts`) and re-verified before each send. A timeout leaves the batch `signed`; sending again resends the same bytes, and the bank's duplicate answer for the same file counts as delivered. Net pay of zero produces no entry. |
| D37 | **Log pipeline.** One logger (`data/log/logger.ts`); `console.*` is banned in app code (ESLint, plus a source scan in the tests) and wrapped at startup, so Next.js's own output is redacted too; unhandled errors (route wrapper, `onRequestError`, process hooks) go through it. Redaction at ingest: fields in the shared logging schema (`SENSITIVE_FIELDS`: account and routing numbers, SSN, file body, passwords, tokens, cookies, ...) at any depth, and patterns in every string: SSNs, 9-digit runs (`[ROUTING]` when ABA-valid), any run of 7 or more digits, and space- or dash-grouped digits totalling 7 or more. UUIDs are kept. Structured JSON lines, appended only. |
| D38 | **Browser security headers.** Proxy sends a per-request nonce Content-Security-Policy on every response: `default-src 'self'`; scripts only same-origin files or with the nonce (no `'unsafe-inline'`, no `'strict-dynamic'`, `'unsafe-eval'` only under `next dev`); styles same-origin or nonce; `object-src 'none'`, `base-uri 'none'`, `form-action 'self'`, `frame-ancestors 'none'`. Plus `Cache-Control: no-store` on every page and API response, and from `next.config.ts` `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Cross-Origin-Opener-Policy: same-origin`, and a `Permissions-Policy`. No third-party resources anywhere, so the confirmation page (token in the URL) loads nothing from another origin; it also removes the token from the address bar. A page restored from the back-forward cache reloads (`BfcacheGuard`). `'strict-dynamic'` (in the Next.js guide's example) is left out: it let a script inserted at run time execute, and Next.js does not need it. |
| D39 | **Cross-site request check uses Fetch Metadata.** With `Referrer-Policy: no-referrer`, browsers send `Origin: null` on same-origin POSTs, so the route wrapper now also reads `Sec-Fetch-Site` (set by the browser, not by page scripts): an `Origin` naming another origin is refused; when `Sec-Fetch-Site` is present it must be `same-origin`; `Origin: null` without it is refused; requests with neither (not a browser) are allowed as before. |
| D40 | **Tester credentials.** `npm run db:reset` writes `.data/dev-credentials.txt` (gitignored, owner-only) with staff passwords, TOTP secrets and `otpauth://` links, employee IdP passwords, and random mailbox passwords; `npm run totp -- <email>` prints a current code. The UI layer imports no service code (ESLint, plus a source scan): pages only check the session to decide where to send the visitor, and all data comes from route handlers. |
| — | **Running payroll is one transaction.** Payroll Engine verifies the token and gets a redemption ticket from Payroll Approval first (async). Then one synchronous `withTenant` transaction does all of the following; if anything throws, SQLite rolls back all of it, so a burned token never exists next to missing or partial results:<br>- re-reads the run, D27, and the D28 hash;<br>- has Payroll Approval redeem the token (atomic `redeemed_at` update);<br>- computes every employee and writes all `pay_result` and `pay_exception` rows;<br>- moves the run to `computed`.<br>On a content mismatch or a computation error, a second small transaction burns the token and marks the run `failed` (`failure_reason` = `content_changed` or `computation_error`); re-approval moves it back to `approved`. A bad, replayed, or mismatched token changes nothing. Triggers allow results only while a run is `approved`, make results immutable, and allow only valid status changes. |
| — | **Money:** integer cents. Withholding = gross × rate (basis points) ÷ 10,000, **rounded half up** to the cent, computed exactly as `floor((gross × bp + 5000) / 10000)`; net = gross − withholding, kept within [0, gross] (`services/engine/pay-calc.ts`). An active employee without a verified bank account is not paid and is reported in the run's `exceptions` and a `pay_exception` row. |
| — | **SSO assertions are single-use.** Each assertion's `jti` is recorded in `sso_assertion` until the assertion could no longer pass validation (the later of `exp` and `iat` + 5 min, plus the 30 s clock tolerance), and a second use is refused. This is the same pattern as approval tokens (L2-01). |
| — | **Password hashing:** scrypt with N=2^15, r=8, p=3 (one of the OWASP Password Storage Cheat Sheet's settings, about 32 MiB per hash), using Node's built-in `crypto`. Argon2id is OWASP's first choice, but Node 22 has no built-in Argon2 and the scrypt setting avoids adding a native dependency. Stored hashes carry their parameters, so they can be raised later. |
| — | **Two-step staff sign-in that reveals nothing at step 1.** Step 1 always answers "enter your code" with a new session cookie. The session is real only if organization, email, and password were all right, and every path costs one scrypt verification. Step 2 fails with the same message whether the password, the code, or the pending session was wrong. Each correct password allows one code attempt; a wrong code ends the pending session. |

## Threat-to-control mapping

Filled in as each layer is built; the planned mapping for the remaining threats is in the session log in `docs/`.

| Threat | Control | Where | Tests |
|---|---|---|---|
| **L1-14** cross-tenant reads (primary) | Tenant-filtered views `v_<table>` using `current_tenant()`; the ORM reads only from them; returns nothing when no tenant is set | `migrations/0001_tenant_isolation.sql`, `data/db/views.ts`, `data/db/tenant-scope.ts` | `tests/threats/L1-14-cross-tenant-reads.test.ts`, `tests/data/views-only.test.ts`, `tests/data/async-interleaving.test.ts` |
| **L2-16** cross-tenant writes (primary) | `BEFORE INSERT/UPDATE/DELETE` triggers reject any row whose `tenant_id` differs from `current_tenant()` (the `WITH CHECK` equivalent); composite `(tenant_id, id)` foreign keys | `migrations/0001_tenant_isolation.sql`, `migrations/0000_tables.sql` | `tests/threats/L2-16-cross-tenant-writes.test.ts` |
| **L2-04** tenantId path/token mismatch (primary) | The route wrapper takes the tenant only from verified claims, refuses (403) a path `[tenantId]` that differs instead of correcting it, and validates bodies with strict schemas that cannot contain a tenant field (unknown fields get 400) | `application/http/route.ts`, `application/validation/*.ts`, `app/api/tenants/[tenantId]/runs/**` | `tests/threats/L2-04-route-handlers.test.ts`, `tests/data/route-wrapper.test.ts` |
| L2-04 (defense in depth) | The tenant scope sets `tenant_id` on every write and rejects a caller-supplied one; the service token's `tid` must match the tenant the service is asked to act in | `data/db/tenant-scope.ts`, `services/identity/service-tokens.ts` | `tests/threats/L2-04-tenant-from-scope.test.ts`, `tests/threats/L1-19-service-tokens.test.ts` |
| **L1-19** unchecked service-to-service calls (primary) | Identity & Access mints 60-second Ed25519 tokens scoped to one caller, one endpoint (and its service as audience), and one tenant, only if ServiceGrant allows it. Every service entry point and every `/api/internal/*` route verifies the token: missing, expired, forged, wrong audience, wrong endpoint, wrong tenant, or revoked grant are all refused. Tokens for the internal money routes are single-use (`service_token_use`). Each service mints only as itself (DV-26) | `services/identity/service-tokens.ts`, `data/keys/kms.ts`, `services/engine/engine-service.ts`, `services/ach/ach-service.ts`, `app/api/internal/**` | `tests/threats/L1-19-service-tokens.test.ts` |
| L1-19 (defense in depth) | Internal routes ignore session cookies; one repository per service (DV-03) | `application/http/route.ts` | same |
| **L0-01** HR Admin takeover (primary) | Required TOTP MFA for HR Admin and Payroll Approver, enforced inside the Data Access Layer on every request with no per-route opt-out. TOTP codes are single-use: the last accepted time step is stored and updated atomically. Approval-time step-up (`stepUp()`) is ready for Layer 6. | `application/auth/dal.ts`, `services/identity/totp.ts`, `services/identity/login.ts`, `services/identity/step-up.ts` | `tests/threats/L0-01-admin-mfa.test.ts` |
| L0-01 (defense in depth) | Server-side sessions with short TTLs (pending 5 min, staff 30 min, employee 60 min), device binding, `revoked_at` checked on every request, a new session id at login, after MFA, and after step-up, generic failures with equal timing, Proxy pre-filter, `__Host-` Secure HttpOnly SameSite=Strict cookies, origin checks, DB CHECK requiring staff MFA enrollment | `services/identity/sessions.ts`, `proxy.ts`, `application/auth/session-cookies.ts`, `application/http/forms.ts`, `data/db/tables.ts` | same |
| **L2-01** approval token replay (primary) | Single-use approval tokens: one atomic `UPDATE approval_token SET redeemed_at ... WHERE redeemed_at IS NULL`, so a replay and simultaneous redemptions fail; at most one live token per run; tokens bound to tenant, run, and approver and checked against their record | `services/approval/approval-service.ts`, `services/approval/repository.ts`, `app/api/internal/approval/**` | `tests/threats/L2-01-approval-tokens.test.ts` |
| L2-01 (defense in depth) | Issuing needs a fresh MFA step-up proof (single-use, 60 s, unforgeable); the client keeps the token in memory only (no cookie, no browser storage, `no-store`); the approve route is throttled per session and fails closed (D20); triggers make tokens write-once and runs frozen after approval | `app/api/tenants/[tenantId]/runs/[runId]/approve/route.ts`, `services/identity/step-up.ts`, `app/(console)/approver/approve-run.tsx`, `eslint.config.mjs`, `migrations/0007_approval_immutability.sql` | same, `tests/data/browser-storage.test.ts` |
| **L2-18** tokens don't expire or rotate (primary) | 5-minute expiry checked by signature and by record; versioned approval key with on-demand rotation (`npm run keys:rotate`) that retires every older version immediately | `services/approval/approval-service.ts`, `data/keys/kms.ts`, `scripts/rotate-key.ts` | `tests/threats/L2-01-approval-tokens.test.ts` |
| L0-01 (defense in depth, Layer 5) | Approving a run needs a fresh TOTP step-up, so a stolen approver session alone cannot approve payroll | `services/identity/step-up.ts` | same |
| **L2-02** unverified approval-token signature (primary) | Before computing anything, Payroll Engine verifies the token against the key-store key named by its `kid` (retired versions fail), algorithm pinned to EdDSA, then issuer, audience, expiry, tenant, run, and approver; then D27 and the D28 content hash. Only then does Payroll Approval redeem it, inside the same transaction that writes the results | `services/engine/engine-service.ts`, `services/approval/approval-service.ts` (`verifyApprovalToken`), `services/engine/run-content.ts` | `tests/threats/L2-02-payroll-engine.test.ts`, `tests/threats/L2-02-engine-failure.test.ts` |
| L2-02 (defense in depth) | The engine is reachable only at `/api/internal/engine` with a single-use service token; the BFF calls it at the configured internal origin and passes only the approval token (strict schema: no amounts, employees, or accounts); Payroll Approval re-verifies the token when preparing redemption; database triggers (status transitions, results only while approved, immutable results, D27) | `app/api/internal/engine/**/start/route.ts`, `app/api/tenants/[tenantId]/runs/[runId]/start/route.ts`, `migrations/0009_engine_integrity.sql` | same |
| L2-01 (defense in depth, Layer 6) | Redemption happens only inside the engine's transaction, so a token is never redeemed without its results; a failed run burns its token | `services/engine/engine-service.ts` | same |
| L0-11 (defense in depth, Layer 6) | The run is scheduled a day before the pay date; a late start is flagged and logged (D29); employees without a verified account are reported, not silently dropped | `services/engine/engine-service.ts` | same |
| **L1-20** forged SSO assertion (primary) | Each assertion is verified against the tenant's own `TenantIdpConfig` before any session is created: signature with the registered public key, algorithm pinned to ES256, issuer, audience, `exp` and `iat` age (5 min), and the signed `tid` claim must name the receiving tenant; the subject must be an active employee of that tenant | `services/identity/sso.ts`, `app/api/auth/sso/[tenantId]/callback/route.ts` | `tests/threats/L1-20-sso-assertion.test.ts` |
| L1-20 (defense in depth) | Per-tenant IdP keys and configuration, so one tenant's IdP cannot sign anyone in to another tenant (Section 2.5); assertions are single-use (`jti` recorded until expiry) | `partners/mock-idp/idp.ts`, `scripts/lib/seed.ts`, `services/identity/repository.ts` (`recordAssertionUse`) | same |
| **L1-05** credential stuffing (primary) | Proxy throttles every login route (staff login, the MFA step, the stand-in IdP's form, the approval step-up) per targeted account before any password or code is checked: tenant + email, trimmed, lowercased, and hashed (or the session, for code steps). Staff sign-in uses D25's two budgets: known devices 20 per 15 min; unknown devices 5, then progressive retry-after delays. Other code steps: 10 per 15 min. Counters live in Redis, updated by one atomic Lua script. Per-IP limits only behind a trusted reverse proxy (see Client IP) | `proxy.ts`, `edge/rate-limiter.ts`, `edge/login-routes.ts`, `edge/route-policy.ts` | `tests/threats/L1-05-credential-stuffing.test.ts`, `tests/threats/L1-05-trusted-ip.test.ts` |
| **L0-11** pay-date outage (primary) | WAF-style filtering in Proxy from headers alone: method allowlist per route, URL length and encoded-path tricks, `Content-Length` required and capped per route (4 KiB login, 32 KiB API), allowed content types, no `Transfer-Encoding`; Next.js's own pre-Proxy body buffer capped at 64 KiB. A separate ceiling per route class (login 300/min, money 120/min, API 3000/min, pages 6000/min), so a flood on one class cannot starve the others | `edge/waf.ts`, `edge/route-policy.ts`, `proxy.ts`, `next.config.ts` | `tests/threats/L0-11-edge-filtering.test.ts`, `tests/threats/L0-11-route-ceilings.test.ts` |
| L0-11 (defense in depth) | Day-early payroll schedule (`payroll_run_day_early_check`); D20 keeps non-critical routes up when Redis is down | `data/db/tables.ts`, `proxy.ts` | `tests/threats/D20-redis-down.test.ts` |
| L0-01 (defense in depth, Layer 4) | The login throttle caps password guessing against admin accounts and code guessing at the MFA step | `proxy.ts` | `tests/threats/L1-05-credential-stuffing.test.ts` |
| **L2-11** unverified bank change paid (primary) | Every change, by the employee or an HR Admin, is stored as pending and becomes a verified account only when the employee confirms it through the link sent to their existing email: single-use, 60-minute, hash-stored, bound to tenant, change, and employee; GET only shows; confirm is a POST with the employee's session. Payroll Engine reads verified accounts only | `services/bank-account/bank-account-service.ts`, `services/bank-account/repository.ts`, `app/api/tenants/[tenantId]/bank-account/**`, `app/(employee)/employee/bank-change/[changeId]/page.tsx` | `tests/threats/L2-11-bank-changes.test.ts` |
| L2-11 (defense in depth) | One pending change per employee (partial unique index); resolved changes, used codes, account numbers, and retirements are permanent (triggers); ABA checksum and account-number format; last 4 digits only in responses, notices, and logs; notices on every request, confirmation, rejection, and supersession; D28 makes a change confirmed after approval invalidate the approval | `migrations/0011_bank_change_integrity.sql`, `services/bank-account/validation.ts`, `services/bank-account/notify.ts` | same |
| L0-01 (defense in depth, Layer 7) | A taken-over HR Admin account cannot redirect pay: its changes stay pending, it never receives the link (not in the response, not in any mailbox it can open), it cannot use the confirm route, and contact emails cannot be changed (D31) | `services/bank-account/bank-account-service.ts`, `partners/mock-mail/mail.ts`, `app/dev/outbox/view/route.ts`, `migrations/0011_bank_change_integrity.sql` | same |
| **L2-13** double-paid ACH batch (primary) | One batch per run: idempotency key from tenant + run, `UNIQUE(run_id)` and `UNIQUE(idempotency_key)`, batch ID derived from the key; a retry or concurrent submit returns the existing batch; only a computed run produces one; a timeout resends the same signed bytes | `services/ach/ach-service.ts`, `migrations/0000_tables.sql`, `migrations/0013_ach_integrity.sql` | `tests/threats/L2-13-ach-idempotency.test.ts` |
| L2-13 (defense in depth) | The batch ID is inside the signed file and the bank refuses an ID it has accepted; the approver's action and the internal route accept no body fields; a run is `disbursed` only once its batch is `sent` (trigger) | `partners/mock-bank/server.ts`, `app/api/tenants/[tenantId]/runs/[runId]/disburse/route.ts`, `migrations/0013_ach_integrity.sql` | same |
| **L1-22** ACH batch altered in transit (primary) | The exact file bytes are signed with the key store's `ach-batch` key (Ed25519) after the control totals are checked; the bank verifies the signature against its pinned copy of the public key for the named version and rejects anything altered or signed by another key; PayrollHub re-verifies the stored signature before every send | `services/ach/ach-service.ts`, `services/ach/nacha.ts`, `data/keys/kms.ts`, `partners/mock-bank/server.ts` | `tests/threats/L1-22-ach-signing.test.ts` |
| L1-22 (defense in depth) | mTLS from the setup-generated CA: the bank requires PayrollHub's client certificate (CN `payrollhub-ach`); PayrollHub pins the bank's certificate fingerprint, so even a certificate from the same CA is refused. Private keys never leave `kms.ts`; rotation keeps old batches verifiable | `services/ach/bank-client.ts`, `scripts/lib/pki.ts`, `data/keys/kms.ts` | same |
| **L2-12** bank data in logs (primary) | One redacting logger: sensitive fields at any depth plus digit patterns (routing, account-like runs, SSNs) in every string, including error messages, stack traces, and causes; the console is wrapped so Next.js's own output is redacted; unhandled errors go through it; structured, append-only file | `data/log/logger.ts`, `instrumentation.ts`, `instrumentation-node.ts`, `application/http/route.ts`, `eslint.config.mjs` | `tests/threats/L2-12-log-redaction.test.ts` |
| L2-12 (defense in depth) | ACH Disbursement never logs the file and no route returns it; the file body is encrypted at rest (D15); events log only ids, counts, and totals | `services/ach/ach-service.ts`, `services/ach/repository.ts` | `tests/threats/L2-13-ach-idempotency.test.ts`, `tests/data/encryption-at-rest.test.ts` |
| L0-01 (defense in depth, Layer 9) | Two route groups (Section 2.1): every console page and console API refuses an employee session (403 / redirect home); only the 7 portal routes accept employees, a list fixed in the tests; no payroll action is reachable without an MFA-verified staff session; sign-out plus `no-store` and the back-forward-cache guard leave nothing on screen | `app/(console)/**`, `app/(employee)/**`, `application/auth/dal.ts`, `edge/security-headers.ts`, `app/_components/bfcache-guard.tsx` | `tests/threats/L0-01-route-groups.test.ts`, `e2e/full-flow.spec.ts` |
| L2-01 (defense in depth, Layer 9) | The approval token lives only in React state: never in localStorage, sessionStorage, IndexedDB, or cookies (ESLint ban, checked in a real browser); it is dropped before it is sent; a strict nonce CSP blocks injected scripts that could read it | `app/(console)/approver/approve-run.tsx`, `edge/security-headers.ts` | `e2e/full-flow.spec.ts`, `tests/data/browser-storage.test.ts` |
| L2-11 (defense in depth, Layer 9) | The portal and the HR Admin console show a pending change as unverified; the confirmation page sends no Referer, loads nothing from another origin, removes the token from the address bar, and confirms only by POST; the cross-site check works under `no-referrer` (D39) | `app/(employee)/employee/**`, `app/(console)/admin/admin-console.tsx`, `application/http/forms.ts` | `e2e/full-flow.spec.ts`, `tests/data/route-wrapper.test.ts` |
| Others | *(pending)* | | |

## Deviations from Assignment 5

Kept up to date as each decision is made. Each entry is accepted by the author.

| # | Assignment 5 said | PayrollHub does | Why |
|---|---|---|---|
| DV-01 | PostgreSQL Payroll DB | SQLite via better-sqlite3, accessed through Drizzle ORM | Required stack. The ORM was added for consistent parameterization. |
| DV-02 | Row-level security; each transaction sets the current tenant | Tenant-filtered views for reads, plus `BEFORE INSERT/UPDATE/DELETE` triggers for writes, both keyed on `current_tenant()`, an app-defined SQLite function that reads the connection's current scope. `withTenant()` sets the scope, runs one synchronous transaction, and clears it. With no tenant set, views return nothing and every write is rejected. | SQLite has no RLS. Requires SQLite `trusted_schema` ON (the default); the connection refuses to open otherwise. The base tables can still be read through the raw driver handle, which is why that handle is confined to `data/db/` by ESLint and a test. |
| DV-03 | Per-service least-privilege database roles | One repository module per service (`services/*/repository.ts`), plus ESLint rules that confine the DB handle to `data/db/` | SQLite has no roles. **This weakens the L1-19 defense in depth:** a compromised module runs in the same process as the others. |
| DV-04 | Auth middleware as Next.js Middleware | Next.js 16 renamed Middleware to **Proxy** (`proxy.ts`, Node.js runtime only). Proxy does an optimistic cookie check; a Data Access Layer re-validates the session against the Session table on every request. | The Next.js 16 docs say Proxy should not be the only auth check. This deviates from Section 2.3's "route handlers never re-authenticate". |
| DV-05 | Auth.js sessions | Custom SQLite-backed sessions (Session table with `device_binding` and `revoked_at`) | The Auth.js Credentials provider cannot use database sessions, and it has no built-in TOTP step-up. |
| DV-06 | Separate backend services | Service modules in one Next.js app. Payroll Engine and ACH are also exposed as `/api/internal/*` routes that require a scoped service token. | Keeps the app runnable with one `npm run dev`; the internal routes keep L1-19 testable over HTTP. |
| DV-07 | KMS | Local versioned key store in `data/keys/`. Services ask it to sign and never receive private key material. | No KMS locally. See known limitations. |
| DV-08 | Managed WAF | Request filtering in Proxy (methods, sizes, headers), a global request limit, and the day-early payroll schedule | No managed WAF locally. See known limitations (L0-11). |
| DV-09 | Replay cache (fast store backed by `ApprovalToken.redeemed_at`) | The atomic `redeemed_at` update is the replay check; there is no separate cache | One durable atomic check is simpler and cannot disagree with a cache. |
| DV-10 | Tenant SSO IdP with X.509 signing certificates | Per-tenant stand-in IdP issuing signed JWT assertions; `TenantIdpConfig.signing_cert` stores a public key (PEM) | No real IdP locally. |
| DV-11 | Originating bank over mTLS with a pinned cert | Local mock bank server with a CA generated at setup | No real bank locally. |
| DV-12 | Out-of-band confirmation via the employee's verified contact | A development outbox page stands in for the employee's verified email. Since Layer 7 it is a separate stand-in provider (`partners/mock-mail/`) whose mailboxes open only with their own password (D30) | No mail delivery locally. |
| DV-13 | Central log pipeline, ops-only read access | Local append-only log file with redaction at ingest | Ops-only read access cannot be enforced locally. |
| DV-14 | ER design (Section 3): 12 tables | All 12 tables, plus: `AppUser.password_hash` and `AppUser.totp_secret` (encrypted); `Employee.pay_rate_cents`; `Tenant.withholding_rate_bp` (D16); a `verification_code` table for out-of-band codes; `AchBatch.file_body` (**encrypted at rest** like the bank columns). Rate-limit counters live in Redis, as Section 3.4 states. | Needed to implement login, MFA, pay calculation, out-of-band confirmation, and idempotent batch replay. |
| DV-15 | Gross-to-net pay | Flat withholding rate per tenant; no tax tables or tax forms | Out of scope for the security evaluation. |
| DV-16 | Column types: `decimal`, `bytea`, `timestamp`, `date`, `enum` | Money as integer cents; encrypted fields as BLOBs (AES-256-GCM, bound to tenant, column, and row); timestamps as epoch milliseconds; dates as ISO `YYYY-MM-DD` text; enums as `CHECK` constraints | SQLite has none of these types. Integer cents avoid floating-point rounding. |
| DV-17 | `Tenant` is a platform-level table with no RLS | `Tenant` is read through `v_tenant`, filtered like every other table, so a tenant sees only its own row. `tenant_id` is a short slug (`acme`) that users enter as their organization id at sign-in. | Stricter than Section 3. A slug lets sign-in find the tenant without any cross-tenant lookup. |
| DV-18 | `ServiceGrant` readable only by the Identity & Access database role | `v_service_grant` returns rows, and triggers allow writes, only inside `withPlatform()`, which ESLint allows only in `services/identity/` and `scripts/` | SQLite has no roles; same intent as DV-03. |
| DV-19 | Constraints in Section 3 | Extra constraints: HR Admin and Approver must be MFA-enrolled with a TOTP secret; employees cannot have a password; `scheduled_run_date` must equal `pay_date − 1 day`; net pay between 0 and gross; one pay result per employee per run; `UNIQUE(tenant_id, id)` on parent tables so composite foreign keys can reference them | Pushes L0-01, L0-11, and Section 2.1 rules into the database as a backstop. |
| DV-20 | Employees authenticate at their tenant's IdP | Employee development passwords belong to the stand-in IdP (`MOCK_IDP_DIR`), not to `app_user` (D22) | Keeps the Section 2.1 trust boundary: PayrollHub never holds employee passwords. |
| DV-21 | Sessions (Section 3.1: `session_id` primary key; "bound to the device") | `session_id` stores the SHA-256 of the random cookie token, never the token itself. Device binding is the hash of a separate long-lived `__Host-ph_device` cookie. | A database leak does not yield usable session cookies. A device cookie is the binding a browser can carry; it stops a session cookie replayed on its own, but not one stolen together with the device cookie. |
| DV-22 | Schema (Section 3.1) | Adds `AppUser.totp_last_used_step` and `UNIQUE(tenant_id, sso_subject)` (migration `0002_totp_replay_guard.sql`) | Rejects a TOTP code already used in its time window, and makes an assertion's subject map to exactly one user. |
| DV-23 | SSO assertions arrive from the tenant's external IdP | The stand-in IdP is served by the same app (`/mock-idp/<tenant>`), and the assertion consumer requires a same-origin POST | A real cross-site IdP would also need a state cookie (`SameSite=None`) and an InResponseTo check to stop login CSRF; same-origin posting covers that for the local stand-in. |
| DV-24 | Approval-time MFA step-up (Section 2.1) | A successful step-up also replaces the session with a new id; Layer 6 issues the approval token only after `stepUp()` succeeds | Same session-rotation rule as login, so the session id from before the step-up cannot be reused. |
| DV-25 | Schema (Section 3) | Adds a tenant-scoped `sso_assertion` table (`tenant_id`, `assertion_id`, `expires_at`) with its own view and triggers (migrations `0003`, `0004`) | Single-use SSO assertions (decision in Turn 5). |
| DV-26 | Service tokens are "scoped to a single calling service" (Section 2.4) | Each caller has its own minting handle that always mints as itself (`mint-as-<caller>.ts`). ESLint lets each handle be imported only from inside its own folder, and lets nothing else import `mintServiceToken`, so no module can mint a token as a different caller without breaking a lint rule (`tests/data/mint-handles.test.ts`). The Next.js application layer is caller `bff`. Over HTTP, outside callers cannot mint at all: `/api/internal/*` needs a token signed by the key store. | Residual risk (accepted): in one process, code that deliberately disables the lint rule could still mint as another caller; code review and the lint test are the control, as with DV-03. |
| DV-27 | Per-account **and per-IP** login throttle at the edge (Section 2.2) | Per-account and per-route-class limits only, unless `TRUSTED_CLIENT_IP_HEADER` names a header that a reverse proxy in front of the app overwrites with the real client address | Next.js 16 gives Proxy no unforgeable client IP (see Client IP). Trusting `X-Forwarded-For` would let a client choose its own bucket. |
| DV-28 | Rate limiter at the API Gateway, before Next.js compute | The rate limiter runs in Next.js Proxy, before any route or auth code. Next.js buffers a request body (up to 64 KiB, `proxyClientMaxBodySize`) before Proxy runs. Proxy rejects oversized bodies by `Content-Length` without reading them, and reads a login body only to find the targeted account. | No separate gateway locally. Proxy reads the body with `request.clone()`, which works because Next.js buffers it for the route as well (verified end to end). |
| DV-29 | Schema (Section 3) | Adds a tenant-scoped `service_token_use` table (`tenant_id`, `token_id`, `expires_at`) with its own view and triggers (migrations `0005`, `0006`) | Single-use tokens for the internal money routes (decision in Turn 6). |
| DV-30 | Payroll Approval and Payroll Engine are separate services (Section 2.4) | Payroll Approval's service reads the run through the engine repository and the approver's role through the identity repository, and changes a run's status from draft to approved | Section 3.2 gives the run tables to both services; in one process (DV-06) this is a direct module call, still behind a service token. |
| DV-31 | Approval token "held only in memory for that request" (Section 2.1) | The token goes to the approver's browser in the JSON response and is held in React state (memory) until the engine redeems it (Layer 6); never in a cookie or browser storage | A client-held token lets the run start as a separate, auditable step; the 5-minute expiry and single use limit exposure. |
| DV-32 | Section 3 constraints | Triggers make a run frozen once it leaves draft (pay date, schedule, creator, approver), and approval-token records write-once and undeletable (migration `0007`) | Database backstop for "an approved run can't be edited" and for the redemption record. |
| DV-33 | Rate-limit counters in the edge store (Section 3.4) | Known-device records for D25 live in Redis too: per account, a set of device-cookie hashes, plus one set of all known devices for the MFA step; 90-day expiry | Same store and lifetime model as the counters. |
| DV-34 | "Redemption goes back through Payroll Approval" (Section 2.4) | Payroll Approval redeems in two steps: `prepareRedemption` (async: Payroll Engine's service token and the approval token) returns a ticket only it can create; `redeemTicket` (sync) checks the record and sets `redeemed_at` inside Payroll Engine's transaction. The Layer 5 standalone redemption route was removed. | A token can then never be redeemed without its results being written in the same transaction. |
| DV-35 | Schema (Section 3.2) | Adds `payroll_run.failure_reason` and a tenant-scoped `pay_exception` table (employees a run could not pay), with view and triggers (migrations `0008`, `0009`) | Clear failed state and reported exceptions, as required in Turn 8. |
| DV-36 | One process (DV-06) | The BFF's "Run payroll" reaches Payroll Engine over HTTP at `INTERNAL_API_ORIGIN`, its own server, rather than by a module call. The origin must be a loopback address, or the server refuses to start | The engine is reachable only through `/api/internal/engine` with a single-use service token, as required in Turn 8; the loopback check was required in Turn 9. |
| DV-37 | Schema (Section 3.2) | Adds `bank_account_change.resolution` (`confirmed`, `rejected`, `superseded`) and `resolved_by` (migration `0010`), and integrity rules in migration `0011`: one pending change per employee, permanent resolved changes, used codes, account numbers, and retirements, and an immutable user email | Record who confirmed and why a change closed; database backstops for L2-11. A superseded change keeps status `rejected`, so the schema's status values are unchanged. |
| DV-38 | Confirmation through the emailed link (Section 2.4) | Confirming needs both the link and the employee's own PayrollHub session (SSO) | Possession of the link alone (a forwarded or leaked email) cannot confirm a change. |
| DV-39 | Bank Account service API | A JSON route for an HR Admin to enter a change; the HR Admin console form comes with the consoles in Layer 9 | The admin console is still a placeholder. |
| DV-40 | AchBatch (Section 3.3) | Adds `entry_count`, `total_credit_cents`, `bank_reference`, `rejection_reason` (migration `0012`) and integrity triggers (migration `0013`): insert only for a computed run, signed, with totals equal to its pay results; signed fields immutable; status transitions; no deletes; a run is `disbursed` only after its batch is `sent`; a run failed with `bank_account_changed` cannot be re-approved | Database backstops for L2-13 and L1-22, and a record of what the bank answered. |
| DV-41 | Build, then sign and send, as two stages (Figure 6) | Building and signing happen in one transaction (the batch is stored already `signed`; the `built` status is unused); sending is a separate step that may be retried | A stored, unsigned batch would be one more state to protect; the two stages still guard different threats. |
| DV-42 | The bank verifies the signature and rejects duplicates | The stand-in bank answers a duplicate batch ID with 409 and whether the file is identical; PayrollHub treats an identical duplicate as delivered | Safe retry after a lost response (a timeout), without ever creating a second batch. |
| DV-43 | Bank Account read for ACH | A separate endpoint, `bankAccount.readPayable` (full numbers, verified only), granted to ACH Disbursement alone; Payroll Engine and Payroll Approval keep the numberless `bankAccount.readVerified`. Since Layer 9 also enforced at build time: ESLint lets only ACH import the payable reader and only the Bank Account service import its (decrypting) repository, and a source scan checks the same | Least privilege: only the service that writes the file sees full numbers. |
| DV-44 | Next.js with Cache Components (Layer 0) | Cache Components and its Partial Prerendering are turned off; every page renders per request | A nonce-based CSP needs per-request rendering: a prerendered shell's scripts cannot carry the nonce (Next.js CSP guide). Pages are session-specific and `no-store` anyway. |
| DV-45 | Employee portal: "pay statements and tax forms" (Section 2.1) | Pay statements only | No tax-form data exists in the schema (Section 3), and Turn 11 asked for statements. |
| DV-46 | PayrollRun (Section 3.3) | Adds `computed_at` (migration `0014`) | The approver's review shows the D29 late flag after the fact (computed after the scheduled run date). |
| DV-47 | Bank-change confirmation page | The page reads the link token once, removes it from the address bar, and loads the change through a read-only POST (`/bank-account/changes/<id>/view`, token in the body) | The token never appears in another URL, a server log line, or the browser history after the first load. |

## Known limitations

- **L0-11 (platform-wide outage):** a local app cannot absorb a volumetric flood the way a managed WAF does. The
  controls are request filtering, per-class ceilings, and the day-early payroll schedule. Next.js still buffers up to
  64 KiB of each request body before Proxy runs.
- **What remains of "a random-account flood blocks everyone":** known devices skip the login ceiling at both steps
  (D25), so admins and approvers signing in from a browser they have used before are unaffected. A flood can still use
  up the login ceiling (300 per minute) for up to a minute for:
  - a first sign-in from a new browser, or one whose known-device cookie was cleared or is over 90 days old;
  - employees signing in at the stand-in IdP.

  The approve route and other route classes are unaffected. Per-IP limits behind a trusted proxy reduce this further
  (D26).
- **Day-early schedule (D29):** a run started after its scheduled date is allowed, flagged `late`, and logged; the
  ACH batch may then settle after the pay date.
- **`INTERNAL_API_ORIGIN` must match the port** the app runs on, or "Run payroll" returns 502 (engine unavailable). It
  must also be a loopback address, or the server exits at startup.
- **The development mailbox is a stand-in** for each employee's real email (D13, D30). Its passwords are random
  development values in `.data/dev-credentials.txt`; real deployments send real email to a verified address.
- **Seed staff TOTP secrets are fixed values** (documented here and in `scripts/lib/seed.ts`) so the test suite can
  compute codes; they protect only local development data.
- **Local HTTP:** locally the app is plain `http://localhost`, so there is no HSTS and the CSP omits
  `upgrade-insecure-requests`; a deployment behind TLS adds both.
- **No tax forms** in the Employee portal (DV-45).
- **A bank change confirmed between compute and send forces a new run** (D35): the computed run is closed and HR
  creates a new one, which the approver approves and sends.
- **A user's contact email cannot be changed** (D31). There is no feature for it, and a trigger refuses any change, so
  an employee whose address changes needs it fixed outside the app for now.
- **The bank is a stand-in** (D12): a local HTTPS server with a local CA. Its pinned ACH keys are registered by a
  script rather than an out-of-band exchange with a real bank, and it does not settle money.
- **Logs are a local file** (D14). The logger only ever appends, but the operating system does not stop someone with
  file access from editing it, and read access is not limited to operations roles. A real deployment ships logs to
  append-only (WORM) storage with restricted readers.
- **Redaction is pattern-based for free text:** it masks any run of 7 or more digits (so epoch timestamps or parts of
  hex hashes are masked too), and it cannot recognize an account number shorter than 7 digits in free text unless it
  is in a field from the logging schema. Code still never logs bank details; redaction is the backstop.
- **A confirmation link is a bearer secret in a URL** until used or expired (60 minutes). Only its hash is stored,
  every response sets `Referrer-Policy: no-referrer`, and confirming also needs the employee's own session (DV-38).
- **Lockout on unknown devices (D25):** an attacker can slow an account's sign-in from *new* browsers to one attempt
  per 15 minutes. The real user's known devices keep their own budget.
- **`npm test` needs Redis** for the rate-limiter tests (`docker compose up -d`, or set `TEST_REDIS_URL`).
- **No hardware key isolation:** the local key store keeps private keys on disk, in the same process as the services.
  The field encryption key likewise lives in `.env`.
- **Weaker L1-19 defense in depth:** see DV-03.
- **Raw handle can read base tables:** SQLite cannot deny SELECT on a table to one connection, so isolation for reads
  relies on code never touching the raw handle (DV-02). ESLint, a type restriction, a runtime check in `read()`, and a
  source-scanning test enforce this; the triggers still enforce writes even if all of those are bypassed.
- **Single Redis node:** the rate limiter is shared across all app processes, but Redis itself is not clustered locally.
- **Most service tokens are multi-use for 60 seconds:** only tokens for the internal money routes are single-use.
  Others are bound to one caller, endpoint, and tenant and never leave the server.
- **Step-up code guessing:** the approve route arrives in Layer 6 and is listed in `MONEY_ROUTES` (fail closed). Its
  per-account step-up throttle is added with it.
- **Browser cookie behavior** was verified with an HTTP client against `next start`, not yet in a real browser; that
  check comes with the client apps in Layer 5.
