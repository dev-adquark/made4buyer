import crypto from "node:crypto";
import { db } from "@/lib/db";
import { log } from "@/lib/log";

/**
 * DB-backed job lock. Acquisition is a single atomic INSERT … ON CONFLICT DO UPDATE that
 * only succeeds if no lock exists or the existing lock has expired, so concurrent cron
 * invocations cannot both run and a crashed run's stale lock is recovered after its TTL.
 */

export class LockHeldError extends Error {
  constructor(name: string) {
    super(`Job "${name}" is already running`);
    this.name = "LockHeldError";
  }
}

export async function acquireLock(name: string, ttlMs: number): Promise<string | null> {
  const owner = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + ttlMs);
  const rows = await db.$queryRaw<Array<{ owner: string }>>`
    INSERT INTO "job_locks" ("name", "owner", "lockedAt", "expiresAt")
    VALUES (${name}, ${owner}, NOW(), ${expiresAt})
    ON CONFLICT ("name") DO UPDATE
      SET "owner" = EXCLUDED."owner", "lockedAt" = NOW(), "expiresAt" = EXCLUDED."expiresAt"
      WHERE "job_locks"."expiresAt" < NOW()
    RETURNING "owner"`;
  return rows[0]?.owner === owner ? owner : null;
}

export async function releaseLock(name: string, owner: string): Promise<void> {
  await db.jobLock.deleteMany({ where: { name, owner } });
}

export async function withLock<T>(name: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const owner = await acquireLock(name, ttlMs);
  if (!owner) throw new LockHeldError(name);
  try {
    return await fn();
  } finally {
    await releaseLock(name, owner).catch((error) => log.error("failed to release job lock", { job: name, error }));
  }
}
