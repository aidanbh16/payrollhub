import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// Raw SQL is banned outside migrations/. Every query goes through the Drizzle query builder,
// wrapped by the tenant-scoped repository, so values are always parameterized.
const RAW_SQL = "Raw SQL is banned in application code. Use the tenant-scoped repository; raw SQL belongs only in migrations/.";
const DB_INTERNAL =
  "Application code reaches the database only through withTenant() (@/data/db/tenant-scope) and the views (@/data/db/views).";
const PLATFORM = "withPlatform() is reserved for Identity & Access (services/identity/) and scripts/.";

const rawSqlImport = [
  { name: "drizzle-orm", importNames: ["sql"], message: RAW_SQL },
  { name: "drizzle-orm/sql", message: RAW_SQL },
];
const dbHandleImport = [
  { name: "better-sqlite3", message: DB_INTERNAL },
  { name: "drizzle-orm/better-sqlite3", message: DB_INTERNAL },
];

// Everything under data/db/ is internal except the tenant scope and the views.
const dbInternals = (...alsoAllowed) => ({
  group: ["**/data/db/*", "!**/data/db/tenant-scope", "!**/data/db/views", ...alsoAllowed.map((m) => `!**/data/db/${m}`)],
  message: DB_INTERNAL,
});
const platformScope = { group: ["**/data/db/platform-scope"], message: PLATFORM };

// Drizzle's db.run/all/get/values accept plain SQL strings. Those method names are also common elsewhere
// (headers.get("origin")), so they are flagged when the string starts with an SQL keyword. The driver-only
// exec/prepare are flagged with any string.
const SQL_START = String.raw`/^\s*(select|insert|update|delete|with|create|drop|alter|pragma|attach|detach|replace|vacuum|reindex)\b/i`;
const stringArgSql = [
  `CallExpression[callee.property.name=/^(run|all|get|values)$/][arguments.0.type='Literal'][arguments.0.value=${SQL_START}]`,
  `CallExpression[callee.property.name=/^(run|all|get|values)$/][arguments.0.type='TemplateLiteral'][arguments.0.quasis.0.value.cooked=${SQL_START}]`,
  "CallExpression[callee.property.name=/^(exec|prepare)$/][arguments.0.type=/^(Literal|TemplateLiteral)$/]",
].map((selector) => ({ selector, message: RAW_SQL }));

// L2-01: approval tokens (and everything else sensitive) stay out of browser storage. Client code keeps them in memory.
const BROWSER_STORAGE = "Do not use browser storage: keep tokens and sensitive data in memory only (L2-01).";
const browserStorageGlobals = ["localStorage", "sessionStorage", "indexedDB"].map((name) => ({ name, message: BROWSER_STORAGE }));
const browserStorageProperties = [
  ...["localStorage", "sessionStorage", "indexedDB", "cookieStore"].map((property) => ({ object: "window", property, message: BROWSER_STORAGE })),
  { object: "document", property: "cookie", message: BROWSER_STORAGE },
];

const rawSqlSyntax = {
  "no-restricted-syntax": ["error", { selector: "TaggedTemplateExpression[tag.name='sql']", message: RAW_SQL }, ...stringArgSql],
  "no-restricted-properties": ["error", { property: "$client", message: RAW_SQL }, ...browserStorageProperties],
  "no-restricted-globals": ["error", ...browserStorageGlobals, { name: "cookieStore", message: BROWSER_STORAGE }],
};

const FULL_NUMBERS = "Full bank account numbers are for ACH Disbursement only (DV-43): use the Bank Account service's last-4 reads.";
const UI_LAYER = "UI code calls only the route handlers (fetch /api/...); it may not import services, data, partners, or minting (Layer 9).";

const HTTP_METHODS ="/^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/";
const ROUTE_WRAPPER =
  "Route handlers must be exported as `export const METHOD = route.session(...) | route.service(...) | route.public(...)` (application/http/route.ts).";

// DV-26: each service mints service tokens only as itself, through its own handle (mint-as-<caller>.ts), which can be
// imported only from inside that service's folder. Nothing else may call mintServiceToken directly.
const MINT =
  "Mint service tokens only through your own service's handle, imported as @/<folder>/mint-as-<caller> from inside that service's folder (DV-26).";
const MINT_HANDLES = { bff: "application/mint-as-bff", approval: "services/approval/mint-as-approval", engine: "services/engine/mint-as-engine", ach: "services/ach/mint-as-ach", "bank-account": "services/bank-account/mint-as-bank-account" };
const mintFunction = { name: "@/services/identity/service-tokens", importNames: ["mintServiceToken"], message: MINT };
const mintHandles = (ownCaller) => ({
  group: ["**/mint-as-*", ...(ownCaller ? [`!**/${MINT_HANDLES[ownCaller]}`] : [])],
  message: MINT,
});

