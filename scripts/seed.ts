import { env } from "@/config/env";
import { SEED_TENANTS, seedDatabase } from "./lib/seed";

seedDatabase()
  .then(() => console.log(`Seeded ${SEED_TENANTS.length} tenants: ${SEED_TENANTS.map((t) => t.tenantId).join(", ")}. Test logins: ${env().DEV_CREDENTIALS_FILE} (README section 4).`))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
