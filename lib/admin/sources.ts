import type { ContentRights } from "@prisma/client";
import { hostAllowed } from "@/lib/pipeline/apify";
import { validateOutboundUrl } from "@/lib/net/safe-fetch";
import { CATEGORY_BY_SLUG } from "@/lib/taxonomy/definitions";

/** Parses and validates the Admin → Sources form. Every URL must be public https on an allowed domain. */
export type SourceInput = {
  slug: string;
  name: string;
  homepageUrl: string;
  allowedDomains: string[];
  startUrls: string[];
  reviewUrlPatterns: string[];
  categoryHint: string | null;
  crawlFrequencyHours: number;
  maxPagesPerRun: number;
  rights: ContentRights;
  notes: string | null;
};

const list = (v: string) => v.split(/[\n,]+/).map((x) => x.trim()).filter(Boolean);
const httpsPublic = (u: string) => {
  const r = validateOutboundUrl(u, { standardPortsOnly: true });
  return Boolean(r.url && r.url.protocol === "https:");
};

export function parseSourceForm(get: (name: string) => string): { ok: true; value: SourceInput } | { ok: false; error: string } {
  const slug = get("slug").toLowerCase();
  const name = get("name");
  const homepageUrl = get("homepageUrl");
  const allowedDomains = list(get("allowedDomains")).map((d) => d.toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, ""));
  const startUrls = list(get("startUrls"));
  const reviewUrlPatterns = list(get("reviewUrlPatterns"));
  const categoryHint = get("categoryHint") || null;
  const crawlFrequencyHours = Number(get("crawlFrequencyHours") || 24);
  const maxPagesPerRun = Number(get("maxPagesPerRun") || 20);
  const rights = get("rights") === "LICENSED" ? "LICENSED" : "EXCERPT_ONLY";
  if (!/^[a-z0-9-]{2,40}$/.test(slug)) return { ok: false, error: "Slug: 2–40 lowercase letters, digits or dashes" };
  if (!name || name.length > 80) return { ok: false, error: "Name is required (max 80 characters)" };
  if (!httpsPublic(homepageUrl)) return { ok: false, error: "Homepage must be a public https:// URL" };
  if (!allowedDomains.length || allowedDomains.some((d) => !/^(\*\.)?[a-z0-9.-]+\.[a-z]{2,}$/.test(d))) return { ok: false, error: "Allowed domains: one or more domain names, e.g. example.com" };
  if (!startUrls.length || startUrls.length > 10) return { ok: false, error: "Add 1–10 start (listing) URLs" };
  for (const u of startUrls) if (!httpsPublic(u) || !hostAllowed(u, allowedDomains)) return { ok: false, error: `Start URL must be https and on an allowed domain: ${u}` };
  if (!reviewUrlPatterns.length || reviewUrlPatterns.length > 10) return { ok: false, error: "Add 1–10 review URL patterns, e.g. https://example.com/reviews/**" };
  for (const p of reviewUrlPatterns) {
    const sample = p.replace(/\*+/g, "x");
    if (!/^https:\/\//.test(p) || !hostAllowed(sample, allowedDomains)) return { ok: false, error: `Review URL pattern must be https and on an allowed domain: ${p}` };
  }
  if (categoryHint && !CATEGORY_BY_SLUG.has(categoryHint)) return { ok: false, error: "Unknown category" };
  if (!Number.isInteger(crawlFrequencyHours) || crawlFrequencyHours < 6 || crawlFrequencyHours > 720) return { ok: false, error: "Crawl frequency: 6–720 hours" };
  if (!Number.isInteger(maxPagesPerRun) || maxPagesPerRun < 1 || maxPagesPerRun > 200) return { ok: false, error: "Pages per run: 1–200" };
  return { ok: true, value: { slug, name, homepageUrl, allowedDomains, startUrls, reviewUrlPatterns, categoryHint, crawlFrequencyHours, maxPagesPerRun, rights, notes: get("notes").slice(0, 1000) || null } };
}
