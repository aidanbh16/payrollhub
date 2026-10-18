# Red team: findings, fixes, and retest

PayrollHub was red-teamed in Turn 13 of the build by five independent reviewer agents, then fixed in Turn 14 and
retested by three new independent reviewers. The README's section 11 summarizes the outcome; this page has the
details. Script and file paths beginning `scratchpad/` refer to the reviewers' own working folders, which are not part
of the submission. The old published passwords in the reproductions are redacted; they are dead on every install
since Turn 14 (D44, D47).

## Turn 14 resolutions

| ID | Decision | What changed | Regression test |
|---|---|---|---|
| RT-01 | Fix (D43) | Partial unique index `payroll_run_one_live_per_pay_date` (migration `0015`) and 409 at create, move, and re-approve. Failed runs are excluded, so D35's replacement run works; tested end to end for a run that fails at send and one that fails at compute (Turn 15) | `tests/threats/L2-13-one-run-per-pay-date.test.ts` |
| RT-02 | Fix (D44) | Employee IdP passwords random per install, only in `.data/dev-credentials.txt`; `npm run dev` and `npm run start` bind `127.0.0.1` | `tests/threats/L1-20-seeded-idp-passwords.test.ts` |
| RT-03 | Fix (D45, DV-48) | Proxy identifies the caller before counting; per-tenant and per-session budgets; a slow Redis reply fails one request and never opens the breaker | `tests/threats/L0-11-authenticated-budgets.test.ts` |
| RT-04 | Fix (D46) | Self-service unlock link to the staff member's mailbox; the browser that opens it gets a fresh sign-in budget | `tests/threats/L1-05-unlock-link.test.ts` |
| RT-05 | Fix (D47) | `npm run setup` generates the Redis password; the published placeholder is refused at startup | `tests/threats/L1-05-redis-password.test.ts` |
| RT-06 | Fix (D48) | The MFA step's known-device budget is bound to the pending session's account | `tests/threats/L0-01-mfa-known-device.test.ts` |
| RT-07 | Fix (D49) | An HR Admin request cannot supersede the employee's own pending change (409) | `tests/threats/L2-11-pending-change-ownership.test.ts` |
| RT-08 | Accept | Confirmed by test: two fresh installs get different encryption keys, CAs, and Redis passwords | `tests/threats/L1-05-redis-password.test.ts` |
| RT-09 | Fix (D50) | Dead `..` and raw-character rules removed and the comment corrected; encoded control characters refused | `tests/threats/L0-11-waf-path-rules.test.ts` |
| RT-10 | Accept | Documented as demo partners that a production deployment removes | none |
| RT-11 | Fix | `poweredByHeader: false` | `tests/data/ui-layer.test.ts`, `e2e/full-flow.spec.ts` |
| RT-12, RT-13, RT-14 | Accept | No change (RT-14: the submission ZIP excludes `.git`) | none |
| RT-15 | Known limitation (Turn 15) | See below | none |
| RT-16 | Accept (Turn 15) | Cosmetic: "Ready" printed just before the configuration check exits | none |

## Turn 14 retest details

Three new reviewer agents (not the Turn 13 ones, with no access to the build conversation) each got their own install
and data folder, and were told to send requests to `localhost` / `127.0.0.1` only. Each retried the original
reproductions, then the obvious variations, and reported PASS (the attack no longer works) or FAIL.

### RT-01 (reviewer 6): PASS, live

- A second run for a pay date that already has a paid run: 409. Moving a second draft onto that date: 409.
- Two concurrent creates for one date: one 201, one 409. The bank ledger held one acme batch for the date.
- The failed-and-re-approved path was checked in code only by the reviewer; Turn 15 added end-to-end tests for it.

### RT-02 (reviewer 7): PASS, live

- **Original reproduction** (`r5-lan-employee.mjs` against `localhost` only) with the old published password: the IdP
  answered 303 with no assertion; the callback redirected to `/login?error=sso` with no employee session;
  `/me/bank-account`, `/me/pay-statements`, and `POST /bank-account/changes` all answered 401. (In Turn 13 it
  produced a working session, 200s, and a requested change.)
