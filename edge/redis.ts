import { createClient } from "redis";
import { env } from "@/config/env";
import { log } from "@/data/log/logger";

// Shared low-latency store for the distributed rate limiter (Assignment 5, Section 2.2).
// One client per server process, kept on globalThis so dev hot reloads do not open new connections.
function connect() {
  return createClient({
    url: env().REDIS_URL,
    socket: {
      connectTimeout: 2000,
      // The client's default retries forever, which would block server startup and every caller.
      // Give up after 3 attempts so callers get an error they can fail closed on.
      reconnectStrategy: (retries: number) => (retries >= 3 ? new Error("Redis unreachable") : retries * 200),
    },
  })
    .on("error", (err: Error) => log.error("redis.error", { message: err.message }))
    // Once the client stops for good, forget it so the next call opens a fresh connection.
    .on("end", () => {
      globalForRedis.payrollhubRedis = undefined;
    })
    .connect();
}

type RedisClient = Awaited<ReturnType<typeof connect>>;

const globalForRedis = globalThis as unknown as { payrollhubRedis?: Promise<RedisClient> };

export async function getRedis(): Promise<RedisClient> {
  const pending = (globalForRedis.payrollhubRedis ??= connect().catch((err: Error) => {
    // Drop the failed promise so the next call retries instead of reusing the failure.
    globalForRedis.payrollhubRedis = undefined;
    throw err;
  }));
  const client = await pending;
  // After its reconnect attempts run out, the client is closed for good (without an "end" event). Replace it, so
  // the app recovers on its own once Redis is back.
  if (!client.isOpen) {
    resetRedis();
    throw new Error("Redis client closed");
  }
  return client;
}

/** Forgets the current client (closing it if needed); the next getRedis() opens a new connection. */
export function resetRedis(): void {
  const pending = globalForRedis.payrollhubRedis;
  globalForRedis.payrollhubRedis = undefined;
  pending
    ?.then((client) => {
      if (client.isOpen) client.destroy();
    })
    .catch(() => {});
}
