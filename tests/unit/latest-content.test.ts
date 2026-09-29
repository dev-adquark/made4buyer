import { describe, expect, it } from "vitest";
import { classifyData } from "@/lib/reports/day30";
import { publicationDateIssues, validateContentItem } from "@/lib/pipeline/validate";

const base = { id: "x-1", title: "A review title that is long enough", body: "Body text. ".repeat(20) };

describe("publication dates", () => {
  const now = Date.parse("2026-09-29T00:00:00Z");
  it("accepts past dates and small clock skew", () => {
    expect(publicationDateIssues(new Date("2026-09-01T00:00:00Z"), "2026-09-01", now)).toEqual([]);
    expect(publicationDateIssues(new Date("2026-09-29T20:00:00Z"), "x", now)).toEqual([]);
  });
  it("isolates future, implausible and unparseable dates instead of guessing", () => {
    expect(publicationDateIssues(new Date("2026-10-05T00:00:00Z"), "x", now)[0]).toMatch(/in the future/);
    expect(publicationDateIssues(new Date("1970-01-02T00:00:00Z"), "x", now)[0]).toMatch(/implausibly old/);
    expect(publicationDateIssues(undefined, "not a date", now)[0]).toMatch(/could not be parsed/);
    expect(publicationDateIssues(undefined, undefined, now)).toEqual([]);
  });
  it("rejects a content item whose date is in the future", () => {
    const future = new Date(Date.now() + 5 * 86_400_000).toISOString();
    const res = validateContentItem({ ...base, publishedAt: future });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.issues.join(" ")).toMatch(/publishedAt: .* is in the future/);
    expect(validateContentItem({ ...base, publishedAt: "2026-09-01T09:00:00Z" }).ok).toBe(true);
  });
});

describe("Day-30 data classification", () => {
  it("labels production only for the production deployment with real sources", () => {
    expect(classifyData(["reviews.partner.example"], "production")).toMatchObject({ label: "PRODUCTION", reasons: [] });
  });
  it("labels sample/test data and says why", () => {
    const r = classifyData(["sample-fixture", "reviews.partner.example"], "production");
    expect(r.label).toBe("SAMPLE_OR_TEST");
    expect(r.reasons.join(" ")).toMatch(/sample-fixture/);
    expect(classifyData(["reviews.partner.example"], "preview").label).toBe("SAMPLE_OR_TEST");
    expect(classifyData([], "production").reasons).toContain("no ingestion runs in this window");
  });
});