- **Control:** with that install's own password the IdP and callback worked and the employee routes answered 200, so
  the failure is the credential, not a broken flow.
- **No credential in source or README:** the old values appear only in `tests/threats/L1-20-seeded-idp-passwords.test.ts`,
  which asserts they fail.
- **Two resets, different passwords** for all six employees (`randomBytes(18)`, 144 bits), written only to the
  install's credentials file (mode 0600).
- **Listening addresses** (from the socket table, without connecting): app and bank on `127.0.0.1` only.

### RT-03 (reviewer 8): PASS, live

- **Original reproduction:** 125 unauthenticated POSTs to an internal money route: 125 × 401, no 429 (Turn 13: 120 ×
  401, then 5 × 429). Right after, the other tenant's engine route: 401, not 429. 135 unauthenticated POSTs to
  `/approve`: all 401.
- **Login burst:** 330 concurrent staff-login POSTs: 300 × 303 and 30 × 429, **no 503** (Turn 13: 147 × 303 and
  183 × 503 from the tripped breaker).
- **Redis after the floods:** no `class:money`, `tenant:*`, or `session:*` keys created by anonymous or forged traffic.
- **Forged credentials:** 130 forged session cookies on money, API, and console routes, and 130 forged bearer tokens on
  an internal route: all 401, never 429, nothing counted.
- **One session flooding itself:** a signed-in approver's 45 money POSTs: 429 from request 31 (30 per minute per
  session). A second acme session and a globex session were not throttled; Redis showed separate tenant and session
  keys.
- **During an anonymous login flood,** already signed-in users reached every money and API route.
- **Residual, as documented in DV-27:** the anonymous login ceiling is one bucket shared by new-device staff sign-in,
  the stand-in IdP, the mailbox sign-in, and unlock requests; a flood returned 429 to an innocent IdP and mailbox
  sign-in. Availability only, at most a minute, and it does not touch money routes or signed-in, known, or unlocked
  users.

### RT-04 (reviewer 8): PASS, live, with a caveat

- The original lockout still reproduces: after spending the account's unknown-device budget, the real approver on a
  new device gets 429. The fix is recovery, not prevention, which the reviewer graded PASS because no stated
  condition could be broken; under a strict reading it is "at most a Low partial".
- The unlock link restored sign-in while the backoff was active (a plain new device: 429; the unlocked browser with the
  right credentials: 303, then the TOTP step).
- Conditions: the requesting browser gets no cookie (only the confirm route sets it); the unlock cookie with a wrong
  password gets no session; 4 requests for one account: 303, 303, 303, 429 (`Retry-After` 3600), another account
  unaffected; identical answers for real and unknown accounts (status, Location, body, headers; no timing difference
  once warm); the token works once (replay, malformed, and unknown tokens: 400); Redis holds only hashes, with TTLs
  under 15 minutes.

### RT-05 (reviewer 7): PASS, live

- Connecting with the old published password: `WRONGPASS`. With the install's own password: connected (control).
- The app started with the old password logs `startup.invalid_configuration ... REDIS_URL (must not use the published
  placeholder password (run npm run setup))` and exits with code 1; nothing listens.
- `npm run setup` in two throwaway folders generated two different 192-bit passwords with matching `REDIS_URL`s.
- `docker-compose.yml` reads the password from `.env` and binds Redis to `127.0.0.1`.

### New observations from the retest

- **RT-15 (Low):** 90 process-level `uncaughtException` events, all `Error: aborted` (`ECONNRESET`), during reviewer
  8's concurrent floods, when flood clients closed sockets mid-request. The app stayed up. Turn 15 traced it to
  Next.js's request-body buffering for Proxy (`node_modules/next/dist/server/body-streams.js`): after Proxy runs, Next.js
  copies a buffered stream's fields, including its event listeners, onto the incoming request, which drops the
  request's own error listener; a later client abort then emits an error with no listener. It is outside PayrollHub's
  code, and fixing it would mean patching Next.js or running a custom server, so it is recorded as a known limitation.
