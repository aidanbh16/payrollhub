import { rmSync } from "node:fs";
import { env } from "@/config/env";
import { deleteDatabase, migrateDatabase } from "@/data/db/migrate";
import { SEED_TENANTS, seedDatabase } from "./lib/seed";

// Rebuilds the database from a clean state: delete the file and the stand-ins' data (IdP keys, mailboxes, the bank's
// ledger and trusted keys), apply every migration, seed. Certificates (PKI_DIR) and log files are kept.
async function main() {
  deleteDatabase();
  rmSync(env().MOCK_IDP_DIR, { recursive: true, force: true });
  rmSync(env().MOCK_MAIL_DIR, { recursive: true, force: true });
  rmSync(env().MOCK_BANK_DIR, { recursive: true, force: true });
  migrateDatabase();
  await seedDatabase();
  console.log(`Database reset: migrations applied, ${SEED_TENANTS.length} tenants seeded. Test logins: ${env().DEV_CREDENTIALS_FILE} (README section 4).`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
