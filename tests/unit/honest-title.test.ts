import { describe, expect, it } from "vitest";
import { honestTitle, misleadingYears, newestSourceDate, titleYears, titleYearsExempt } from "@/lib/content/honest-title";
import { normalizeContent, withOriginalTitle } from "@/lib/pipeline/normalize";
import { validateContentItem } from "@/lib/pipeline/validate";

const d2019 = new Date("2019-07-19T00:00:00Z");
const clean = (title: string, date: Date | null = d2019) => honestTitle(title, date).title;

describe("honestTitle", () => {
  it.each([
    ["ExpressVPN Review (2026)", "ExpressVPN Review"],
    ["ExpressVPN Review [2026]", "ExpressVPN Review"],
    ["ExpressVPN Review (Updated October 2026)", "ExpressVPN Review"],
    ["ExpressVPN Review (2026 Update)", "ExpressVPN Review"],
    ["ExpressVPN Review 2026: Is It Still Worth It?", "ExpressVPN Review: Is It Still Worth It?"],
    ["Best VPN 2026: tested and ranked", "Best VPN: tested and ranked"],
    ["The Best VPNs for 2026", "The Best VPNs"],
    ["The Best VPNs for 2026: Our Picks", "The Best VPNs: Our Picks"],
    ["Best VPNs for Gaming in 2026", "Best VPNs for Gaming"],
    ["Best Cloud Storage of 2026 — Tested", "Best Cloud Storage — Tested"],
    ["ClickUp 2026 Review: Features and Pricing", "ClickUp Review: Features and Pricing"],
    ["NordVPN Review 2026", "NordVPN Review"],
    ["NordVPN Review – 2026 – Tested", "NordVPN Review – Tested"],
    ["NordVPN Review | 2026", "NordVPN Review"],
    ["2026 Surfshark Review: Fast and Cheap", "Surfshark Review: Fast and Cheap"],
    ["2026's best cloud storage services", "Best cloud storage services"],
    ["Icedrive review, as of 2026", "Icedrive review"],
    ["Sync.com Review (Tested in 2026)", "Sync.com Review"],
    ["Best VPN 2026 Edition: our picks", "Best VPN: our picks"],
  ])("removes the misleading year: %s", (input, expected) => {
    const r = honestTitle(input, d2019);
    expect(r.title).toBe(expected);
    expect(r.changed).toBe(true);
    expect(r.removedYears).toEqual([2026]);
  });

  it("removes only the years newer than the source date when several appear", () => {
    expect(clean("Best VPN 2019 vs 2026", d2019)).toBe("Best VPN 2019");
    expect(honestTitle("Best laptops of 2025 and 2026", new Date("2024-03-08Z"))).toMatchObject({ title: "Best laptops", removedYears: [2025, 2026] });
  });

  it("keeps years at or before the newest source date", () => {
    expect(honestTitle("Best VPN 2019", d2019)).toMatchObject({ title: "Best VPN 2019", changed: false });
    expect(honestTitle("Best VPN 2018 retrospective", d2019).changed).toBe(false);
    // The newest of published/updated counts.
    const newest = newestSourceDate(new Date("2021-03-22Z"), new Date("2026-01-04Z"));
    expect(honestTitle("NordVPN Review 2026", newest).changed).toBe(false);
  });

  it("leaves the title alone when the source gives no date", () => {
    expect(honestTitle("NordVPN Review 2026", null)).toMatchObject({ title: "NordVPN Review 2026", changed: false });
    expect(honestTitle("NordVPN Review 2026", undefined).changed).toBe(false);
    expect(honestTitle("NordVPN Review 2026", new Date("nope")).changed).toBe(false);
    expect(newestSourceDate(null, undefined)).toBeNull();
  });

  it("does not treat other numbers as years", () => {
    for (const t of ["iPhone 17 Pro review", "Best 1080p monitors", "Samsung 2026-inch display", "Galaxy S2026x review", "Season 2025/26 preview", "Laptops 2019-2026 compared", "Version 2026.1 released", "Up 2026% faster", "Model X2026 test"]) {
      expect(honestTitle(t, d2019)).toMatchObject({ title: t, changed: false });
    }
    expect(titleYears("Pixel 10 (2026) vs 2025's model")).toEqual([2026, 2025]);
    expect(titleYears("1080p at 2160 nits, model 3000")).toEqual([]);
  });

  it("protects a year that belongs to the product's own name (model year)", () => {
    expect(misleadingYears("Kia Telluride 2020 review", d2019, ["Kia Telluride 2020"])).toEqual([]);
    expect(honestTitle("Kia Telluride 2020 review", d2019, { protect: ["Kia Telluride 2020"] }).changed).toBe(false);
  });

  it("keeps the original when cleaning would leave too little title", () => {
    expect(honestTitle("2026", d2019).changed).toBe(false);
    expect(honestTitle("Best of 2026", d2019).changed).toBe(false);
  });

  it("is idempotent", () => {
    const once = clean("The Best VPNs for 2026: Our Picks");
    expect(honestTitle(once, d2019)).toMatchObject({ title: once, changed: false });
  });

  it("exempts Keyword-to-Blog posts and AI guides", () => {
    expect(titleYearsExempt("keyword-to-blog")).toBe(true);
    expect(titleYearsExempt("apify:techradar", "AI_GUIDE")).toBe(true);
    expect(titleYearsExempt("apify:techradar", "REVIEW")).toBe(false);
  });
});

