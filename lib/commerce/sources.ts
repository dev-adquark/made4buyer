import seedFile from "@/data/commerce/sources.seed.json";
import { db } from "@/lib/db";

/**
 * Non-brand commerce sources (data/commerce/sources.seed.json). The seed lists third-party coupon
 * sites only so they are known and kept OFF: their terms generally forbid automated collection.
 * Imports never enable a source and never overwrite an admin's terms review, enabled flag or
 * start URLs; a source runs only after an admin records termsStatus APPROVED and then enables it.
 */

export const SOURCE_KINDS = ["COUPON_SITE", "RETAILER"] as const;
export const TERMS_STATUSES = ["UNREVIEWED", "APPROVED", "REJECTED"] as const;

export type SourceSeed = { name: string; slug: string; kind: string; domain: string; startUrls?: string[]; urlPatterns?: string[]; notes?: string };

export function readSourceSeed(data: unknown = seedFile): SourceSeed[] {
  const parsed = data as { sources?: unknown };
  if (!Array.isArray(parsed.sources)) throw new Error("sources.seed.json: missing sources array");
  return parsed.sources.map((x, i) => {
    const o = x as Record<string, unknown>;
    const str = (k: string) => (typeof o[k] === "string" && (o[k] as string).trim() ? (o[k] as string).trim() : "");
    if (!str("name") || !/^[a-z0-9-]{2,60}$/.test(str("slug")) || !str("domain")) throw new Error(`sources.seed.json: source ${i} needs name, slug and domain`);
    if (!(SOURCE_KINDS as readonly string[]).includes(str("kind"))) throw new Error(`sources.seed.json: source ${str("slug")} has unknown kind ${str("kind")}`);
    const list = (k: string) => (Array.isArray(o[k]) ? (o[k] as unknown[]).filter((v): v is string => typeof v === "string" && Boolean(v.trim())) : []);
    return { name: str("name"), slug: str("slug"), kind: str("kind"), domain: str("domain").toLowerCase(), startUrls: list("startUrls"), urlPatterns: list("urlPatterns"), notes: str("notes") || undefined };
  });
}

/** Creates missing sources (always disabled, terms UNREVIEWED); refreshes only descriptive fields of existing ones. */
export async function importCommerceSources(seed: SourceSeed[] = readSourceSeed()): Promise<{ created: number; updated: number }> {
  let created = 0;
  let updated = 0;
  for (const s of seed) {
    const existing = await db.commerceSource.findUnique({ where: { slug: s.slug }, select: { id: true } });
    if (existing) {
      await db.commerceSource.update({ where: { id: existing.id }, data: { name: s.name, kind: s.kind, domain: s.domain, ...(s.notes ? { notes: s.notes } : {}) } });
      updated++;
    } else {
      await db.commerceSource.create({ data: { name: s.name, slug: s.slug, kind: s.kind, domain: s.domain, startUrls: s.startUrls ?? [], urlPatterns: s.urlPatterns ?? [], notes: s.notes ?? null, enabled: false, termsStatus: "UNREVIEWED" } });
      created++;
    }
  }
  return { created, updated };
}

/** A source may be crawled only when enabled AND its terms were reviewed and approved. */
export function sourceRunnable(s: { enabled: boolean; termsStatus: string }): boolean {
  return s.enabled && s.termsStatus === "APPROVED";
}
