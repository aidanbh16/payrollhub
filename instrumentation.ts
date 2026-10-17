import type { Instrumentation } from "next";

// Runs once when the Next.js server starts. The Node.js-only work (log pipeline, process error hooks, configuration
// and Redis checks) lives in instrumentation-node.ts, imported only on the Node.js runtime.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startNodeServer } = await import("./instrumentation-node");
  await startNodeServer();
}

/**
 * Errors Next.js captures while serving a request (route handlers, Server Components, Proxy). Logged through the
 * redacting pipeline. Headers are not logged (cookies, authorization), and the path loses its query string (the
 * bank-change link carries a token there).
 */
export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { log } = await import("@/data/log/logger");
  log.error("request.unhandled_error", {
    method: request.method,
    path: request.path.split("?")[0],
    routePath: context.routePath,
    routeType: context.routeType,
    error,
  });
};
