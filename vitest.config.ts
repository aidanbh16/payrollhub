import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

const root = fileURLToPath(new URL("./", import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@\//, replacement: root },
      // Next.js resolves server-only to an empty module on the server; tests run server-side too.
      { find: "server-only", replacement: `${root}node_modules/server-only/empty.js` },
    ],
  },
  test: {
    setupFiles: ["tests/setup.ts"],
    // Some tests reseed the database (scrypt hashing) or run npm run setup in a child process; with every file running
    // in parallel the 5 s default is too tight for them. Assertions are unaffected.
    testTimeout: 20_000,
    // npm test runs these one after the other (scripts/lib/test-runner.ts), never together.
    projects: [
      // Every test file, in parallel.
      { extends: true, test: { name: "parallel", include: ["tests/**/*.test.ts"], exclude: [...configDefaults.exclude, "tests/isolated/**"] } },
      // Latency comparisons (the L0-01 sign-in timing test), run alone so load from other test files cannot skew them.
      { extends: true, test: { name: "isolated", include: ["tests/isolated/**/*.test.ts"], fileParallelism: false } },
    ],
  },
});
