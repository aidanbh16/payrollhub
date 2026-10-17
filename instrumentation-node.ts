import { env } from "@/config/env";
import { installConsoleRedaction, log } from "@/data/log/logger";
import { getRedis } from "@/edge/redis";

// Node.js-only startup (imported by instrumentation.ts on the Node.js runtime). Installs the redacting log pipeline
// first (L2-12), then checks configuration and the Redis connection up front, so a missing .env or a stopped Redis is
// reported at startup, not on the first login.
export async function startNodeServer(): Promise<void> {
  installConsoleRedaction();
  // Unhandled errors go through the same redaction. The monitor only observes; Node's own handling is unchanged.
  process.on("uncaughtExceptionMonitor", (error, origin) => log.error("process.uncaught_exception", { origin, error }));
  process.on("unhandledRejection", (reason) => log.error("process.unhandled_rejection", { error: reason }));

  try {
    env();
  } catch (err) {
    // Refuse to start with an invalid configuration (for example a non-loopback INTERNAL_API_ORIGIN, DV-36).
    log.error("startup.invalid_configuration", { message: (err as Error).message });
    process.exit(1);
  }
  try {
    const redis = await getRedis();
    log.info("startup.redis_connected", { ping: await redis.ping() });
  } catch (err) {
    log.error("startup.redis_unreachable", { message: (err as Error).message, hint: 'Start it with "docker compose up -d" (see README).' });
  }
}
