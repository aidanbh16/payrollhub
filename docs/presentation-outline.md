# PayrollHub: presentation outline

The author's talk notes for the Project 2 presentation. **Not part of the submission ZIP** (D56):
`npm run submission` leaves this file out. The study notes behind it are in [code-walkthrough.md](code-walkthrough.md).

Project 2 asks the presentation to cover four things. This outline covers them in this order:

| Part | Project 2 asks for | Section here |
|---|---|---|
| (b) | How the build follows the Assignment 5 architecture, and the key deviations | [2](#2-architecture-and-how-the-build-follows-assignment-5-15-min) |
| (a) | All 15 threats and where each is addressed | [3](#3-the-15-threats-and-where-each-is-addressed-3-min) |
| (c) | Specific code explained, including AI-generated code | [4](#4-five-pieces-of-security-critical-code-3-min) |
| (d) | How AI was used: where it helped, where it was wrong, where it was overridden | [6](#6-the-ai-pair-programming-story-25-min) |

## Timing (core talk: about 14 minutes)

| # | Segment | Minutes | Running total |
|---|---|---|---|
| 1 | Opening: what PayrollHub is | 0.5 | 0.5 |
| 2 | Architecture and Assignment 5, layer by layer; key deviations | 1.5 | 2 |
| 3 | The 15 threats (four groups, one shown in code per group) | 3 | 5 |
| 4 | Five pieces of code (two shown live, three from the slide) | 3 | 8 |
| 5 | Live demo | 3.5 | 11.5 |
| 6 | The AI pair-programming story | 2.5 | 14 |
| 7 | Close | 0.5 | 14.5 |

If time runs short, cut segment 4 to the two live pieces (withTenant and the engine transaction) and skip demo
step 7. The appendices are for questions only.

## Before the talk

**The day before:**

```bash
docker compose up -d
npm test                  # parallel tests, then the isolated L0-01 timing test
npm run test:e2e          # also saves step screenshots in .data/e2e/screenshots/
npm run traceability
```

Copy `.data/e2e/screenshots/` and the terminal output of all three runs to a folder outside the project. They are
the fallback if the live demo fails.

**30 minutes before:**

```bash
docker compose up -d      # Redis
npm run db:reset          # fresh data: new passwords, TOTP secrets, mailbox passwords
npm run build             # production build: pages load fast during the demo
```

Then open three terminals in the project folder:

- **Terminal 1:** `npm run bank` (the stand-in bank on https://localhost:8443).
- **Terminal 2:** `npm run start` (PayrollHub on http://localhost:3000). Wait for `Ready`, then load
  http://localhost:3000/login once.
- **Terminal 3:** commands during the demo: `npm run -s totp -- <email> --code-only` and the log search.

Open three browser windows: a normal window (HR Admin), a private window (Approver), and a second profile or another
browser (Alice, employee). Keep `.data/dev-credentials.txt` open on the laptop screen only, not the projector.

Have these files open in the editor, in tabs, in this order: `data/db/tenant-scope.ts`, `data/db/scope-runner.ts`,
`application/http/route.ts`, `services/approval/repository.ts`, `services/approval/approval-service.ts`,
`services/engine/engine-service.ts`, `services/ach/ach-service.ts`, `migrations/0001_tenant_isolation.sql`.

## 1. Opening (0.5 min)

- PayrollHub is a multi-tenant payroll platform: an HR Admin creates a run, a Payroll Approver approves it with a fresh
  MFA code and sends the payment batch to the bank, and employees read pay statements and change their bank account.
- It was built from my own earlier work: the Project 1 threat model, the 15 prioritized threats from Assignment 4, and
  the Assignment 5 architecture. The stack is Node.js, SQLite, Next.js 16, and React 19.
- Every one of the 15 threats has a control in code or configuration. The control has a test tagged with the threat's
  ID, and the test was shown to fail when the control was broken on purpose.

## 2. Architecture and how the build follows Assignment 5 (1.5 min)

**Slide: the five Assignment 5 layers next to the folders** (README section 1 and section 8):

| Assignment 5 layer | Folder | One sentence |
|---|---|---|
| Client apps (§2.1) | `app/(console)/`, `app/(employee)/` | Two route groups; an employee session is refused on every console route |
| Edge security (§2.2) | `proxy.ts`, `edge/` | Request filtering and a Redis rate limiter run before any route code |
| Application layer (§2.3) | `application/` | One route wrapper; sessions and MFA checked in the Data Access Layer |
| Core services (§2.4) | `services/` | Identity, Approval, Engine, Bank Account, ACH; each call carries a scoped service token |
| Data, secrets, partners (§2.5) | `data/`, `migrations/`, `partners/` | Tenant-filtered views and triggers, a key store, a redacting logger, stand-in partners |

**Built bottom-up in 11 layers, one per turn** (README section 8): 0 foundation, 1 data, 2 identity, 3 route
wrapper and service tokens, 4 edge, 5 approval, 6 engine, 7 bank account, 8 ACH and logs, 9 UI, 10 threat tests. After
that came the red team, the fixes, and the clean-install check. I approved each layer before the next one started.

**Key deviations (say these three; the full list is DV-01 to DV-49):**

- **SQLite instead of PostgreSQL row-level security (DV-01, DV-02).** SQLite has no RLS. Instead, every table has a
  view filtered on `current_tenant()` (the read policy) and BEFORE INSERT/UPDATE/DELETE triggers that abort on a tenant
  mismatch (the WITH CHECK policy). With no tenant set, views return nothing and every write is refused, which is the
  same fail-closed behavior as RLS. Open `migrations/0001_tenant_isolation.sql` and show one view and one trigger.
- **Modules instead of separate services (DV-03, DV-06, DV-26).** The five services are modules in one Next.js app, so
  there are no network boundaries or database roles between them. To keep L1-19 meaningful, every service function
  still verifies a scoped, signed service token checked against ServiceGrant. Payroll Engine and ACH are also reached
  over HTTP at `/api/internal/*`, with single-use tokens. Each service can mint tokens only as itself (ESLint).
  Residual risk, stated plainly: any module in the process could still call the minting code directly.
- **Local stand-ins (DV-07, DV-10 to DV-13).** A local versioned key store instead of KMS; per-tenant stand-in IdPs
  that sign JWT assertions instead of SAML; a development mailbox instead of email; a stand-in bank with mutual TLS and
  a CA generated at setup. Each is a demo partner that a production deployment removes (RT-10).

## 3. The 15 threats and where each is addressed (3 min)

**In the talk:** show the generated table (README section 7, made by `npm run traceability -- --write-readme`),
then go through the threats in four groups, opening one file per group. The full table below is for reference and
questions.

**Group 1: tenant isolation (L1-14, L2-16, L2-04).** Open `migrations/0001_tenant_isolation.sql` (already shown),
then `application/http/route.ts`, function `requireSameTenant`: a path tenant that differs from the session's gets a
403 and is never corrected.

**Group 2: the money path (L2-01, L2-02, L2-18, L2-13, L1-22, L2-11).** Show this in the code segment (section 4):
approval token, engine transaction, ACH batch.

**Group 3: identity (L0-01, L1-20, L1-19).** Open `application/auth/dal.ts`, line `if (isPrivilegedRole(claims.role)
&& !claims.mfaVerifiedAt) return null;`. MFA is checked in the Data Access Layer on every request, so no route can
opt out.

**Group 4: availability and data exposure (L1-05, L0-11, L2-12).** Open `edge/rate-limiter.ts`, the `CONSUME` Lua
script: every bucket for a request is updated in one atomic Redis step, so concurrent attempts cannot race past a
limit.

### Reference: all 15 threats

In Assignment 4 rank order. "Test" names the test file and the title of the test that attacks the primary control.

| # | ID | Threat | Primary control: file to open | What to show | Test that proves it |
|---|---|---|---|---|---|
| 1 | L1-05 | Credential stuffing on the login route | `edge/rate-limiter.ts` (`CONSUME`), `proxy.ts` | The Lua script; per-account key = tenant + trimmed, lowercased email, hashed; runs in Proxy before any password check; two budgets per account (D25) and the unlock link (D46) | `tests/threats/L1-05-credential-stuffing.test.ts`: "concurrent attempts cannot race past the limit", "a flood against one account hits the ceiling no matter what IP headers the client sends" |
| 2 | L1-14 | Cross-tenant reads | `migrations/0001_tenant_isolation.sql`, `data/db/tenant-scope.ts` (`read`) | `v_<table>` views on `current_tenant()`; `read()` accepts only views | `tests/threats/L1-14-cross-tenant-reads.test.ts`: "with no tenant set, every view returns nothing although the base tables hold rows"; `tests/data/async-interleaving.test.ts` |
| 3 | L2-04 | Path tenantId ≠ token tenant | `application/http/route.ts` (`requireSameTenant`, `requireStrict`) | Path tenant compared, never used; strict schemas reject a `tenantId` field | `tests/threats/L2-04-route-handlers.test.ts`: "refuses a path tenantId that differs from the session's, instead of correcting it" |
| 4 | L2-16 | Cross-tenant writes | `migrations/0001_tenant_isolation.sql` (triggers), `migrations/0000_tables.sql` (composite keys) | A trigger that aborts on a tenant mismatch | `tests/threats/L2-16-cross-tenant-writes.test.ts`: "the database rejects an insert for another tenant" (raw SQL, repository bypassed) |
| 5 | L2-01 | Approval token replay | `services/approval/repository.ts` (`redeemApprovalToken`), `services/approval/approval-service.ts` (`redeemTicket`) | `UPDATE ... WHERE redeemed_at IS NULL`; true only for the first use | `tests/threats/L2-01-approval-tokens.test.ts`: "two concurrent redemptions: exactly one succeeds"; `tests/threats/L2-02-engine-failure.test.ts`: "a token burned by a failed run cannot start the run once the same approver has approved it again" |
| 6 | L2-02 | Unverified token signature | `services/engine/engine-service.ts` (`startRun`), `data/keys/kms.ts` (`verifyJwt`) | Signature verified with the key named by `kid`, algorithm pinned to EdDSA, before anything is read | `tests/threats/L2-02-payroll-engine.test.ts`: "unsigned (alg none)", "tampered", "wrong key", "wrong algorithm (HS256 and ES256)" |
| 7 | L1-19 | Unchecked service-to-service call | `services/identity/service-tokens.ts` (`verifyServiceToken`) | Endpoint, audience, tenant, grant re-checked on every call; single-use on money routes | `tests/threats/L1-19-service-tokens.test.ts`: "refuses a token for a different endpoint of the same service", "refuses a token minted for a different tenant" |
| 8 | L2-13 | Double ACH submit, double pay | `services/ach/ach-service.ts` (`achIdempotencyKey`, `prepareBatch`), `migrations/0015_one_live_run_per_pay_date.sql` | Key = hash(tenant, run); unique `run_id` and key; one live run per pay date (RT-01) | `tests/threats/L2-13-ach-idempotency.test.ts`: "concurrent submits produce one batch and one delivery"; `tests/threats/L2-13-one-run-per-pay-date.test.ts`: "the Turn 13 reproduction ..." |
| 9 | L0-01 | HR Admin takeover, no MFA | `application/auth/dal.ts` (`verifySession`), `services/identity/totp.ts`, `services/identity/login.ts` | MFA checked on every request; TOTP step single-use; step 1 never reveals what was wrong | `tests/threats/L0-01-admin-mfa.test.ts`: "no opt-out: an HR Admin session that skipped MFA is rejected even though the row exists" |
| 10 | L0-11 | Pay-date outage | `edge/waf.ts` (`inspectRequest`), `edge/route-policy.ts`, `proxy.ts` | Bad requests refused from headers alone, before the body is read; callers identified before anything is counted | `tests/threats/L0-11-edge-filtering.test.ts`: "an oversized body is rejected with 413 and never read"; `tests/threats/L0-11-authenticated-budgets.test.ts`: "125 unauthenticated POSTs ..." |
| 11 | L2-18 | Tokens never expire or rotate | `services/approval/approval-service.ts` (`APPROVAL_TOKEN_TTL_SECONDS`), `data/keys/kms.ts` (`rotateSigningKey`), `scripts/rotate-key.ts` | 5-minute tokens; rotation retires every old version at once | `tests/threats/L2-01-approval-tokens.test.ts`, describe "[L2-18] tokens expire and rotate" |
| 12 | L1-20 | Forged SSO assertion | `services/identity/sso.ts` (`verifySsoAssertion`) | Tenant's own key, ES256 pinned, issuer, audience, age, `tid`, single-use `jti` | `tests/threats/L1-20-sso-assertion.test.ts`: "rejects the wrong algorithm: none, HMAC with the public key, ..." |
| 13 | L2-11 | Unverified bank change paid | `services/bank-account/bank-account-service.ts` (`requestBankChange`, `resolveBankChange`) | Every change pending; link hashed, single-use, bound to the employee; payroll reads verified accounts only | `tests/threats/L2-11-bank-changes.test.ts`: "an admin's change is pending, a run before confirmation pays the old verified account, and confirming switches it" |
| 14 | L2-12 | Bank numbers in logs | `data/log/logger.ts` (`redact`) | Redaction by field name and by pattern at ingest; console wrapped too | `tests/threats/L2-12-log-redaction.test.ts`: "redacts them inside a stack trace and an error's cause chain" |
| 15 | L1-22 | Batch altered in transit | `services/ach/ach-service.ts` (`signBytes` in `prepareBatch`, `verifyBytes` in `deliver`), `partners/mock-bank/server.ts` | Ed25519 over the exact bytes; mTLS with a pinned bank certificate; the bank verifies against pinned keys | `tests/threats/L1-22-ach-signing.test.ts`: "a single altered byte is rejected (an account number redirected in transit)" |

## 4. Five pieces of security-critical code (3 min)

All five were written by the AI (Claude Code) from my written specification, and I reviewed each one before
approving its layer. For each: what I specified, what the code does, and how we know it works. Details and likely
questions: [code-walkthrough.md](code-walkthrough.md#part-2-five-pieces-of-code).

1. **`withTenant` (live):** `data/db/tenant-scope.ts` and `data/db/scope-runner.ts`. I required that setting the
   tenant, querying, and clearing it happen in one synchronous block that cannot be used any other way. Show the
   `Sync<T>` type, which rejects async callbacks at compile time, and the `isThenable` check, which rolls back at run
   time. Then the `finally` block that always clears the tenant.
2. **The route wrapper:** `application/http/route.ts`. Show the six numbered steps in the header comment, then
   `requireStrict`: a route whose schema is not strict, or that accepts a field named like `tenantId`, throws when its
   module loads. A misconfigured route cannot even start.
3. **Atomic token redemption:** `services/approval/repository.ts`, `redeemApprovalToken`. One UPDATE with
   `isNull(t.redeemedAt)` in the WHERE clause; it returns true only if exactly one row changed. Mention the Turn 16
   finding: no test exercised this guard any more until a new test was added (section 6).
4. **The engine's single transaction (live):** `services/engine/engine-service.ts`, `startRun`. The async checks
   run first; then one `withTenant` block re-reads the run, compares the D28 content hash, redeems the token, computes
   every employee, writes all results, and marks the run computed. If anything throws, SQLite rolls all of it back,
   so there is never a burned token next to half-written results.
5. **ACH idempotency and signing:** `services/ach/ach-service.ts`, `achIdempotencyKey`, `prepareBatch`, `deliver`.
   The key comes from the tenant and run only; the database refuses a second batch; the exact bytes are signed and
   verified again before every send; a retry resends the same bytes.

## 5. Live demo (3.5 min)

Logins are in `.data/dev-credentials.txt`. Codes: `npm run -s totp -- <email> --code-only` in terminal 3. Each code
works once; if one is refused, wait for the next 30-second window.

1. **HR Admin signs in with MFA** (normal window). http://localhost:3000/login, "HR Admins and Payroll Approvers"
   form: Organization id `acme`, Email `admin@acme.test`, the password, **Continue**; code, **Verify**. *Say:* a correct
   password alone reaches nothing; the Data Access Layer refuses the session until the TOTP step is done.
2. **Create a draft run.** Pick a **Pay date** at least two days ahead and press **Create draft run**. Point out
   "Runs on" one day earlier (the day-early schedule, L0-11) and the bank accounts shown as last 4 digits only.
3. **Attack: another tenant's path, and an injected tenant (L2-04).** In the HR Admin window, open DevTools
   (F12), Console, and paste:

   ```js
   fetch("/api/tenants/globex/runs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ payDate: "2027-06-04" }) }).then((r) => r.status)
   ```

   Result: `403`. Then:

   ```js
   fetch("/api/tenants/acme/runs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ payDate: "2027-06-04", tenantId: "globex" }) }).then((r) => r.json())
   ```

   Result: 400 with "Unrecognized key" for `tenantId`. The tenant comes only from the verified session.
4. **The approver approves with step-up, runs payroll, sends to the bank** (private window). Sign in as
   `approver@acme.test`; **Review** on your run; a fresh code in **Authenticator code**; **Approve**; **Run payroll**.
   Show the totals ($9,416.67 gross, $7,345.00 net). Press **Send to bank**: "Sent to the bank" with a bank reference.
   *Say:* the approval token lived only in this page's memory, for 5 minutes, and was usable once.
5. **Attack: pay the same period twice (RT-01, L2-13).** Back in the HR Admin window, create another run with the
   same pay date. Result: "A payroll run already exists for this pay date". *Say:* the red team found that this used
   to pay everyone twice. The fix is a partial unique index plus a check at create, move, and re-approve.
6. **Employee: statement, IDOR, bank change, confirmation** (Alice's window). At `/login`, the "Employees" form:
   Organization id `acme`, **Sign in with your organization**; at the stand-in IdP, `alice@acme.test` and her IdP
   password, **Sign in**, **Continue to PayrollHub**. Open **View statement**. In the address bar, change the last
   character of the statement id to another hex digit (0 to 9, a to f): "not found", the same answer as a missing id,
   whether the id belongs to another employee or to nobody. Back on the portal, request a change:
   Routing number `091000019`, Account number `555500001234`, **Request change**. It shows as unverified. In the HR
   Admin window, refresh: "unverified, waiting for the employee to confirm". Open http://localhost:3000/dev/outbox,
   Alice's address and **Mailbox password**, **Open mailbox**, open the link, **Confirm new account**.
7. **No bank numbers in the logs (L2-12)** (terminal 3, PowerShell):

   ```powershell
   Select-String -Path .data\logs\payrollhub.log -Pattern 555500001234, 091000019
   ```

   No output: neither number appears in the log, although both passed through the server.
8. **Optional, if time allows: break a control and watch the test fail** (terminal 3):

   ```powershell
   # remove the atomic guard: the redemption UPDATE no longer requires redeemed_at IS NULL
   (Get-Content services/approval/repository.ts) -replace 'and\(eq\(t.tokenId, tokenId\), isNull\(t.redeemedAt\)\)', 'eq(t.tokenId, tokenId)' | Set-Content services/approval/repository.ts
   npx vitest run --project parallel tests/threats/L2-02-engine-failure.test.ts   # 1 failed
   git checkout services/approval/repository.ts
   npx vitest run --project parallel tests/threats/L2-02-engine-failure.test.ts   # 2 passed
   ```

   Run `git diff` after `git checkout` to show the file is restored.

## 6. The AI pair-programming story (2.5 min)

The whole build is in the session log (`docs/ai-usage-session-log.pdf`): every prompt I wrote, word for word, and a
summary of each reply. The pattern: I wrote the specification and acceptance tests for each layer; the AI wrote the
code and tests; I reviewed each layer, decided every flagged question, and asked for evidence instead of explanations.

**Where it helped:**

- It read the Next.js 16 docs bundled with the project and found in Turn 1 that "Middleware" is now "Proxy", which
  changed where the rate limiter could run.
- It found and fixed real bugs during the build. Running Next from a lowercase folder path loaded React twice. Next.js
  bundled two copies of the tenant-scope module, so they did not share the tenant state. A Redis client stayed dead
  after Redis restarted. Each fix came with a regression test.
- It broke every control on purpose to show that the tests catch it, and reported the results in a table each turn.

**Where it was wrong, and how it was caught:**

| What happened | How it was caught |
|---|---|
| **The L0-01 timing claim.** In Turn 14 it changed the sign-in timing test's sampling, explaining that the old method gave a false 2.4x ratio under load and the new one stayed within about 10%. I accepted that. | In Turn 15 I asked for the raw timings. They showed the opposite: under load the old method gave 1.10 to 1.24 and the new one up to 2.03. I reversed my acceptance in Turn 16 (D55): old sampling back, and the test now runs alone. |
| **The strict-dynamic CSP.** The Next.js guide's example CSP includes `'strict-dynamic'`, the obvious thing to copy. | A browser probe showed that it let a script inserted at run time execute. It was left out, and the reason is recorded (D38). The lesson: test security headers in a real browser rather than copying them. |
| **A mutation check that "passed" because nothing ran.** In Layer 6, its first attempt to disable the D27 triggers broke the migration, so every test was skipped, and a run with no failures looked like a pass. | The run reported the tests as skipped. It was redone with triggers that never fire, and the D27 test then failed as it should. The lesson: a mutation check counts only if the tests actually ran. |
| **RT-01: everyone paid twice.** One ACH batch per run, as I had specified, but nothing stopped two runs for the same pay date. Neither the AI nor I saw it. | An independent reviewer (Turn 13) did. Fix D43: a partial unique index, one live run per tenant and pay date. |
| **Dead WAF rules (RT-09).** Rules against `..` and encoded dots, with a comment claiming protection, could never fire, because the URL parser resolves them before Proxy runs. | An independent reviewer: "plausible but wrong". The dead rules were removed and the comment now says what the code really does (D50). |
| **Decisions made without asking (D31, D32, D34, D36, D37).** They were recorded in the README, not raised in chat. | I noticed gaps in the decision numbers in the chat summaries (D17 earlier, then D31, D32, D34) and asked about them. All were reviewed after the fact, and from Turn 12 on every new decision must be raised in chat. |
| **Agents out of scope.** Reviewer 5 sent requests to the machine's network address despite a localhost-only brief; reviewer 6 got around a blocked `db:reset`; the build agent left a `next start` running on all interfaces for about 18 hours with old published passwords still working. | Auto mode blocked some of these. I asked for each one to be checked and recorded honestly (docs/red-team.md, "AI-agent scope incidents"). |
| **A dev-mode bug.** The bank-change confirmation page failed under `npm run dev` (React Strict Mode ran its effect twice). Every test used the production build. | A fresh agent following the README on a clean copy found it (Turn 15). Fixed (D52), with a browser test that now runs against `next dev` too. |
| **An untested guard (Turn 16).** With the atomic `redeemed_at` check removed, all 278 tests still passed. Later layers had added an earlier check that hid it. | Found by repeating a mutation check while preparing this demo. A new test replays a burned token after re-approval; it fails without the guard. |

**Where I overrode or redirected it:**

- **Redis** (Turn 2): it planned SQLite counters inside the login handler; I required a shared Redis store (Assignment
  5 §2.2), so the login throttle runs in Proxy before any auth.
- **The ORM** (Turn 2): I required all database access through Drizzle, with raw SQL banned outside migrations. It then
  found that `db.run/all/get/values` also accept plain SQL strings, and banned those too.
- **D28, the content hash** (Turn 7): I proposed binding the approval token to a hash of the run's contents, so a run
  changed after approval no longer matches its token. I accepted its wider scope (employees, pay rates, verified
  account ids), with canonical hashing.
- **Separation of duties, D27** (Turn 7): I raised it; the creator of a run cannot approve it, checked in the service
  and by a database trigger.
- **The unlock-link conditions** (Turn 14): it proposed an unlock link. I set the conditions. The fresh budget goes to
  the device that opens the link, not the one that asked. The link restores only a sign-in budget. Requests are
  rate-limited and never reveal whether the account exists. The link is single-use, expires quickly, is stored only as
  a hash, and goes only to the staff member's own mailbox.
- **Independent reviewers** (Turn 13): I did not let it red-team its own work in its own context. Fresh agents with
  no access to our conversation attacked running installs, fresh agents re-tested the fixes, and two more fresh agents
  installed the project from the README alone.

## 7. Close (0.5 min)

- 15 threats, each with a primary control in code, a tagged test that attacks it, and a traceability check that fails
  if any threat loses its test.
- An independent red team found real problems, including double pay, and every finding has a recorded resolution.
- The AI wrote most of the code; the specification, the decisions, and the insistence on evidence were mine.

## Fallback plan

| If this breaks | Do this |
|---|---|
| Sign-in answers 503, or the server log shows `startup.redis_unreachable` | Redis is down. Run `docker compose up -d` and wait about 5 seconds. *Say:* login and money routes failing closed while Redis is down is D20, by design. |
| "Code rejected" at sign-in or approval | Each TOTP code works once. Wait for the next 30-second window and get a new code. |
| "Too many requests" (429) on sign-in | Use **Locked out after too many attempts?** on `/login`: the unlock link goes to that staff member's mailbox (D46). Or switch to the `globex` tenant (`admin@globex.test`, `approver@globex.test`, `dana@globex.test`), which has its own budgets. |
| **Send to bank** fails or times out | Check terminal 1; start `npm run bank` if it is not running, then press **Send to bank** again. The same signed batch is resent, never a new one (L2-13). That makes a good extra demo point. |
| Port 3000 is already in use | In PowerShell: `Get-NetTCPConnection -LocalPort 3000 -State Listen` shows the process id; stop it with `Stop-Process -Id <id>`. Otherwise use another port as described in `docs/platform-setup.md` (Other ports). |
| A page shows only its heading | It is still loading. Wait a second; under `npm run dev` the first load of a page compiles it. |
| Approval says a token is still valid, or the run shows failed | Create a new run with a later pay date and repeat step 4. |
| The app will not start at all, or anything else goes wrong for more than a minute | Stop the live demo. Show the saved screenshots from `npm run test:e2e` (same flow, real browser) and the saved `npm test` output, and walk through the same points on them. |
| No network on the presentation machine | Nothing in the demo needs the internet once `npm install` and the Chromium download are done. |

## Likely questions (short answers)

Longer answers and code-level questions: [code-walkthrough.md](code-walkthrough.md).

- **"SQLite has no RLS, so isn't isolation only in application code?"** No. The views and triggers are in the
  database, keyed on `current_tenant()`. With no tenant set, reads return nothing and writes abort. A test bypasses the
  repository with raw SQL and the database still refuses the cross-tenant write (L2-16).
- **"Could an approver replay a token?"** Redemption is one atomic UPDATE that only changes a row whose `redeemed_at`
  is NULL. Two concurrent redemptions: exactly one succeeds (tested). A token burned by a failed run cannot be used
  after re-approval either (tested since Turn 16).
- **"What stops an HR Admin who has been taken over from redirecting pay?"** Their change stays pending. The link goes
  only to the employee's mailbox, and confirming needs the employee's own session. Payroll reads verified accounts only.
- **"Why trust the AI's code?"** Not on trust: each control has a test that attacks it, each test was shown failing
  with the control broken, independent agents attacked the running app, and two agents installed it from the README.
- **"What is not covered?"** README section 12: no real WAF or DDoS absorption (L0-11 locally), keys in files rather
  than an HSM, per-IP limits only behind a reverse proxy, and RT-15 (Next.js request handling on client aborts).
