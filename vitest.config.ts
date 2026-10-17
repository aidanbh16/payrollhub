import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

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
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
    // Some tests reseed the database (scrypt hashing) or run npm run setup in a child process; with every file running
    // in parallel the 5 s default is too tight for them. Assertions are unaffected.
    testTimeout: 20_000,
  },
});