describe("normalization applies honest titles", () => {
  const body = "A long enough body for the validator. ".repeat(6);
  const valid = (raw: Record<string, unknown>) => {
    const v = validateContentItem({ id: "x1", body, ...raw });
    if (!v.ok) throw new Error(v.issues.join("; "));
    return v.value;
  };
  const fetchedAt = new Date("2026-10-01Z");

  it("cleans the title and slug, keeps the original title and an unchanged dedupe key", () => {
    const v = valid({ title: "ExpressVPN Review 2026: Fast and Private", publishedAt: "2019-07-19", url: "https://www.example.com/expressvpn" });
    const n = normalizeContent(v, { source: "apify:example", fetchedAt });
    expect(n.canonicalTitle).toBe("ExpressVPN Review: Fast and Private");
    expect(n.slugBase).toBe("expressvpn-review-fast-and-private");
    expect(n.originalTitle).toBe("ExpressVPN Review 2026: Fast and Private");
    // The dedupe key is derived from the publisher title's product identity, so cleaning the
    // headline never changes it (re-ingestion of unchanged content can't create a duplicate).
    const sameTitleDated = normalizeContent(valid({ title: "ExpressVPN Review 2026: Fast and Private", url: "https://www.example.com/expressvpn", publishedAt: "2026-01-02" }), { source: "apify:example", fetchedAt });
    expect(sameTitleDated.canonicalTitle).toBe("ExpressVPN Review 2026: Fast and Private");
    expect(sameTitleDated.originalTitle).toBeUndefined();
    expect(n.dedupeKey.split("|").slice(0, 2)).toEqual(sameTitleDated.dedupeKey.split("|").slice(0, 2));
    expect(n.productIdentity).toBe(sameTitleDated.productIdentity);
  });

  it("leaves undated and Keyword-to-Blog titles untouched", () => {
    const undated = normalizeContent(valid({ title: "ExpressVPN Review 2026" }), { source: "apify:example", fetchedAt });
    expect(undated.canonicalTitle).toBe("ExpressVPN Review 2026");
    const ktb = normalizeContent(valid({ title: "Best VPN 2026: tested", contentKind: "AI_GUIDE", publishedAt: "2019-07-19" }), { source: "keyword-to-blog", fetchedAt });
    expect(ktb.canonicalTitle).toBe("Best VPN 2026: tested");
    expect(ktb.originalTitle).toBeUndefined();
  });

  it("merges the original title into sourceData without dropping keys", () => {
    expect(withOriginalTitle({ pros: ["a"] }, "T 2026")).toEqual({ pros: ["a"], originalTitle: "T 2026" });
    expect(withOriginalTitle(undefined, "T 2026")).toEqual({ originalTitle: "T 2026" });
    expect(withOriginalTitle({ pros: ["a"] }, undefined)).toEqual({ pros: ["a"] });
    expect(withOriginalTitle(undefined, undefined)).toBeUndefined();
  });
});
