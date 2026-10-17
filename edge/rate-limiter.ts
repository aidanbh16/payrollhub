import { env } from "@/config/env";
import { getRedis, resetRedis } from "./redis";

// Distributed rate limiter (L1-05, L0-11; Assignment 5, Section 2.2). Counters live in Redis, shared by every app
// process. One Lua script updates every bucket for a request in a single atomic step, so concurrent requests cannot
// race past a limit: Redis runs scripts one at a time, and each request sees the state its own update produced.
// Two bucket kinds:
//   window  - fixed window: at most `max` requests per `windowMs`.
//   backoff - progressive delay (D25): the first `free` attempts are immediate; after that each attempt must wait
//             baseMs, 2x, 4x, ... (capped at maxMs) after the previous allowed one. An attempt that comes too early is
//             refused with Retry-After and does not add to the penalty. The server never sleeps or holds a request.
//             The state resets after idleMs without an allowed attempt.

export interface WindowBucket {
  kind?: "window";
  /** Counter name, without the global prefix. Never contains raw emails or cookies (they are hashed). */
  key: string;
  max: number;
  windowMs: number;
}

export interface BackoffBucket {
  kind: "backoff";
  key: string;
  free: number;
  baseMs: number;
  maxMs: number;
  idleMs: number;
}

export type Bucket = WindowBucket | BackoffBucket;

export type Decision = { allowed: true } | { allowed: false; retryAfterSeconds: number; bucket: string };

/** Redis could not be consulted in time. The caller decides between failing closed (D20) and continuing. */
export class RateLimiterUnavailable extends Error {}

// ARGV[1] = now (ms); then five arguments per key: kind, then the bucket's numbers. Returns [blocked, retryMs] per key.
const CONSUME = `
local now = tonumber(ARGV[1])
local out = {}
for i, key in ipairs(KEYS) do
  local base = 1 + (i - 1) * 5
  local kind = ARGV[base + 1]
  if kind == 'w' then
    local max, window = tonumber(ARGV[base + 2]), tonumber(ARGV[base + 3])
    local count = redis.call('INCR', key)
    if count == 1 then redis.call('PEXPIRE', key, window) end
    out[#out + 1] = (count > max) and 1 or 0
    out[#out + 1] = redis.call('PTTL', key)
  else
    local free, step, cap, idle = tonumber(ARGV[base + 2]), tonumber(ARGV[base + 3]), tonumber(ARGV[base + 4]), tonumber(ARGV[base + 5])
    local nextAt = tonumber(redis.call('HGET', key, 'next') or '0')
    if now < nextAt then
      out[#out + 1] = 1
      out[#out + 1] = nextAt - now
    else
      local count = redis.call('HINCRBY', key, 'count', 1)
      if count >= free then
        redis.call('HSET', key, 'next', now + math.min(step * math.pow(2, count - free), cap))
      end
      redis.call('PEXPIRE', key, idle)
      out[#out + 1] = 0
      out[#out + 1] = 0
    end
  end
end
return out`;

const TIMEOUT_MS = 300;
// After a failure, skip Redis for a moment instead of opening a new connection attempt per request.
const BACKOFF_MS = 2000;
const breaker = globalThis as unknown as { payrollhubLimiterDownUntil?: number };

function withTimeout<T>(promise: Promise<T>): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("rate limiter timeout")), TIMEOUT_MS)),
  ]);
}

type Redis = Awaited<ReturnType<typeof getRedis>>;

/** Runs a Redis call for the edge layer with a timeout, a short circuit breaker, and recovery after failure. */
export async function edgeRedis<T>(call: (redis: Redis, prefix: string) => Promise<T>): Promise<T> {
  if ((breaker.payrollhubLimiterDownUntil ?? 0) > Date.now()) throw new RateLimiterUnavailable("rate limiter backing off");
  try {
    const redis = await withTimeout(getRedis());
    return await withTimeout(call(redis, env().RATE_LIMIT_PREFIX));
  } catch (err) {
    breaker.payrollhubLimiterDownUntil = Date.now() + BACKOFF_MS;
    // A timed-out or failed client may be stuck; start fresh on the next attempt after the backoff.
    resetRedis();
    throw new RateLimiterUnavailable((err as Error).message);
  }
}

function args(bucket: Bucket): string[] {
  return bucket.kind === "backoff"
    ? ["b", String(bucket.free), String(bucket.baseMs), String(bucket.maxMs), String(bucket.idleMs)]
    : ["w", String(bucket.max), String(bucket.windowMs), "0", "0"];
}

export async function consume(buckets: readonly Bucket[]): Promise<Decision> {
  const result = await edgeRedis((redis, prefix) =>
    redis.eval(CONSUME, {
      keys: buckets.map((b) => `${prefix}:${b.key}`),
      arguments: [String(Date.now()), ...buckets.flatMap(args)],
    }),
  );
  const values = (result as number[]).map(Number);
  let blocked: Decision = { allowed: true };
  buckets.forEach((bucket, i) => {
    if (values[i * 2] !== 1) return;
    const retryAfterSeconds = Math.max(1, Math.ceil(values[i * 2 + 1] / 1000));
    if (blocked.allowed || retryAfterSeconds > blocked.retryAfterSeconds) blocked = { allowed: false, retryAfterSeconds, bucket: bucket.key };
  });
  return blocked;
}