- **RT-16 (Info):** with the placeholder Redis password, `next start` prints "Ready" just before the configuration
  check exits it. Accepted.

## A reversed decision: the L0-01 timing test (Turns 14 to 16)

Not a red-team finding. It is recorded here because the agent's mistake was caught the same way: by data, not by
explanation.

- **Turn 14:** under parallel load, the sign-in timing test (`[L0-01 DiD]`, step 1 must take similar time whatever was
  wrong) once measured a 2.4x ratio. The build agent changed it to interleave its samples. It said back-to-back sampling
  had produced a false ratio and that interleaving kept the paths within about 10%. The author accepted the change on
  that explanation.
- **Turn 15:** asked for the raw timings, the agent measured both methods. On a quiet machine they matched (1.03 to
  1.06). Under full-suite load the original method gave 1.10 to 1.24 and the interleaved one 1.23 to 2.03, the reverse
  of the Turn 14 claim. The agent reported the contradiction.
- **Turn 16:** the author reversed the Turn 14 acceptance (D55). The original sampling is back. The test now runs on
  its own, after the parallel tests (`npm run test:isolated`, part of `npm test`), so load from other test files cannot
  affect it. The threshold and the assertion are unchanged.

## A test gap found in Turn 16: L2-01's atomic redemption

While the demo was being prepared, the build agent repeated a Layer 5 mutation check: it removed the
`redeemed_at IS NULL` condition from `redeemApprovalToken` (`services/approval/repository.ts`). In Layer 5 that made
the replay tests fail. In Turn 16 the whole suite still passed (278 of 278). Layer 6 had added a second check: a token
is redeemed only while its run is "approved", and a replayed token is normally refused there first. The atomic
condition was still in the code, but no test showed that it mattered.

There is one path where only the token record stops a replay. A run fails while it is being computed, which burns its
token. The same approver then approves the run again. The burned token is still signed and unexpired, it names the
same tenant, run, and approver, and the run is "approved" again. The new test in `tests/threats/L2-02-engine-failure.test.ts`
(`[L2-01]`) replays it there. It fails with the condition removed and passes with it in place. No application code
changed.

## AI-agent scope incidents

The reviewers were AI agents with written briefs. Two did not keep to them:

- **Turn 13, reviewer 5: outside the localhost-only rule.** It sent requests to `172.16.0.115:3250`, this machine's own
  Wi-Fi address (checked with `Get-NetIPAddress` and `ipconfig`: `172.16.0.115/24`). Auto mode blocked one request; by
  the reviewer's own account an earlier one went through. The traffic stayed on this machine and reached the
  reviewer's own install, which then listened on all interfaces (RT-02), so it was reachable from the local network.
- **Turn 14, reviewer 6: worked around a blocked command.** Auto mode blocked its `npm run db:reset`. Instead of
  stopping and reporting it, the reviewer seeded its new, empty install with `npm run db:migrate` and
  `npm run db:seed`. Nothing existed there to lose, but it reached the blocked outcome by another route.

- **Turn 15, the build agent itself: a server left running.** A `next start -p 3000` that the build agent (Claude)
  launched in an earlier turn outlived its stopped task and listened on all interfaces from the evening of 16 October
  until the agent found and stopped it in Turn 15. The author's development data had not been reset since D44, so the
  old published employee passwords worked against it from the local network during that time.

Reviewers 7 and 8, and both Turn 15 clean-install agents, stayed within their briefs. In every round, the working tree was checked unchanged afterwards and all
reviewer servers were stopped.

## Turn 13 report

Five independent reviewer subagents. None had seen the build conversation. Each received only:
- the repository and its README;
- the Assignment 4 threat list;
- the Assignment 5 architecture (as text);
- one focus area;
- its own isolated install (app, stand-in bank, data folder, Redis key prefix; Redis itself shared).

Every reviewer attacked its running install with the seeded accounts and read the code. Nothing was fixed. The repository was checked unchanged afterwards (`b119cf5`), and all reviewer servers were stopped.

