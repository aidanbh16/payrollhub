# Developer rules


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
6. **No caching of tenant or user data (D17).** While Cache Components is off (DV-44), `"use cache"` has no effect, so
   this rule does not currently apply. It stays as a developer rule in case caching is turned back on: then nothing
   that holds tenant or user data may be marked `"use cache"`, because it would be served across users and tenants.
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
8. **Session reads in pages go inside `<Suspense>`** (a Cache Components rule, kept for the same reason as rule 6). `requirePageSession()` calls
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
    Routes under `/api/tenants`, `/api/admin`, the console and portal pages, and `/api/internal/*` are refused by Proxy
    without a live session (or a validly signed service token) before anything is counted (D45), so they need nothing
    extra; a new protected area must be added to `PROTECTED` in `proxy.ts`.
13. **Every threat test is tagged (D41).** A test that attacks a control for one of the 15 threats carries `[Lx-yy]`
    (primary control) or `[Lx-yy DiD]` (defense in depth) in its title or its `describe` title. `npm run
    traceability` must pass; regenerate the README table with `npm run traceability -- --write-readme`.

