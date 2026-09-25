import { db } from "@/lib/db";
import { sha256 } from "@/lib/util/text";

/**
 * Fixed-window rate limiting.
 *  - dbRateLimit: shared across serverless instances (used for admin login).
 *  - memoryRateLimit: per-instance, for high-volume public endpoints (analytics events,
 *    affiliate clicks) where a DB round-trip per request would be wasteful.
 */

export async function dbRateLimit(key: string, limit: number, windowMs: number): Promise<{ allowed: boolean; remaining: number }> {
  const id = sha256(key).slice(0, 40);
  const now = new Date();
  const windowStart = new Date(Math.floor(now.getTime() / windowMs) * windowMs);
  const rows = await db.$queryRaw<Array<{ count: number }>>`
    INSERT INTO "rate_limit_buckets" ("key", "windowStart", "count") VALUES (${id}, ${windowStart}, 1)
    ON CONFLICT ("key") DO UPDATE SET
      "count" = CASE WHEN "rate_limit_buckets"."windowStart" = ${windowStart} THEN "rate_limit_buckets"."count" + 1 ELSE 1 END,
      "windowStart" = ${windowStart}
    RETURNING "count"`;
  const count = Number(rows[0]?.count ?? 1);
  return { allowed: count <= limit, remaining: Math.max(0, limit - count) };
}

const buckets = new Map<string, { windowStart: number; count: number }>();

export function memoryRateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const b = buckets.get(key);
  if (!b || b.windowStart !== windowStart) {
    buckets.set(key, { windowStart, count: 1 });
    if (buckets.size > 50_000) {
      for (const [k, v] of buckets) if (v.windowStart !== windowStart) buckets.delete(k);
    }
    return true;
  }
  b.count++;
  return b.count <= limit;
}
