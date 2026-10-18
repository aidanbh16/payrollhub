# PayrollHub: code study guide

The author's study notes for the presentation and for questions from graders and red-teamers. **Not part of the
submission ZIP** (D56). The talk itself is in [presentation-outline.md](presentation-outline.md).

How to read each entry:

- **What it does:** the code in plain language, line by line where it matters.
- **Why it is there:** the threat, and what would go wrong without it.
- **Test that proves it:** the tagged test that attacks it. Every one of them was shown failing with the control
  broken on purpose (session log, "Controls broken on purpose" in each layer).
- **Likely questions:** short answers.

Run the tests for one threat with `npm test -- <ID>` (for example `npm test -- L2-11`).

**Contents**

- [Part 1: The 15 primary controls](#part-1-the-15-primary-controls)
- [Part 2: Five pieces of code](#part-2-five-pieces-of-code)
- [Part 3: Cross-cutting questions](#part-3-cross-cutting-questions)

## Part 1: The 15 primary controls

In Assignment 4 rank order.

### 1. L1-05: Credential-stuffing flood on the login route

**Files:** `edge/rate-limiter.ts` (`CONSUME`, `consume`, `edgeRedis`), `proxy.ts`, `edge/route-policy.ts` (`LIMITS`),
`edge/login-routes.ts`, `edge/known-devices.ts`, `edge/unlock.ts`.

**What it does:**

- `proxy.ts` runs before every route. For a login route (staff password step, MFA step, the stand-in IdP's form) it
  reads the targeted account from the request body (tenant plus email, trimmed and lowercased, then hashed) before any
  password or code is checked.
- `CONSUME` is a Lua script. Redis runs a script as one atomic step, so every bucket for the request (per account, per
  class, per device budget) is incremented and checked together, and no two requests can both see "9 of 10".
  - Window buckets: `INCR`, set the expiry on the first hit, blocked if the count is over `max`.
  - Backoff buckets (D25, unknown devices): the first 5 attempts are free. After that, each attempt must come after
    `nextAt`; otherwise it is refused with a Retry-After and does not add to the penalty. The delay doubles (1 s, 2 s,
    4 s...) up to 15 minutes. The server never sleeps.
- `LIMITS.account`: 10 attempts per 15 minutes per account per login route. A device that has completed MFA for that
  account before (D25), or that opened an unlock link for it (D46), gets its own budget and skips the login ceiling, so
  an attacker cannot lock the real admin out.
- `edgeRedis`: a 1.5 s timeout per call. If Redis cannot be reached at all, a 2 s circuit breaker opens, and login and
  money routes answer 503 (D20, fail closed). A slow reply fails only that request (RT-03).

**Why it is there:** without it, an attacker can try leaked password lists against the login route at full speed.
Counting per account (not per IP) means rotating IPs does not help. Doing it in Redis means every app instance shares
the same counters (Assignment 5 §2.2).

**Test that proves it:** `tests/threats/L1-05-credential-stuffing.test.ts`: "a flood against one account hits the
ceiling no matter what IP headers the client sends", "email case and whitespace variants count against the same
account", "concurrent attempts cannot race past the limit", "the Redis update is atomic: 200 concurrent increments of
one bucket allow exactly its limit". Also `tests/threats/L1-05-unlock-link.test.ts` (D46) and
`tests/threats/D20-redis-down.test.ts`.

**Likely questions:**

- *Why not limit per IP?* Next.js 16 gives Proxy no client address a client cannot forge (no `request.ip`, and
  `X-Forwarded-For` is client-controlled). PayrollHub never reads `X-Forwarded-For`. Per-IP limits turn on only behind
  a reverse proxy that overwrites a header (`TRUSTED_CLIENT_IP_HEADER`, docs/operations.md).
- *Can an attacker lock an admin out?* Only on devices the admin has never used. The admin's known device has its own
  budget, and a locked-out admin can use the unlock link, which goes to their own mailbox and restores the budget only
  for the browser that opens it.
- *What if Redis is down?* Login and money routes return 503 (fail closed); other routes keep working with a warning.
- *Why read the body in Proxy?* The email is in the body. Next.js buffers the body for Proxy (up to 64 KiB, capped in
  `next.config.ts`) and the route can still read it; a test checks exactly that.

### 2. L1-14: Missing row-level predicate lets one tenant read another's rows

**Files:** `migrations/0001_tenant_isolation.sql`, `data/db/views.ts`, `data/db/tenant-scope.ts`,
`data/db/scope-state.ts`, `data/db/connection.ts`.

**What it does:**

- `connection.ts` registers a SQL function `current_tenant()` on the connection. It returns the tenant of the
  currently open `withTenant` block, or NULL when no block is open. It is registered as non-deterministic, so SQLite
  calls it every time instead of caching the result.
- Every tenant table has a view: `CREATE VIEW v_employee AS SELECT * FROM employee WHERE tenant_id = current_tenant()`.
  With no tenant set, `tenant_id = NULL` is never true, so the view returns nothing.
- `TenantScope.read(view)` accepts only those views. The TypeScript type rejects a base table at compile time, and the
  `TENANT_VIEWS` set rejects one at run time, even through a cast.
- ESLint forbids importing the raw database handle, the base tables, or `drizzle-orm`'s `sql` tag in application code.

**Why it is there:** Assignment 5 relied on PostgreSQL row-level security. SQLite has none, so the views are the read
policy, enforced by the database rather than by each query remembering a `WHERE tenant_id = ?`.

**Test that proves it:** `tests/threats/L1-14-cross-tenant-reads.test.ts`: "every tenant view returns only the scope
tenant's rows", "with no tenant set, every view returns nothing although the base tables hold rows";
`tests/data/views-only.test.ts`: "every SELECT issued by every repository read function targets a v_ view";
`tests/data/async-interleaving.test.ts`: "interleaved async requests for different tenants never see each other's
rows".

**Likely questions:**

- *Can application code still read a base table?* Only by importing the raw handle, which ESLint forbids and a
  source-scan test checks. That residual risk is listed as a known limitation.
- *What about two requests at once?* `current_tenant()` is per connection, and a `withTenant` block is synchronous
  (Part 2, piece 1), so no other request can run while a tenant is set.

### 3. L2-04: tenantId path and token mismatch writes a run into another tenant

**Files:** `application/http/route.ts` (`takePathTenant`, `requireSameTenant`, `requireStrict`),
`application/validation/`.

**What it does:** the route wrapper removes `[tenantId]` from the path parameters, so a handler cannot use it. It then
compares it with the tenant from the verified session or service token and answers 403 if they differ. It never
"corrects" the request to the session's tenant. Every input schema is a `z.strictObject`, so an extra `tenantId` in
the body is rejected with 400, not silently dropped. The handler gets `tenantId` only from the verified claims.

**Why it is there:** if a handler trusted the path, an HR Admin of tenant A could create a run in tenant B by changing
the URL.

**Test that proves it:** `tests/threats/L2-04-route-handlers.test.ts`: "refuses a path tenantId that differs from the
session's, instead of correcting it", "rejects a tenantId field in the body (strict schema), and writes nothing", "a
cross-tenant run id returns exactly the same response as one that does not exist"; `tests/data/route-wrapper.test.ts`.

**Likely questions:**

- *Why 403, not just use the session's tenant?* Correcting the request hides an attack, and a client that sends the
  wrong tenant is either broken or malicious. Refusing makes both visible.
- *What if a new route forgets the wrapper?* ESLint rejects any route export not built with `route.session`,
  `route.service`, or `route.public`, and `tests/data/route-wrapper.test.ts` scans every route file.

### 4. L2-16: App-code-only isolation writes results to the wrong tenant

**Files:** `migrations/0001_tenant_isolation.sql` (triggers), `migrations/0000_tables.sql` (composite foreign keys).

**What it does:** each tenant table has BEFORE INSERT, UPDATE, and DELETE triggers. They abort (`RAISE(ABORT, ...)`)
when `current_tenant()` is NULL or differs from the row's `tenant_id`; an UPDATE checks both the old and the new
value, so a row cannot be moved into another tenant. They use `IS NOT` rather than `<>` so that a NULL on either side
counts as a mismatch. Child tables reference their parent through `(tenant_id, id)` composite foreign keys, so a pay
result cannot point at another tenant's employee.

**Why it is there:** the views only protect reads. Without the triggers, a bug in application code (or an injected
write) could write into another tenant. This is the database's WITH CHECK policy.

**Test that proves it:** `tests/threats/L2-16-cross-tenant-writes.test.ts`: "the database rejects an insert for another
tenant", "the database rejects moving a row into another tenant", "the database rejects every write when no tenant is
set" (all with raw SQL, bypassing the repository), "tenant A cannot attach a row to tenant B's employee (composite
foreign key)".

**Likely questions:**

- *Do the triggers cost performance?* One function call and a comparison per row written; negligible at this scale.
- *Who can write without a tenant?* Only `withPlatform()` (Identity & Access and the scripts), for the platform-wide
  ServiceGrant table; ESLint keeps it out of other code.

### 5. L2-01: Captured approval token replayed to launch an unauthorized run

**Files:** `services/approval/approval-service.ts` (`prepareRedemption`, `redeemTicket`),
`services/approval/repository.ts` (`redeemApprovalToken`). Detail: Part 2, piece 3.

**What it does:** redeeming a token is one SQL UPDATE that sets `redeemed_at` only where it is still NULL. It returns
true only if exactly one row changed, so the second use, or the slower of two simultaneous uses, changes nothing and is
refused. It runs inside the engine's transaction, so a token is never marked used without its pay results.

**Why it is there:** an approval token is a bearer credential for moving money. Anyone who captures it (a log, a proxy,
a browser extension) could otherwise start the run again.

**Test that proves it:** `tests/threats/L2-01-approval-tokens.test.ts`: "a replayed token is refused", "two concurrent
redemptions: exactly one succeeds", "over HTTP, the internal engine route also accepts a token once";
`tests/threats/L2-02-engine-failure.test.ts`: "a token burned by a failed run cannot start the run once the same
approver has approved it again" (added in Turn 16, see Part 2, piece 3).

**Likely questions:**

- *Why not a replay cache?* D10: the durable record is the replay check. A separate cache could disagree with it.
- *Is the token protected in the browser?* It stays in React state only (ESLint bans browser storage; a browser test
  checks all storage), lives 5 minutes, and is bound to one tenant, one run, and one approver.
- *Can someone approve without MFA?* No: approving needs a fresh TOTP step-up, and the service refuses to issue a token
  without the single-use proof that only the step-up module can create.

### 6. L2-02: Unverified approval-token signature authorizes a run as any admin

**Files:** `services/engine/engine-service.ts` (`startRun`), `services/approval/approval-service.ts`
(`verifyApprovalToken`), `data/keys/kms.ts` (`verifyJwt`), `services/engine/run-content.ts`.

**What it does:**

- `verifyJwt` reads the token header's `kid` (for example `approval-token:v2`) and looks for an **active** key with
  that name. A retired or unknown version fails at once. It then calls `jose.jwtVerify` with `algorithms: ["EdDSA"]`,
  so `alg: none`, HS256 (signing with the public key as an HMAC secret), and every other algorithm are refused. Issuer,
  audience, and a maximum age of 5 minutes are checked whatever `exp` says.
- `startRun` checks the token's tenant and run against the request, then, inside the transaction, that the run is
  approved by this token's approver and was not created by them (D27). It recomputes the D28 content hash from the
  database and compares it with the token's `rh`.

**Why it is there:** if the engine only decoded the token, anyone could write one naming any approver and any run.

**Test that proves it:** `tests/threats/L2-02-payroll-engine.test.ts`: "unsigned (alg none)", "tampered (payload
changed after signing)", "wrong key", "wrong algorithm (HS256 and ES256)", "wrong tenant", "wrong run", plus the D28
content-change tests.

**Likely questions:**

- *Why EdDSA?* Asymmetric (the engine needs only the public key), fast, and with no parameter choices to get wrong.
- *What is D28?* The token carries a hash of the run's content at approval: tenant, run, dates, creator, withholding
  rate, and every active employee with pay rate and verified account id, in a fixed canonical order. If any of it
  changes after approval, the hash no longer matches, the run fails with `content_changed`, and it needs re-approval.

### 7. L1-19: Unchecked service-to-service call reaches internal Payroll Engine endpoints

**Files:** `services/identity/service-tokens.ts` (`mintServiceToken`, `verifyServiceToken`, `authorizeServiceCall`),
`app/api/internal/`, `application/mint-as-bff.ts`.

**What it does:**

- `mintServiceToken` signs a 60-second EdDSA token naming one caller (`sub`), one target service (`aud`), one
  `endpoint`, and one tenant (`tid`). It refuses unless the ServiceGrant table allows that caller to reach that
  endpoint.
- `verifyServiceToken` checks the signature, issuer, audience, and age, then that the endpoint and tenant are the
  expected ones. It re-checks the grant on every call, so revoking a grant takes effect immediately. For single-use
  endpoints (the money routes) it records the token id and refuses a second use.
- `authorizeServiceCall` is the first line of every service function. It accepts either a raw token, which it verifies,
  or a claims object that this module itself produced. That is tracked in a module-private `WeakSet`, so a hand-built
  claims object is refused.
- Each service can mint tokens only as itself, through its own handle (`mint-as-<service>.ts`); ESLint forbids
  importing another service's handle (DV-26).

**Why it is there:** in Assignment 5 the services are separate. Here they are modules in one process, and these
tokens keep each service from calling an endpoint it was not granted. `/api/internal/engine` and `/api/internal/ach`
also accept only these tokens over HTTP, never a session cookie.

**Test that proves it:** `tests/threats/L1-19-service-tokens.test.ts`: "refuses a missing token", "refuses an expired
token", "refuses a token for a different endpoint of the same service", "refuses a token minted for a different
tenant", "will not mint a token for a caller ServiceGrant does not allow", and the same cases over HTTP.

**Likely questions:**

- *In one process, could a module just call `mintServiceToken` as someone else?* ESLint forbids it, but at run time
  nothing stops determined code inside the process. That residual risk was accepted and documented (DV-26). Over
  HTTP the scoping holds fully.
- *Why single-use only on money routes?* Those are the ones where a replay moves money; the others are reads with a
  60-second life.

### 8. L2-13: Missing idempotency key double-submits the ACH batch and double-pays

**Files:** `services/ach/ach-service.ts` (`achIdempotencyKey`, `prepareBatch`, `disburseRun`),
`migrations/0000_tables.sql` (unique `ach_batch_run`, `ach_batch_idempotency_key`), `migrations/0013_ach_integrity.sql`,
`migrations/0015_one_live_run_per_pay_date.sql`, `services/engine/engine-service.ts` (`createDraftRun`). Detail: Part
2, piece 5.

**What it does:**

- **Per run:** the idempotency key is a SHA-256 of a version tag, the tenant, and the run. It does not depend on the
  time or on anything in the request, so the same run always gets the same key and batch ID. `prepareBatch` returns
  the existing batch if there is one. Both `run_id` and the key are unique in the database, so a concurrent second
  insert fails and the code returns the winner's batch.
- **Per pay period (RT-01, D43):** a partial unique index allows one live run per tenant and pay date
  (`WHERE status <> 'failed'`). Creating, moving, or re-approving a run onto a taken date answers 409. Failed runs are
  excluded, so D35's "create a new run" still works.
- The batch ID is written inside the signed file, and the bank also refuses a second batch with the same ID.

**Why it is there:** a timeout, a double click, or two tabs must never pay people twice. The red team (Turn 13) showed
that per-run idempotency alone was not enough: two runs for the same pay date both paid out.

**Test that proves it:** `tests/threats/L2-13-ach-idempotency.test.ts`: "a double submit returns the one existing
batch; the bank receives it once", "concurrent submits produce one batch and one delivery", "a retry after a timeout
returns the existing batch; the bank's duplicate check absorbs the resend", "the database refuses a second batch for a
run, or a reused idempotency key"; `tests/threats/L2-13-one-run-per-pay-date.test.ts`: "the Turn 13 reproduction ...",
and the two end-to-end failed-then-new-run tests.

**Likely questions:**

- *Why derive the key instead of letting the client send one?* A client key can be forgotten or changed; one derived
  from the run cannot.
- *What if the bank's answer is lost?* The batch stays signed in the database. Pressing Send again resends the same
  stored bytes; the bank answers "duplicate, same file", which counts as delivered (DV-42).

### 9. L0-01: HR Admin account takeover with no MFA

**Files:** `application/auth/dal.ts` (`verifySession`, `requireSession`), `services/identity/totp.ts`
(`consumeTotpCode`), `services/identity/login.ts`, `services/identity/sessions.ts`.

**What it does:**

- `verifySession` is the Data Access Layer: every page and route calls it. It looks the session up in the Session
  table (`readSession`: the token's SHA-256, not revoked, not expired, bound to this device cookie, user active).
  Then: `if (isPrivilegedRole(claims.role) && !claims.mfaVerifiedAt) return null;`. An HR Admin or approver session
  without a completed TOTP step counts as not signed in. There is no per-route switch, so no route can opt out.
- `consumeTotpCode` accepts a code only for a time step **after** the last one used (`afterTimeStep`). Then
  `recordTotpStep` stores the step in one UPDATE that succeeds only if the stored step is still lower, so two requests
  racing with the same code cannot both pass.
- `startStaffLogin` (step 1) always answers "enter your code" and always sets a cookie. The session is real only if
  organization, email, and password were all right, and every path costs one scrypt verification, including a dummy
  hash for unknown users. Step 2 spends the pending session whatever happens: one code attempt per password entry.

**Why it is there:** a phished or reused HR Admin password alone must not reach payroll.

**Test that proves it:** `tests/threats/L0-01-admin-mfa.test.ts`: "a correct password without the TOTP step cannot reach
an admin route", "no opt-out: an HR Admin session that skipped MFA is rejected even though the row exists", the TOTP
code reuse tests; `tests/isolated/L0-01-login-timing.test.ts` (timing, run alone, D55).

**Likely questions:**

- *Why check in the DAL and not only in Proxy?* Next.js says Proxy must not be the only auth check (D2). Proxy only
  looks for a cookie; the DAL is authoritative.
- *What about a stolen session cookie?* It is bound to a separate device cookie (both HttpOnly, Secure,
  SameSite=Strict, `__Host-`), expires in 30 minutes for staff, and is revoked at logout. Approving a run needs a fresh
  TOTP step-up anyway.
- *Why is the timing test isolated?* It compares latencies; with 36 other files running in parallel it measured the
  machine's load, not the code (D55, a reversed Turn 14 decision).

### 10. L0-11: Platform-wide outage on a pay date

**Files:** `edge/waf.ts` (`inspectRequest`), `edge/route-policy.ts` (`policyFor`, `LIMITS`), `proxy.ts`,
`next.config.ts`, `edge/rate-limiter.ts`.

**What it does:**

- `inspectRequest` runs first and reads only the request line and headers. It refuses URLs over 2048 characters;
  encoded dots, slashes, backslashes, and control characters in the path; methods not allowed for the route class; any
  `Transfer-Encoding`; a body without a Content-Length (411) or over the class limit (413: 4 KiB on login, 32 KiB on
  APIs); and other content types (415). A refused request's body is never read.
- Proxy identifies the caller before counting (RT-03, D45). Money routes and protected pages need a live session;
  internal routes need a validly signed service token. Without one, the request is refused before anything is counted,
  so anonymous traffic cannot spend the budget signed-in users need. Signed-in traffic is counted per tenant and per
  session; anonymous traffic against a ceiling per route class. A flood on login cannot touch the money routes.
- The day-early schedule: a run is scheduled one day before its pay date (a CHECK constraint), so a pay-date outage
  does not stop pay (D29: late runs still proceed and are flagged).

**Why it is there:** Assignment 5 put a WAF and a distributed rate limiter at the edge. Locally, this is the closest
equivalent; real volumetric DDoS absorption is a documented limitation.

**Test that proves it:** `tests/threats/L0-11-edge-filtering.test.ts`: "an oversized body is rejected with 413 and never
read", "a body without a declared length (chunked) is rejected with 411 and never read";
`tests/threats/L0-11-authenticated-budgets.test.ts`: "the Turn 13 reproduction: 125 unauthenticated POSTs to a money
route are refused before counting; no tenant is throttled", "a burst of 330 concurrent staff logins gets 303s and
429s, never a platform-wide 503"; `tests/threats/L0-11-waf-path-rules.test.ts`; `tests/threats/L0-11-route-ceilings.test.ts`.

**Likely questions:**

- *Why were the ".." rules removed (RT-09)?* The URL parser resolves dot segments before Proxy sees the path, so the
  rules could never fire. A comment that claims protection the code does not give is worse than no rule.
- *Can a local app survive a real DDoS?* No; that is listed in the known limitations.

### 11. L2-18: Approval tokens do not expire or rotate

**Files:** `services/approval/approval-service.ts` (`APPROVAL_TOKEN_TTL_SECONDS`, `assertNoLiveToken`), `data/keys/kms.ts`
(`rotateSigningKey`, `verifyJwt`), `scripts/rotate-key.ts`, `migrations/0007_approval_immutability.sql`.

**What it does:**

- Tokens live 5 minutes. The expiry is checked twice: `maxTokenAge` in the signature check (whatever `exp` claims)
  and `expires_at` in the database record at redemption.
- `npm run keys:rotate -- approval-token` writes key version N+1 and moves every older version to `retired/`.
  `verifyJwt` finds keys only among the active versions, so every token signed with an old version dies immediately.
  The key store re-reads the folder on each use, so a running server needs no restart.
- The DB trigger makes the token record write-once: its expiry and key version cannot be extended, and it cannot be
  deleted.

**Why it is there:** a token that never expires, or a key that can never be changed, turns one leak into permanent
access.

**Test that proves it:** `tests/threats/L2-01-approval-tokens.test.ts`, describe "[L2-18] tokens expire and rotate"
(expiry at 5 min 1 s; after rotation the v1 token is refused and re-approval issues a v2 token), and "[L2-18 DiD] the
token record cannot be extended or erased".

**Likely questions:**

- *Why does the ACH key rotate differently?* An approval token is a short-lived credential, so rotation must kill it.
  An ACH signature is evidence on a stored record, so old ACH keys stop signing but keep verifying
  (docs/operations.md).

### 12. L1-20: Forged SSO assertion signs in as any employee

**Files:** `services/identity/sso.ts` (`verifySsoAssertion`, `signInWithSso`),
`app/api/auth/sso/[tenantId]/callback/route.ts`.

**What it does:** `verifySsoAssertion` loads the tenant's own IdP configuration and imports its registered public
key; it never uses a key from the assertion. `jwtVerify` is called with `algorithms: ["ES256"]` (pinned), the
configured issuer and audience, required claims (`sub`, `iat`, `exp`, `tid`, `jti`), a maximum age of 5 minutes, and a
30-second clock tolerance. Then `tid` must equal the tenant whose callback received it. `signInWithSso` records the
assertion id (`recordAssertionUse`) before creating any session, so a replay is refused. The subject must be an
active employee of that tenant.

**Why it is there:** employees sign in only through their company's IdP. If PayrollHub accepted any well-formed
assertion, anyone could sign in as any employee and change their bank account.

**Test that proves it:** `tests/threats/L1-20-sso-assertion.test.ts`: "rejects a forged assertion: payload changed after
signing", "rejects an assertion signed with the wrong key", "rejects the wrong algorithm: none, HMAC with the public
key, and other signature algorithms", "rejects an expired assertion, and one issued too long ago", "rejects the wrong
audience and the wrong issuer", "rejects the wrong tenant", and the replay test.

**Likely questions:**

- *Why JWT and not SAML?* The stand-in IdP is local (DV-10); the checks are the ones SAML needs: signature with the
  registered certificate, issuer, audience, validity window, and single use.
- *What is the "HMAC with the public key" attack?* A token signed with HS256 using the public key as the HMAC secret.
  A verifier that lets the token choose the algorithm would accept it; pinning ES256 refuses it.

### 13. L2-11: ACH generator pays an account whose change was never verified

**Files:** `services/bank-account/bank-account-service.ts` (`requestBankChange`, `linkTarget`, `resolveBankChange`,
`readVerifiedAccounts`), `partners/mock-mail/mail.ts`, `app/(employee)/employee/bank-change/`.

**What it does:**

- `requestBankChange` stores every change, whether from the employee or an HR Admin, as **pending**, with no verified
  account created. It generates a 256-bit random token, stores only its SHA-256 with a 60-minute expiry, and mails the
  link to the employee's existing mailbox. The response never contains the link. One pending change per employee: a
  new request supersedes the old one and kills its link, but an HR Admin cannot supersede the employee's own pending
  change (RT-07, 409).
- `linkTarget` accepts a link only if the hash matches, it is for this change, unused, and unexpired, the change is
  still pending, and the signed-in employee is the one the change is for. Anything else is "not found".
- `resolveBankChange` runs on a POST (opening the link with GET only shows the last 4 digits). In one transaction it
  consumes the code atomically, retires the old verified account, inserts the new one as verified, and records who
  confirmed and when.
- Payroll reads only verified accounts (`readVerifiedAccounts`), and ACH re-reads them before building the batch
  (D35).

**Why it is there:** "change direct deposit" is the classic payroll fraud. A taken-over HR Admin account, or an
attacker with an employee's session, must not be able to redirect pay without the employee confirming from their own
mailbox.

**Test that proves it:** `tests/threats/L2-11-bank-changes.test.ts`: "an admin's change is pending, a run before
confirmation pays the old verified account, and confirming switches it", "opening the link (GET) only shows the
change; confirming needs a POST", "refuses a reused link", "refuses an expired link", "refuses a forged cross-site
confirm", and "[L0-01 DiD] an HR Admin cannot confirm ...".

**Likely questions:**

- *Why does confirming need the employee's session as well as the link?* A forwarded or leaked link alone cannot
  confirm (DV-38).
- *What stops the HR Admin from reading the mailbox?* Each mailbox has its own random password, separate from
  PayrollHub and the IdP, and no PayrollHub session opens a mailbox (D30).
- *Can the contact email be changed to redirect the link?* No: nothing changes it, and a trigger makes it immutable
  (D31, a known limitation).

### 14. L2-12: Generated ACH file in logs exposes bank and routing numbers

**Files:** `data/log/logger.ts` (`redact`, `redactText`, `SENSITIVE_FIELDS`), `instrumentation.ts`,
`instrumentation-node.ts`, `application/http/route.ts` (`errorResponse`).

**What it does:** every log line goes through one logger, which redacts before anything is written:

1. **By field name:** any key in `SENSITIVE_FIELDS` (account number, routing number, file body, password, token,
   cookie, ...) is replaced at any depth, whatever its case or separators.
2. **By pattern, in every string** (messages, error messages, stack traces, causes): SSNs become `[SSN]`; a 9-digit
   run that passes the ABA checksum becomes `[ROUTING]`; any other run of 7 or more digits, and grouped digits such as
   "7301 0000 0101", become `[REDACTED]`. UUIDs are cut out first and kept, so request and record ids stay readable.

ESLint bans `console.*` in application code, and the console itself is wrapped at startup, so Next.js's own error
output is redacted too. Unhandled errors (the route wrapper, `onRequestError`, process hooks) all go through it.

**Why it is there:** logs are read by more people than the database and kept longer. An ACH file or an error message
quoting an account number would leak exactly what an attacker needs.

**Test that proves it:** `tests/threats/L2-12-log-redaction.test.ts`: "redacts a routing and account number inside an
error message", "redacts them inside a nested object, by field name and by pattern", "redacts them inside a stack trace
and an error's cause chain", "redacts SSNs and a whole NACHA entry record in free text", "the route wrapper's
unhandled-error path logs redacted details and returns a generic 500". In Layer 8, a full flow was run and the logs
searched for all 12 seeded numbers: 0 matches.

**Likely questions:**

- *Does it redact too much?* Any 7+ digit run is redacted, which can hide harmless numbers. That is deliberate:
  missing a real account number is the worse failure. Dates, times, and UUIDs are kept (tested).

### 15. L1-22: Unsigned ACH batch altered in transit to redirect funds

**Files:** `services/ach/ach-service.ts` (`prepareBatch`, `deliver`), `services/ach/nacha.ts`
(`checkControlTotals`), `data/keys/kms.ts` (`signBytes`, `verifyBytes`), `partners/mock-bank/server.ts`,
`services/ach/bank-client.ts`. Detail: Part 2, piece 5.

**What it does:** the exact file bytes are signed with Ed25519 by the key store's `ach-batch` key; the caller gets the
signature and the key version, never the key. Before every send, `deliver` verifies the stored signature on the stored
bytes again. The connection is mutual TLS: the bank requires PayrollHub's client certificate, and PayrollHub accepts
only the bank certificate whose SHA-256 fingerprint was pinned at setup. The bank verifies the signature against its
own pinned copy of the public key for that version, checks the file's control totals, and refuses a duplicate batch
ID.

**Why it is there:** without a signature, anyone on the path (or with write access to a stored file) could change an
account number in the batch and redirect pay.

**Test that proves it:** `tests/threats/L1-22-ach-signing.test.ts`: "a single altered byte is rejected (an account
number redirected in transit)", "a batch signed with a key the bank never pinned is rejected, whatever version it
claims", "PayrollHub refuses a bank certificate that is not the pinned one, even from the same CA, and sends nothing",
"the bank refuses a connection without PayrollHub's client certificate", "old batches still verify ...".

**Likely questions:**

- *Why sign if TLS already protects the transport?* TLS protects one hop. The signature protects the file itself:
  stored, resent, or forwarded, any change is detectable, and the bank can prove what PayrollHub sent.

## Part 2: Five pieces of code

All five were written by the AI (Claude Code) to the author's written specification, then reviewed, tested, and
mutation-checked before each layer was approved. "Specified" says what the author required, so it is clear which
design choices were the author's and which were the AI's.

### Piece 1: `withTenant` (the tenant scope)

**Files:** `data/db/tenant-scope.ts`, `data/db/scope-runner.ts`, `data/db/scope-state.ts`, `data/db/connection.ts`.

**Specified (Turn 3):** setting the tenant, running the queries, and clearing the tenant must happen in one
synchronous block with no await between them, and the API must make any other use impossible.

**Line by line:**

```ts
export function withTenant<T>(tenantId: string, fn: (scope: TenantScope) => Sync<T>): Sync<T> {
  if (!TENANT_ID.test(tenantId)) throw new Error("Invalid tenant id");
  return runScoped({ kind: "tenant", tenantId }, (tx) => new TenantScope(tenantId, tx), fn);
}
```

- `Sync<T>` is `T extends PromiseLike<unknown> ? never : T`. If `fn` is `async`, its return type is a Promise, which
  becomes `never`, and the call does not compile.
- The tenant id must match `^[a-z][a-z0-9-]{1,39}$` before anything happens.

```ts
const { db, scope: holder } = getConnection();
enterScope(holder, state);              // throws "Database scopes cannot be nested" if a scope is already open
let scope: S | undefined;
try {
  return db.transaction((tx) => {
    scope = makeScope(tx);
    const result = fn(scope);
    if (isThenable(result)) {           // an async callback slipped past the type check
      Promise.resolve(result).catch(() => {});
      throw new Error("Database scope callbacks must be synchronous ...; the transaction was rolled back");
    }
    return result;
  });
} finally {
  scope?.revoke();                       // the scope object stops working
  exitScope(holder);                     // current_tenant() is NULL again, even if fn threw
}
```

- `enterScope` stores the tenant on the **connection object** (`holder`), which `current_tenant()` reads. It refuses
  nesting, so code cannot open tenant B inside tenant A.
- `db.transaction` (better-sqlite3) is synchronous: the whole callback runs, then commits, or rolls back on a throw.
  Because JavaScript runs one synchronous block at a time, no other request can run between `enterScope` and
  `exitScope`.
- `isThenable` is the run-time backstop for the type: if a Promise comes back anyway, the transaction is rolled back
  and an error is thrown, because anything after the callback's first `await` would run after the tenant was cleared.
- `finally` always clears the tenant and revokes the scope object. A scope that escapes its block (saved in a variable)
  throws "Tenant scope used after its withTenant block ended".

Inside `TenantScope`: `read(view)` takes only tenant views. `insert` refuses a caller-supplied `tenantId` and fills
it itself. `update` and `delete` always add `tenant_id = <scope tenant>` to the caller's condition. The triggers check
all of this again in the database.

**Why the state is on the connection:** Next.js bundles pages and route handlers separately, so this module can be
loaded twice. When the state lived in the module, one copy set the tenant and another read NULL: pages saw no rows
(failing closed, but broken). That bug was found in Layer 2 and fixed by keeping the state on the shared connection,
with a regression test.

**Tests:** `tests/data/async-interleaving.test.ts`: "interleaved async requests for different tenants never see each
other's rows" (20 concurrent simulated requests x 15 rounds with random awaits), "an async callback is rejected and
its writes are rolled back", "a scope object that escapes its block cannot be used again", "scopes cannot be nested,
and the tenant is cleared even when the block throws", "a second copy of the data modules (as Next.js bundles create)
shares the connection's tenant context".

**Likely questions:**

- *Why not AsyncLocalStorage?* It would allow `await` inside the scope, and then other requests could run on the same
  connection while the tenant was set. The synchronous design makes that impossible rather than unlikely.
- *Doesn't synchronous database access block the server?* better-sqlite3 is synchronous by design; the transactions
  here are short, and SQLite has one writer anyway.
- *What if code calls the raw driver?* ESLint forbids importing it outside `data/db/`, and a scan test checks that.
  Writes are still refused by the triggers.

### Piece 2: the route wrapper

**File:** `application/http/route.ts`.

**Specified (Turn 5):** one reusable wrapper that every route must use, checking the session, validating the body
with strict Zod schemas, passing verified claims, and never taking the tenant from input; make it hard to skip; error
responses never leak internals.

**Line by line, `route.session`:**

```ts
checkInputs(spec);                                   // at module load: every schema strict, no tenant-named field
return wrap(async (request, raw, requestId) => {
  refuseCrossOrigin(request);                        // 1. non-GET from another origin: 403 (Fetch Metadata, then Origin)
  const pathTenant = takePathTenant(raw, spec.tenantInPath ?? false);   // removed from params: compare only
  const claims = requireSession(request.cookies, spec.roles);           // 2. DAL: session, MFA, role (401/403)
  requireSameTenant(spec.tenantInPath ?? false, pathTenant, claims.tenantId); // 3. path tenant = session tenant, or 403
  const inputs = await parseInputs(request, raw, spec);                 // 4. strict Zod: unknown fields are a 400
  return spec.handler({ request, requestId, ...inputs, session: claims, tenantId: claims.tenantId });  // 5.
});
```

- `requireStrict` runs when the route module loads. A schema that is not `z.strictObject`, or that has any key
  matching `/tenant/i`, throws, so the route cannot even start. Only `route.public` may take a `tenantId` path
  parameter, and then only to choose which tenant's sign-in page to show, never as a verified value.
- The order matters: origin, then authentication, then the tenant comparison, all before the body is parsed. An
  attacker without a session gets a 401 before any input is looked at.
- `wrap` gives every request an id. In the catch, `unstable_rethrow(err)` lets Next.js's own redirect and prerender
  signals through (swallowing one turned a page into a cached 500 during `next build`, a bug found in Layer 3). Every
  other error goes to `errorResponse`.
- `errorResponse` maps each known error class to a fixed public message. Validation errors list field paths and
  Zod's messages but never echo the submitted value. Anything unexpected is logged (redacted) and answered with
  `{ error: "Internal error", requestId }`: no stack, no SQL, no existence hints.
- `route.service` is the same for `/api/internal/*`: it accepts only `Authorization: Bearer <service token>` for
  exactly this endpoint and ignores cookies.

**Tests:** `tests/data/route-wrapper.test.ts` (including a rogue route file written to disk and caught by the scan,
and "an unexpected error returns a generic 500 with a request id"); `tests/threats/L2-04-route-handlers.test.ts`.

**Likely questions:**

- *How do you know every route uses it?* An ESLint rule rejects any other export shape in `app/**/route.ts`, and a
  test scans every route file. Both were shown to catch a deliberately written bypass.
- *Why both 401 and 403?* 401: not signed in (or MFA not done); 403: signed in but the wrong role or tenant.

### Piece 3: atomic token redemption

**Files:** `services/approval/repository.ts` (`redeemApprovalToken`), `services/approval/approval-service.ts`
(`prepareRedemption`, `redeemTicket`).

**Specified (Turn 7):** redemption sets `redeemed_at` in a single atomic update, so a second use and two simultaneous
uses both fail.

```ts
export function redeemApprovalToken(s: TenantScope, tokenId: string, now: Date): boolean {
  const changed = s.update("approvalToken", { redeemedAt: now }, (t) => and(eq(t.tokenId, tokenId), isNull(t.redeemedAt)));
  return changed === 1;
}
```

- The SQL is `UPDATE approval_token SET redeemed_at = ? WHERE tenant_id = ? AND token_id = ? AND redeemed_at IS NULL`.
  The check and the write are one statement, so there is no gap between "is it unused?" and "mark it used".
- `changed === 1` is true only for the first redemption. A replay finds `redeemed_at` already set and changes 0 rows.

Redemption happens in two steps (DV-34), so that it can sit inside the engine's synchronous transaction:

- `prepareRedemption` (async: signatures need `await`) verifies the engine's service token and the approval token,
  checks tenant and run, and returns a frozen **ticket**, recorded in a module-private `WeakSet`, so only this module
  can create one.
- `redeemTicket` (sync, inside the engine's transaction) refuses a ticket this module did not create, one for another
  tenant, or one older than 60 seconds. It checks the database record matches (run, approver, key version), is not
  expired, and that the run is approved by this approver. Only then does it call `redeemApprovalToken`; "already
  redeemed" if that returns false.

**The Turn 16 finding:** removing `isNull(t.redeemedAt)` no longer failed any test (278 of 278 passed). Since Layer 6,
`redeemTicket` also requires the run to be "approved", and after a successful run it is "computed", so a replay was
refused there first. But a run that **fails** while computing burns its token and can then be approved again, by the
same approver, with unchanged content. At that point only the token record knows the old token was used. The new test
replays the burned token in exactly that state. It fails without the guard and passes with it.

**Tests:** `tests/threats/L2-01-approval-tokens.test.ts`: "a replayed token is refused", "two concurrent redemptions:
exactly one succeeds"; `tests/threats/L2-02-engine-failure.test.ts`: "a token burned by a failed run cannot start the run
once the same approver has approved it again".

**Likely questions:**

- *Is the concurrent test meaningful in a single-threaded runtime?* It proves the outcome: three simultaneous
  `startRun` calls produce exactly one success. The atomic UPDATE is what keeps that true with more than one process
  or connection.
- *What does the lesson say about AI-written tests?* A test that passed when written can stop testing anything after
  later code changes. Mutation checks have to be repeated, not done once.

### Piece 4: the engine's single transaction

**File:** `services/engine/engine-service.ts`, `startRun`.

**Specified (Turn 8):** redemption, the run's status change, and writing all PayResult rows happen so that there is
never a burned token with half-written results; a failed computation leaves a clear failed state that needs
re-approval and no partial results.

**Phase 1, async, nothing written:**

```ts
const svc = await authorizeServiceCall(auth, { endpoint: "engine.startRun", tenantId: input.tenantId }); // single-use
const claims = await verifyApprovalToken(input.approvalToken);       // signature, EdDSA pinned, active kid, 5 min
if (claims.tenantId !== svc.tenantId) throw ...;                     // token for this tenant
if (claims.runId !== input.runId) throw ...;                         // and this run
const ticket = await prepareRedemption(await mintAsEngine("approval.redeemToken", svc.tenantId), input, now);
const reader = await openVerifiedAccountReader(...);                 // capability to read verified accounts
```

**Phase 2, one synchronous `withTenant` transaction:**

1. Re-read the run: it must be "approved", approved by this token's approver, and not created by them (D27).
2. `loadRunContent` reads the run, the tenant's withholding rate, and every active employee with pay rate and
   verified account, all from the database. `runContentHash` must equal the token's `rh` (D28), or
   `ContentChangedError`.
3. `redeemTicket`: the atomic redemption (piece 3).
4. For each employee: no verified account goes to `exceptions` (reported, not skipped silently or paid elsewhere);
   otherwise `computePay` (integer cents, half-up rounding, net within [0, gross]).
5. Insert all pay results and exceptions; `markRunComputed` moves the run from approved to computed, and throws if it
   was not approved.

If anything in phase 2 throws, SQLite rolls back all of it: the token is not redeemed, no results exist, and the run
is still approved.

**Phase 3, only on failure (`catch`):** expected refusals (a bad token, the wrong state) are rethrown and change
nothing. A content change or a computation error opens a second small transaction that burns the token and marks the
run `failed` with the reason, so the same approval cannot be retried; re-approval moves it back to approved.

**Why one transaction:** the two dangerous half-states are "token used, results missing" (the run can never be paid
without a new approval) and "results written, token unused" (the token could start the run again). One transaction
makes both impossible.

**Tests:** `tests/threats/L2-02-engine-failure.test.ts`: "leaves no partial results and a clear failed state;
re-approval then completes the run once" (the mock throws on the second employee: 0 results, failed, token burned);
`tests/threats/L2-02-payroll-engine.test.ts`: the rejection cases, D28 content changes, "same run twice", and the
hand-checked pay calculation.

**Likely questions:**

- *Why are amounts not taken from the request?* The start body is `z.strictObject({ approvalToken })`: amounts,
  employees, and accounts are rejected if sent, and everything comes from the database.
- *Why burn the token on failure instead of letting the approver retry?* A retry after a content change would pay
  content nobody approved. A new approval is a conscious decision.

### Piece 5: ACH idempotency and signing

**Files:** `services/ach/ach-service.ts`, `services/ach/nacha.ts`, `data/keys/kms.ts`, `partners/mock-bank/server.ts`.

**Specified (Turn 10):** an idempotency key derived from tenant and run, enforced by a unique constraint; a retry or
two concurrent submits return the one batch; the file built from PayResult rows, with totals checked before signing;
the exact bytes signed with a versioned key; the bank verifies against pinned keys over mTLS.

**Stage 1, `prepareBatch`, one transaction:**

```ts
const existing = getAchBatchStatusForRun(s, runId);
if (existing) return { kind: "batch", batch: existing };                     // idempotent: same run, same batch
if (run.status !== "computed") throw new ConflictError("Only a computed run can be sent to the bank");
const accounts = readPayableAccounts(reader, s, results.map((r) => r.bankAccountId), now);  // verified right now
const changed = results.filter((r) => !accounts.has(r.bankAccountId));
if (changed.length > 0) { markComputedRunFailed(s, runId, "bank_account_changed"); return ... }  // D35
const idempotencyKey = achIdempotencyKey(s.tenantId, runId);                  // sha256("payrollhub.ach-batch.v1\n" + tenant + "\n" + run)
const batchId = batchIdFor(idempotencyKey);                                   // written inside the signed file
const file = buildAchFile({ ... entries from PayResult rows and verified accounts ... });
checkControlTotals(file, { batchId, entryCount: paid.length, totalCreditCents });  // re-read from the exact text
const { signature, keyVersion } = signBytes("ach-batch", Buffer.from(file, "utf8"));
try { insertAchBatch(s, {..., status: "signed" }, file); }                    // file body encrypted at rest
catch (err) { if unique violation: return the batch the other writer stored }
```

- The batch is built only from PayResult rows and accounts verified at this moment; the request carries nothing
  (`disburseBody` is an empty strict object).
- `checkControlTotals` parses the generated text back and compares entry count, entry hash, and total credit with the
  pay results before anything is signed. A trigger (`migrations/0013_ach_integrity.sql`) checks the stored totals
  against `pay_result` again, refuses to store an unsigned batch, and makes a signed batch immutable.
- Building and signing happen in one transaction (DV-41), so no unsigned batch is ever stored.

**Stage 2, `deliver`:** reads the stored bytes and signature, verifies them with `verifyBytes` (a tampered stored file
is refused), sends them over mTLS with the pinned bank certificate, and records the answer. "Accepted", or
"duplicate" with the same file hash, counts as delivered: the batch becomes "sent" and the run "disbursed". A
duplicate with a different file is a rejection.

**At the bank:** it looks up its pinned public key for the claimed version (unknown: refused), verifies the 64-byte
Ed25519 signature over the exact body, checks the file's own control totals, then refuses a batch ID it already has,
saying whether it was the same file.

**Tests:** `tests/threats/L2-13-ach-idempotency.test.ts` (double, concurrent, timeout retry, database refusal, totals);
`tests/threats/L1-22-ach-signing.test.ts` (altered byte, unpinned key, unpinned bank certificate, missing client
certificate, rotation).

**Likely questions:**

- *What happens on a timeout?* The batch stays "signed". Pressing Send again resends the same stored bytes; the bank's
  duplicate check makes the second delivery harmless.
- *What if an employee's account changed after the run was computed?* The batch is refused, the run is closed with
  `bank_account_changed`, and HR creates a new run for the same pay date (D35, a known limitation).

## Part 3: Cross-cutting questions

- **"How do you know the tests test anything?"** Each control was broken on purpose and the matching tests were shown
  failing (a table per layer in the session log). Turn 16 also showed why this has to be repeated: one guard (piece 3)
  had become untested as the code grew.
- **"What did the AI get wrong?"** See [presentation-outline.md](presentation-outline.md#6-the-ai-pair-programming-story-25-min):
  the L0-01 timing claim, decisions made without asking, dead WAF rules, a mutation check where nothing ran, the
  double-pay gap, a dev-mode bug, scope incidents, and the untested guard.
- **"Is anything secret in the repository?"** No. Every password, TOTP secret, mailbox password, key, and certificate is
  generated per install into `.env` or `.data/`, both gitignored, and the ZIP builder refuses them.
- **"Where are the limits?"** README section 12: no real WAF or DDoS absorption, keys in files rather than an HSM,
  per-IP limits only behind a reverse proxy, in-process minting (DV-26), a contact email that cannot be changed, a bank
  change between compute and send forces a new run (D35), old browsers cannot submit forms (D39), and RT-15.
