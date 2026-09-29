import { config } from "@/lib/config";
import { safeFetch } from "@/lib/net/safe-fetch";

/**
 * Live site audit used by the admin UI: core routes, sitemap URLs and same-origin links on
 * crawled pages. Uses the SSRF-safe client, so private/loopback targets are refused.
 */

export const AUDIT_SEEDS = ["/", "/search?q=laptop", "/compare", "/about", "/disclosure", "/privacy", "/admin/login", "/robots.txt", "/sitemap.xml", "/api/health"];

export type AuditEntry = { url: string; status: number; ok: boolean; error?: string };

export async function runSiteAudit(maxUrls = 200) {
  const origin = new URL(config.siteUrl());
  const checked = new Map<string, AuditEntry>();
  const check = async (url: string) => {
    if (checked.has(url) || checked.size >= maxUrls) return;
    const res = await safeFetch(url, { method: "GET", timeoutMs: 10000, maxRedirects: 0, readBody: false });
    const redirectOk = res.status >= 300 && res.status < 400;
    checked.set(url, { url, status: res.status, ok: !res.error && (res.ok || redirectOk), error: res.error?.message });
  };
  for (const seed of AUDIT_SEEDS) await check(new URL(seed, origin).toString());

  const sitemap = await safeFetch(new URL("/sitemap.xml", origin).toString(), { readBody: true, timeoutMs: 15000, maxRedirects: 0, maxBytes: 10_000_000 });
  const locs = sitemap.ok ? [...(sitemap.body ?? "").matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)].map((m) => m[1].trim()) : [];
  for (const loc of locs) {
    try {
      const u = new URL(loc);
      if (u.origin === origin.origin) await check(u.toString());
      else checked.set(loc, { url: loc, status: 0, ok: false, error: "Sitemap URL is not on the site origin" });
    } catch {
      checked.set(loc, { url: loc, status: 0, ok: false, error: "Invalid sitemap URL" });
    }
  }
  const broken = [...checked.values()].filter((e) => !e.ok);
  return { base: origin.toString(), checked: checked.size, sitemapUrls: locs.length, broken: broken.length, errors: broken };
}
