import { runPlaywright, runVitest, runVitestProject, splitThreatArgs } from "./lib/test-runner";

// npm test [-- <threat ID>...] [vitest options]           e.g. npm test -- L2-11
//   (the parallel tests, then npm run test:isolated: the latency comparisons, on their own)
// npm run test:isolated [-- <threat ID>...] [vitest options]
// npm run test:e2e [-- <threat ID>...] [Playwright options] e.g. npm run test:e2e -- L0-01
// With threat IDs, only tests tagged [ID] or [ID DiD] run (tests/threat-registry.ts). Anything else passes through.
const [mode, ...args] = process.argv.slice(2);
try {
  const { ids, rest } = splitThreatArgs(args);
  process.exit(mode === "e2e" ? runPlaywright(ids, rest) : mode === "isolated" ? runVitestProject("isolated", ids, rest) : runVitest(ids, rest));
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
