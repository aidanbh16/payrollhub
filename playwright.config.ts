import { defineConfig, devices } from "@playwright/test";
import { E2E_BANK_PORT, E2E_ORIGIN, E2E_PORT, childEnv } from "./e2e/env";

// Browser end-to-end tests (Layer 9): the full flow in real Chromium against `next start` and the stand-in bank, from
// a clean seed. Run with `npm run test:e2e` (builds first; needs Redis). See e2e/env.ts for the isolated data folder.
export default defineConfig({
  testDir: "e2e",
  workers: 1,
  fullyParallel: false,
  timeout: 180_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  outputDir: ".data/e2e/test-results",
  use: { baseURL: E2E_ORIGIN, trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      // A clean seed every run, then the production build.
      command: `npm run db:reset && npm run start -- -p ${E2E_PORT}`,
      url: `${E2E_ORIGIN}/login`,
      env: childEnv(),
      reuseExistingServer: false,
      timeout: 180_000,
    },
    { command: "npm run bank", port: E2E_BANK_PORT, env: childEnv(), reuseExistingServer: false, timeout: 60_000 },
  ],
});