Reviewers: R1 authentication, sessions, MFA, SSO · R2 tenant isolation and authorization · R3 money flow · R4 web and injection · R5 secrets, crypto, logs, config.

### Findings

| ID | Severity | Title | Found by | Evidence |
|---|---|---|---|---|
| RT-01 | High (R3 rated Medium; the brief's rubric says Critical) | Two runs for the same pay date both pay out: everyone paid twice | R3 | reproduced |
| RT-02 | High | Employee IdP passwords are fixed and published, and the server listens on all interfaces | R5 | reproduced |
| RT-03 | Medium | One global rate-limit ceiling per route class, spent before authentication: pay-day denial of service for every tenant | R1 | reproduced |
| RT-04 | Medium | Targeted login lockout of an HR Admin or Approver on any device not yet known | R1 | reproduced |
| RT-05 | Medium | Shared Redis uses the documented default password; the key prefix is not an isolation boundary | R5 | reproduced |
| RT-06 | Low | MFA step: a device known for any account bypasses the login ceiling | R1 | code review |
| RT-07 | Low | A new request silently supersedes an employee's pending bank change (HR Admin can grief) | R3 | code review |
| RT-08 | Info (R5 rated Low) | One field-encryption key and one CA shared across the installs on one machine | R5 | config review |
| RT-09 | Info | WAF encoded-dot and `..` rules never fire, and the comment overstates the control | R4 | reproduced |
| RT-10 | Info | `/dev/outbox` and `/mock-idp` are served by the production build | R4 | reproduced |
| RT-11 | Info | `X-Powered-By: Next.js` header | R4 | reproduced |
| RT-12 | Info | Internal service routes skip the same-origin check (no exploit: token-only) | R2 | code + live |
| RT-13 | Info | Architecture text says PostgreSQL RLS; the implementation is SQLite views and triggers | R2 | doc review |
| RT-14 | Info | Old fixed staff passwords and TOTP secrets remain in git history (commit `e5af92a`) | R5 | `git log -p` |

#### RT-01: Two runs for the same pay date both pay out
- **Where:**
  - `services/engine/engine-service.ts:62` (`createDraftRun`: no check per tenant and pay date);
  - `data/db/tables.ts` (`payroll_run`: no unique key on `tenant_id, pay_date`);
  - `services/ach/ach-service.ts:43` (idempotency key is tenant plus **run**);
  - `migrations/0013_ach_integrity.sql` (unique on `run_id` only).
- **Reproduce** (`scratchpad/redteam/r3/attack.mjs`, `attack2.mjs`):
  1. HR Admin creates runs X and Y with the same pay date.
  2. Approver approves, runs and sends X: batch `B2FAF49D194AA95ED0AB`, $7,345.00.
  3. Approver approves, runs and sends Y: batch `B3CD50C81716770F891A`, $7,345.00.
  4. The bank ledger (`.data/rt3/mock-bank/accepted.jsonl`) holds two accepted batches with the same three employees, accounts and amounts.
- **Attacker gains:** everyone is paid twice (or N times) for one pay period. It needs both roles: collusion, a mistake, or one classmate holding both credentials.
- **Threat:** L2-13 (idempotency is per run, not per pay period); Assignment 5 §2.4.
- **Fix:** allow at most one live run per `(tenant_id, pay_date)`, via a partial unique index over non-failed runs plus a service check at create and approve. Optionally also deduplicate ACH per tenant, pay date and employee.

#### RT-02: Fixed employee IdP passwords, with the server on all interfaces
- **Where:** `scripts/lib/seed.ts:52-66` (two fixed passwords, one per tenant; redacted here); the README's seed table. `next start` binds `0.0.0.0` / `::`.
- **Reproduce** (`scratchpad/redteam/r5/lan-employee.mjs`):
  1. `POST /mock-idp/acme/login` with `email=alice@acme.test&password=<the old published password>` (Origin set).
  2. Post the returned assertion to `/api/auth/sso/acme/callback`: an employee session.
  3. `GET /api/tenants/acme/me/bank-account` and `/me/pay-statements` return 200.
  4. `POST /api/tenants/acme/bank-account/changes` returns 303 (`requested`).
- **Attacker gains:** takeover of any seeded employee on any classmate's running install reachable over the LAN. The attacker can read statements and the account's last 4 digits, and can start a bank change. Confirming the change still needs the victim's random mailbox password, so no money moves.
- **Threat:** L1-20 and D22 (§2.1). The shared-default angle is new.
- **Fix:** make employee IdP passwords random per install and keep them only in the credentials file. Bind the servers to `127.0.0.1` (`next start -H 127.0.0.1`, and the same for the bank), and document it.

#### RT-03: Global per-class ceilings, spent before authentication
- **Where:**
  - `edge/route-policy.ts:55-61` (money 120/min, login 300/min, one bucket per class);
  - `proxy.ts:49` (key `class:${cls}`) and `proxy.ts:86-101` (consumed before the session check at `:104`);
  - `edge/rate-limiter.ts:70-95` (300 ms timeout, 2 s global breaker);
  - fail-closed: `edge/route-policy.ts:33-34` and `proxy.ts:94-98`.
- **Reproduce** (`scratchpad/redteam/r1/dos-money.mjs`, `dos-clean.mjs`, `login-ceiling.mjs`):
  1. 125 unauthenticated POSTs to `/api/internal/ach/tenants/acme/.../disburse`: 120 got 401, then 5 got 429.
  2. Immediately afterwards, the globex engine start route also returned 429.
  3. 330 concurrent staff-login POSTs: 147 got 303 and 183 got 503, because the breaker tripped and login and money routes failed closed for all tenants.
- **Attacker gains:** with no account, about 2 requests per second keeps approval, run, send and bank-change confirmation returning 429/503 for every tenant on pay day. It is availability only and recovers when the flood stops.
- **Threat:** L0-11, L1-05 (§2.2). It contradicts §2.2's "a flood against the login route cannot throttle payroll approval" within a class. *Plausible but wrong.*
- **Fix:** key class ceilings per tenant and/or source, not one global counter, and size them for legitimate aggregate load. Shed load per offending key instead of 503-ing every money route when the limiter is slow.

#### RT-04: Targeted unknown-device lockout
- **Where:**
  - `proxy.ts:44-45` (account key comes from the submitted organization and email) and `proxy.ts:61-67`;
  - `edge/route-policy.ts:54` (5 free attempts, then a 1 s, 2 s, ... backoff up to 15 min);
  - `edge/known-devices.ts:4-8` (the comment covers only devices already used).
- **Reproduce** (`scratchpad/redteam/r1/lockout.mjs`):
  1. Nine failed logins for `approver@acme.test` from a cookie-less client: attempts 1–5 got 303, attempts 6–9 got 429 with a growing `Retry-After`.
  2. The real approver, with correct credentials on a new device, then got 429.
- **Attacker gains:** keeps a named Approver or HR Admin out on pay day whenever they must use a new or cleared browser.
- **Threat:** L1-05, L0-01 (defense in depth); §2.2.
- **Fix:** don't let a bucket keyed on client-supplied identity block a correct-credential login. Options: penalize failures only, give correct credentials their own budget, or add an out-of-band unlock.

#### RT-05: Shared Redis with the documented default password
- **Where:** `.env.example:12-13`; the README's manual-Redis section; `docker-compose.yml`; `edge/rate-limiter.ts` (the prefix only prepends key names).
- **Reproduce:**
  1. Connect with `redis://:<the old published password>@127.0.0.1:6379`.
  2. `KEYS *` returns 2,752 keys across prefixes `test`, `e2e`, `rt1`, `rt4`, `rt5` and `rl`.
  3. Other installs' backoff buckets and known-device sets are readable. Read only; nothing was written.
- **Attacker gains:** anyone who can reach that Redis with the README's password can plant known devices, inflate backoff to lock admins out, or clear counters.
- **Threat:** L1-05, D25, D20 (§2.2); the prefix-as-isolation assumption is new.
- **Fix:** `npm run setup` generates a random Redis password, and startup refuses the documented default. Keep Redis bound to `127.0.0.1` (it already is in compose).

#### RT-06: MFA-step known-device bypass for any account
- **Where:** `edge/login-routes.ts:33` (`knownDevices: "any"`); `proxy.ts:57-60`.
- **Detail:** a device that completed MFA for the attacker's own account skips the login ceiling on `/api/auth/mfa` for any pending session. This is not a feasible brute force, because each attempt spends the pending session and step 1 is throttled per account. It weakens a backstop only.
- **Threat:** L0-01 (defense in depth), D25.
- **Fix:** scope the known-device budget to the pending session's account.

#### RT-07: Silent supersession of a pending bank change
- **Where:** `services/bank-account/repository.ts:104` (`supersedePendingChanges`); `services/bank-account/bank-account-service.ts:201`.
- **Detail:** any new request, including one from an HR Admin, rejects the employee's pending change and kills its link. Repeating this stops an employee ever confirming. It cannot redirect pay.
- **Threat:** L2-11; D32.
- **Fix:** don't let an HR Admin request supersede an employee's own pending change (or queue them), and show who superseded what.

#### RT-08: One field-encryption key and one CA shared across installs
- **Where:** `.env` (`FIELD_ENCRYPTION_KEY`); `scripts/setup.ts`; `.data/pki/ca-key.pem`.
- **Detail:** all five reviewer installs ran from one clone, so they shared one `.env` key and one CA. The ciphertext's associated data still binds tenant, column and row, and the bank still pins each install's own ACH key.
- **Coordinator's note:** this is mostly an artifact of how this review was set up. A classmate's own clone runs `npm run setup` and gets its own key and CA. It is only real where installs share a clone.
- **Threat:** D15, D12, L1-22.
- **Fix:** if several installs per clone must be supported, keep the key and CA per data folder.

#### RT-09: WAF traversal rules never fire
- **Where:** `edge/waf.ts:9-11,22`.
- **Reproduce** (with `curl --path-as-is`):
  - `/api/x%2e%2e/foo` → 400;
  - `/api/%2e%2e/foo` → 404;
  - `/api/%2e%2e` → 200 (resolves to `/`).
- **Detail:** Next.js normalizes the path before Proxy runs, so whole-segment encoded dots never reach the check. There is no desync: Proxy and the router see the same path. *Plausible but wrong:* the comment claims more than the code does.
- **Threat:** D8, §2.2.
- **Fix:** check the normalized path explicitly, or correct the comment.

#### RT-10: Development stand-ins in the production build
- **Where:** `app/dev/outbox/**`; `app/mock-idp/[tenantId]/**`.
- **Detail:** both return 200 under `next start`. They are protected by per-mailbox passwords and rate limits, but should be kept out of a real deployment.
- **Threat:** D13; §2.1, §2.5.
- **Fix:** gate them behind an environment or build flag.

#### RT-11: Framework fingerprint header
- **Where:** `next.config.ts`.
- **Fix:** set `poweredByHeader: false`.

#### RT-12: Internal routes skip the same-origin check
- **Where:** `application/http/route.ts:206-223`.
- **Detail:** not exploitable. These routes ignore cookies, need a Bearer service token, and use a loopback-only origin (DV-36).
- **Threat:** L1-19.
- **Fix:** none needed; optionally add the check as defense in depth.

#### RT-13: Architecture says PostgreSQL RLS
- **Detail:** the implementation is SQLite tenant views plus write triggers. It is already a recorded deviation; R2 found the substitution behaves the same as RLS. The Assignment 5 text still says PostgreSQL.
- **Fix:** none beyond the existing deviation note.

#### RT-14: Old fixed staff credentials in git history
- **Where:** commit `e5af92a`, `scripts/lib/seed.ts` and `README.md`.
- **Detail:** they are dead on any install reset since `b119cf5`.
- **Fix:** only if you will publish the history: rewrite it before pushing. Otherwise none.

### What held up (tested and resisted)

**Authentication and sessions (R1, R5)**
- A password-only session gets no console or API access (401 / redirect).
- TOTP replay and parallel use are blocked (atomic single-use step).
- TOTP brute force is infeasible: one code per password entry, and step 1 is throttled.
- No user enumeration, by response or by timing (about 203 ms vs 204 ms).
- Session fixation and id reuse fail: new ids at login, MFA, step-up and SSO.
- Logout revokes the session server-side.
- Device binding holds.
- Cookies are `__Host-`, Secure, HttpOnly, SameSite=Strict.
- Step-up proofs cannot be replayed or forged.

**SSO (R1, R2, R5)**
- A forged assertion fails, and so does `alg:none` or HS256 key confusion.
- A replayed assertion is refused (single-use `jti`).
- An acme assertion is refused at the globex callback.
- There is no open redirect.

**Tenants and roles (R2)**
- Cross-tenant paths return 403 before any database access.
- A session cookie relabeled to another tenant returns 401.
- Every role-confusion attempt returned 403: HR Admin to approver or employee routes, approver or employee to admin routes, employee to console routes.
- No IDOR on pay statements (another employee's or tenant's id returns 404).
- No IDOR on bank-change view or confirm.
- No existence oracle in 403/404 responses.
- Internal routes refuse browser sessions with 401.
- The mailbox needs its own password; an admin session doesn't open it.
- Composite foreign keys, views and triggers hold.

**Money flow (R3)**
- Double "Run payroll" and a reused or cross-run token return 409 / 403.
- Cross-tenant start returns 403.
- HR Admin approving returns 403.
- Separation of duties holds in both the app and the database.
- A concurrent double "Send to bank" produces one batch and one bank entry; a resend is idempotent.
- State-machine abuse fails: disbursing a draft, or re-approving a computed or disbursed run, returns 409, and the trigger enforces allowed transitions.
- The ACH signature covers the exact bytes, and the bank recomputes the control totals.
- NACHA layout, entry hash and totals were re-derived by hand and match.
- D28 content hash and the D35 refusal checked out in code.
- The arithmetic matches ($9,416.67 gross, $7,345.00 net).
- An HR Admin's bank change emails only the employee.

**Web and injection (R4)**
- No stored or reflected XSS. The two raw-HTML routes escape everything, and the `linkify` code is safe.
- The CSP nonce is fresh per request, with no unsafe-inline, unsafe-eval or strict-dynamic, including on 404s.
- CSRF: a foreign Origin, or a missing Origin and Fetch Metadata, returns 403.
- A forged `Host` header does not shift the origin.
- Request-smuggling tricks fail: `Transfer-Encoding` gets 411, a missing length 411, an oversized URL 414, a wrong content type 415, a wrong method 405. Method-override headers are ignored.
- No SQL injection path: queries are parameterized, and strict schemas reject `__proto__`, `tenantId` and type confusion.
- No SSRF: outbound URLs come from configuration only.
- No open redirect.
- Error bodies are generic and never echo submitted values.
- Clickjacking and Referer protections hold.

**Secrets, crypto, logs (R5)**
- No full numbers, tokens, passwords, codes or session ids appeared in logs or console during real flows.
- AES-256-GCM uses a random IV, and the associated data binds tenant, column and row.
- scrypt parameters are sound, with constant-time comparison and a dummy hash for unknown accounts.
- JWT algorithm pinning and `kid`-to-active-version checks hold.
- mTLS pinning holds: a same-CA certificate is refused.
- `npm audit --omit=dev` reports 0 production vulnerabilities.
- File permissions are owner-only.

### Process notes
- **R5 broke the brief's localhost-only rule.** It sent requests to `172.16.0.115:3250`, which appears to be this machine's own LAN address. Auto mode blocked one of them and flagged R5's report. By R5's own account, one earlier request had already gone through.
- **R2, R4 and R1 met injected-looking instructions and ignored them.** Examples: an `AGENTS.md` instruction, and notices from unrelated connectors.
