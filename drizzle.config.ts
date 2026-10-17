import { defineConfig } from "drizzle-kit";

// drizzle-kit generates the table migrations from data/db/tables.ts. The tenant-isolation views and triggers are a
// hand-written custom migration (migrations/0001_tenant_isolation.sql), applied in order by npm run db:migrate.
export default defineConfig({
  dialect: "sqlite",
  schema: "./data/db/tables.ts",
  out: "./migrations",
});
