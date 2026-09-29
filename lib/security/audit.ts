import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { sha256 } from "@/lib/util/text";

/**
 * Audit trail for admin and system mutations. IP addresses are stored only as a salted
 * hash (enough to correlate abuse, not to identify a person); user-agent is truncated.
 */

export type AuditContext = { actor: string; ip?: string | null; userAgent?: string | null };

type Client = Prisma.TransactionClient | typeof db;

function toJson(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

export function hashIp(ip?: string | null): string | undefined {
  if (!ip) return undefined;
  return sha256(`${process.env.ADMIN_SESSION_SECRET ?? "audit"}|${ip}`).slice(0, 24);
}

export async function audit(
  ctx: AuditContext,
  entry: { action: string; entityType: string; entityId: string; before?: unknown; after?: unknown; metadata?: unknown },
  client: Client = db,
) {
  await client.auditLog.create({
    data: {
      actor: ctx.actor,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      before: toJson(entry.before),
      after: toJson(entry.after),
      metadata: toJson(entry.metadata),
      ipHash: hashIp(ctx.ip),
      userAgent: ctx.userAgent?.slice(0, 200),
    },
  });
}

export const SYSTEM_ACTOR: AuditContext = { actor: "system" };
