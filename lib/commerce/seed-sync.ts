import seedFile from "@/data/commerce/brands.seed.json";
import { db } from "@/lib/db";
import { log } from "@/lib/log";
import { validateOutboundUrl } from "@/lib/net/safe-fetch";
import { audit, SYSTEM_ACTOR } from "@/lib/security/audit";
import { sha256 } from "@/lib/util/text";

/**
 * Seed refresh for brands that already exist. Production brands were imported before some seed
 * fields existed (dealUrls, productUrls …), and the seed import only runs on an empty table. When the
 * seed file's content hash differs from AutomationSetting "brand_seed_hash", every existing brand
 * (matched by slug) gets its EMPTY dealUrls / productUrls / productUrlPatterns / promoUrls filled from
 * the seed. A list an admin has set (non-empty) is never touched; brands are never created or
 * deleted here. Seed URLs must be public https URLs on the brand's CURRENT official domain (or its
 * subdomains); patterns must start with https://<officialDomain>/. Then the hash is stored, so an
 * unchanged seed costs one settings read.
 */

export const SEED_HASH_KEY = "brand_seed_hash";
export const SYNC_FIELDS = ["dealUrls", "productUrls", "productUrlPatterns", "promoUrls"] as const;
type SyncField = (typeof SYNC_FIELDS)[number];
const MAX_ITEMS = 20;

export type SeedSyncResult = { status: "UNCHANGED" | "SYNCED"; hash: string; filled: Array<{ slug: string; fields: SyncField[] }>; skipped: Array<{ slug: string; field: SyncField; reason: string }> };

const strings = (v: unknown): string[] => (Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean))] : []);

function onDomain(url: URL, officialDomain: string): boolean {
  const official = officialDomain.toLowerCase();
  if (url.host === official) return true;
  const base = official.replace(/:\d+$/, "").replace(/^www\./, "");
  return url.hostname === base || url.hostname.endsWith(`.${base}`);
}

/** Why a seed list may not be copied onto this brand, or null when it may. */
export function seedListProblem(field: SyncField, values: string[], officialDomain: string): string | null {
  if (values.length > MAX_ITEMS) return `more than ${MAX_ITEMS} entries`;
  if (field === "productUrlPatterns") {
    const prefix = `https://${officialDomain.toLowerCase()}/`;
    const bad = values.find((p) => !p.toLowerCase().startsWith(prefix) || /\s/.test(p) || p.length > 300);
    return bad ? `pattern not on ${prefix}: ${bad}` : null;
  }
  for (const v of values) {
    const r = validateOutboundUrl(v, { standardPortsOnly: true });
    if (!r.url || r.url.protocol !== "https:") return `not a public https URL: ${v}`;
    if (!onDomain(r.url, officialDomain)) return `not on ${officialDomain}: ${v}`;
  }
  return null;
}

export async function syncSeedFields(seed: unknown = seedFile, opts: { actor?: string } = {}): Promise<SeedSyncResult> {
  const hash = sha256(JSON.stringify(seed ?? null));
  const stored = await db.automationSetting.findUnique({ where: { key: SEED_HASH_KEY } });
  if (stored?.value === hash) return { status: "UNCHANGED", hash, filled: [], skipped: [] };

  const entries = (Array.isArray(seed) ? seed : []).filter((x): x is Record<string, unknown> => !!x && typeof x === "object" && typeof (x as Record<string, unknown>).slug === "string");
  const bySlug = new Map(entries.map((e) => [String(e.slug), e]));
  const brands = bySlug.size ? await db.commerceBrand.findMany({ where: { slug: { in: [...bySlug.keys()] } } }) : [];
  const filled: SeedSyncResult["filled"] = [];
  const skipped: SeedSyncResult["skipped"] = [];
  for (const b of brands) {
    const e = bySlug.get(b.slug)!;
    const data: Partial<Record<SyncField, string[]>> = {};
    for (const f of SYNC_FIELDS) {
      const values = strings(e[f]);
      if (!values.length || b[f].length) continue; // only EMPTY fields; an admin's list always wins
      const problem = seedListProblem(f, values, b.officialDomain);
      if (problem) {
        skipped.push({ slug: b.slug, field: f, reason: problem });
        continue;
      }
      data[f] = values;
    }
    const fields = Object.keys(data) as SyncField[];
    if (!fields.length) continue;
    // Guarded write: only while every filled field is still empty (an admin edit in between wins).
    const r = await db.commerceBrand.updateMany({ where: { id: b.id, AND: fields.map((f) => ({ [f]: { isEmpty: true } })) }, data });
    if (r.count) {
      filled.push({ slug: b.slug, fields });
      try {
        await audit(SYSTEM_ACTOR, { action: "BRAND_SEED_SYNCED", entityType: "commerce_brand", entityId: b.id, before: Object.fromEntries(fields.map((f) => [f, []])), after: data, metadata: { slug: b.slug, reason: "empty fields filled from brands.seed.json" } });
      } catch (error) {
        log.warn("commerce seed sync audit failed", { stage: "COMMERCE", brand: b.slug, error: String(error).slice(0, 200) });
      }
    }
  }
  const actor = opts.actor ?? "system:seed-sync";
  await db.automationSetting.upsert({ where: { key: SEED_HASH_KEY }, create: { key: SEED_HASH_KEY, value: hash, updatedBy: actor }, update: { value: hash, updatedBy: actor } });
  if (filled.length || skipped.length) log.info("commerce seed sync", { stage: "COMMERCE", filled: filled.length, skipped: skipped.length });
  return { status: "SYNCED", hash, filled, skipped };
}
