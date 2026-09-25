import { describe, expect, it } from "vitest";
import { evaluateMetric, ratio } from "@/lib/analytics/metrics";
import { renderDay30Html } from "@/lib/reports/day30-html";
import type { Day30Report } from "@/lib/reports/day30";
import { redact } from "@/lib/log";
import { withEnv } from "../support/env";

describe("metric calculations", () => {
  it("computes ratios and never divides by zero", () => {
    expect(ratio(1, 3)).toBe(0.3333);
    expect(ratio(0, 0)).toBeNull();
  });
  it("evaluates targets in both directions and flags insufficient data", () => {
    const m = { key: "k", label: "k", formula: "f", target: 0.9, comparator: ">=" as const };
    expect(evaluateMetric({ ...m, numerator: 95, denominator: 100 }, 10).status).toBe("MEETS_TARGET");
    expect(evaluateMetric({ ...m, numerator: 50, denominator: 100 }, 10).status).toBe("BELOW_TARGET");
    expect(evaluateMetric({ ...m, numerator: 3, denominator: 3 }, 10)).toMatchObject({ value: 1, status: "INSUFFICIENT_DATA" });
    expect(evaluateMetric({ ...m, numerator: 0, denominator: 0 }, 10)).toMatchObject({ value: null, status: "INSUFFICIENT_DATA" });
    expect(evaluateMetric({ ...m, comparator: "<=", target: 0.05, numerator: 2, denominator: 100 }, 10).status).toBe("MEETS_TARGET");
  });
});

describe("Day-30 HTML", () => {
  it("escapes every value", () => {
    const html = renderDay30Html({
      generatedAt: "2026-09-25T00:00:00Z",
      period: { start: "a", end: "b" },
      environment: { version: "1", commit: "<script>", environment: "test", integrations: { gsc: "BLOCKED_BY_ENVIRONMENT" } },
      ingestion: { totalFetched: 1 }, dealCoverage: {}, linkHealth: {}, categorization: {}, images: {}, seoIndexing: { status: "NOT_AVAILABLE_IN_ENVIRONMENT" },
      ctr: { minimumImpressions: 100, categories: [], note: "INSUFFICIENT_DATA" },
      successMetrics: [], topFailureReasons: [{ errorCode: "<img onerror=x>", stage: "S", count: 1, percentage: 1, latestOccurrence: null }],
      fixesShipped: { commit: null, source: "git", changes: [] },
    } as unknown as Day30Report);
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img onerror");
    expect(html).toContain("&lt;img onerror=x&gt;");
    expect(html).toContain("NOT_AVAILABLE_IN_ENVIRONMENT");
  });
});

describe("log redaction", () => {
  it("redacts secrets by key and by value", () => {
    const restore = withEnv({ SOVRN_API_KEY: "super-secret-sovrn-key" });
    const out = redact({ apiKey: "x", nested: { message: "failed with super-secret-sovrn-key", url: "postgres://u:pw@host/db" } }) as Record<string, unknown>;
    restore();
    expect(out.apiKey).toBe("[REDACTED]");
    expect(JSON.stringify(out)).not.toContain("super-secret-sovrn-key");
    expect(JSON.stringify(out)).not.toContain("u:pw");
  });
});