/** no-restricted-imports for application code. Each folder block passes what it alone is allowed to import. */
const appImports = ({ allowDb = [], allowPlatform = false, ownCaller = null, allowMintFunction = false } = {}) => ({
  "no-restricted-imports": [
    "error",
    {
      paths: [...rawSqlImport, ...dbHandleImport, ...(allowMintFunction ? [] : [mintFunction])],
      patterns: [dbInternals(...allowDb, ...(allowPlatform ? ["platform-scope"] : [])), ...(allowPlatform ? [] : [platformScope]), mintHandles(ownCaller)],
    },
  ],
});

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Runtime data, including the browser tests' development build (.data/e2e/next-dev).
    ".data/**",
  ]),
  {
    // Application code: no raw SQL, no database internals, no platform scope, no minting service tokens.
    ignores: ["migrations/**", "data/db/**", "tests/**", "e2e/**"],
    rules: { ...appImports(), ...rawSqlSyntax },
  },
  {
    // The Next.js application layer (route handlers) calls services as "bff".
    files: ["app/**", "application/**"],
    rules: { ...appImports({ ownCaller: "bff" }), ...rawSqlSyntax },
  },
  ...["approval", "engine", "ach", "bank-account"].map((caller) => ({
    files: [`services/${caller}/**`],
    rules: { ...appImports({ ownCaller: caller }), ...rawSqlSyntax },
  })),
  {
    // The handles themselves are the only callers of mintServiceToken.
    files: ["**/mint-as-*.ts"],
    rules: { ...appImports({ allowMintFunction: true }), ...rawSqlSyntax },
  },
  {
    // Route files: every exported HTTP method must be built by the one handler wrapper (application/http/route.ts),
    // so no route can skip session or token checks, strict validation, the tenant check, or generic errors.
    files: ["app/**/route.ts"],
    rules: {
      "no-restricted-syntax": [
        ...rawSqlSyntax["no-restricted-syntax"],
        ...[
          `ExportNamedDeclaration > FunctionDeclaration[id.name=${HTTP_METHODS}]`,
          `ExportNamedDeclaration > VariableDeclaration > VariableDeclarator[id.name=${HTTP_METHODS}]:not([init.type='CallExpression'][init.callee.object.name='route'][init.callee.property.name=/^(session|service|public)$/])`,
          "ExportNamedDeclaration[source]",
          "ExportNamedDeclaration > ExportSpecifier",
          "ExportDefaultDeclaration",
        ].map((selector) => ({ selector, message: ROUTE_WRAPPER })),
      ],
    },
  },
  {
    // DV-43: full account numbers reach only ACH Disbursement. Outside the Bank Account service, nothing imports its
    // repository (which decrypts), and only ACH may import the payable-account reader. ServiceGrant enforces the same
    // at run time (only "ach" holds bankAccount.readPayable). Uses the typescript-eslint rule so it stacks with the
    // core no-restricted-imports rules above instead of replacing them.
    files: ["**/*.{ts,tsx}"],
    ignores: ["tests/**", "e2e/**", "scripts/**", "migrations/**", "services/bank-account/**"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          paths: [{ name: "@/services/bank-account/bank-account-service", importNames: ["openPayableAccountReader", "readPayableAccounts"], message: FULL_NUMBERS }],
          patterns: [{ group: ["**/services/bank-account/repository"], message: FULL_NUMBERS }],
        },
      ],
    },
  },
  {
    files: ["services/ach/**"],
    rules: { "@typescript-eslint/no-restricted-imports": ["error", { patterns: [{ group: ["**/services/bank-account/repository"], message: FULL_NUMBERS }] }] },
  },
  {
    // Section 2.1 / Layer 9: the UI (pages, layouts, components) calls only the route handlers. It imports no service,
    // data, partner, or token-minting code; types are allowed. Pages may use the session gate (application/auth/dal) to
    // decide where to send a visitor, and nothing else on the server.
    files: ["app/**/*.tsx"],
    ignores: ["app/api/**", "app/mock-idp/**"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/services/*", "@/services/**", "@/data/*", "@/data/**", "@/partners/**", "@/edge/**", "@/application/mint-as-*", "@/application/http/*"],
              allowTypeImports: true,
              message: UI_LAYER,
            },
          ],
        },
      ],
    },
  },
  {
    // L2-12: every log line goes through the redacting logger (data/log/logger.ts). CLI scripts print to the terminal
    // and tests may spy on the console; nothing else calls console.* directly.
    files: ["**/*.{ts,tsx,mjs,js}"],
    ignores: ["scripts/**", "tests/**", "e2e/**", "data/log/logger.ts", "eslint.config.mjs", "*.config.*"],
    rules: { "no-console": "error" },
  },
  {
    // Identity & Access owns ServiceGrant, so it may open a platform scope.
    files: ["services/identity/**"],
    rules: { ...appImports({ allowPlatform: true }), ...rawSqlSyntax },
  },
  {
    // Scripts may also run migrations.
    files: ["scripts/**"],
    rules: { ...appImports({ allowPlatform: true, allowDb: ["migrate"] }), ...rawSqlSyntax },
  },
  {
    // The data layer may open the database, but still may not write raw SQL.
    files: ["data/db/**"],
    ignores: ["data/db/tables.ts"],
    rules: { "no-restricted-imports": ["error", { paths: rawSqlImport }], ...rawSqlSyntax },
  },
  {
    // D23: the one exception. In the schema file the sql tag may appear only as the expression of a check(...)
    // constraint, which drizzle-kit compiles into migrations/. Any other sql use here is still an error.
    files: ["data/db/tables.ts"],
    rules: {
      "no-restricted-imports": "off",
      "no-restricted-syntax": [
        "error",
        {
          selector: "TaggedTemplateExpression[tag.name='sql']:not(CallExpression[callee.name='check'] > TaggedTemplateExpression)",
          message: "In tables.ts the sql tag is allowed only as a check(...) constraint expression (D23).",
        },
        { selector: "MemberExpression[object.name='sql']", message: "sql.raw/sql.join/etc. are not allowed (D23)." },
        { selector: "CallExpression[callee.name='sql']", message: "sql(...) calls are not allowed (D23)." },
        ...stringArgSql,
      ],
      "no-restricted-properties": rawSqlSyntax["no-restricted-properties"],
    },
  },
]);

export default eslintConfig;
