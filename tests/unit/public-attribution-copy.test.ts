import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { composeRenderModel, type RenderInputs } from "@/lib/pipeline/render-model";

/**
 * Public pages never name where content was sourced from, and never reintroduce the labels that
 * pointed at a third-party publisher or data vendor. Admin pages (app/admin) are internal and exempt.
 */
const BANNED = [
  "Named publisher",
  "named publishers",
  "publishing partners",
  "Via Feedico",
  "Via CouponVault",
  "Feedico (affiliate network)",
  "Made4Buyers rewrite",
  "as reported by the original publisher",
  "As reported in the original review",
  "Not provided by the original publisher",
  "edited by Made4Buyers",
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    if (statSync(p).isDirectory()) return p.includes(`${path.sep}admin`) ? [] : sourceFiles(p);
    return /\.(tsx?|mdx?)$/.test(f) ? [p] : [];
  });
}

describe("public copy: no third-party source labels", () => {
  it("app/ (except admin) and components/ contain none of the retired labels", () => {
    const hits: string[] = [];
    for (const file of [...sourceFiles(path.join(process.cwd(), "app")), ...sourceFiles(path.join(process.cwd(), "components"))]) {
      const text = readFileSync(file, "utf8");
      for (const b of BANNED) if (text.includes(b)) hits.push(`${path.relative(process.cwd(), file)}: "${b}"`);
    }
    expect(hits).toEqual([]);
  });
});

describe("render model: a rewritten review never shows the original publisher's score", () => {
  const review: RenderInputs["review"] = {
    id: "r1", slug: "pixel-11-review", canonicalTitle: "Google Pixel 11 Review", summary: "A phone.", body: "Body text.", productName: "Pixel 11", brand: "Google", brandSlug: "google",
    categorySlug: "phones", subcategorySlug: null, source: "apify:example", kind: "REVIEW", sourceUrl: "https://publisher.example/pixel-11", author: "A Writer",
    sourcePublishedAt: new Date("2026-09-01T00:00:00Z"), publishedAt: new Date("2026-09-02T00:00:00Z"), updatedAt: new Date("2026-09-02T00:00:00Z"),
  };
  const entities = { brand: "Google", productName: "Pixel 11", modelNumber: null, deviceType: null, platform: null, useCase: null, rating: 8.5, ratingScale: 10, source: "Publisher" };

  it("drops the rating once the review is Made4Buyers' own write-up, keeps it for excerpt content", () => {
    const base = { review, entities, assignments: [], image: null, offers: [] };
    expect(composeRenderModel({ ...base, textRights: "EXCERPT", contentRewritten: true }).rating).toBeNull();
    expect(composeRenderModel({ ...base, textRights: "EXCERPT", contentRewritten: false }).rating).toEqual({ value: 8.5, scale: 10 });
  });
});
