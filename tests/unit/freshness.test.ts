import { describe, expect, it } from "vitest";
import { evaluateFreshness } from "@/lib/pipeline/freshness";

const now = new Date("2026-10-08T12:00:00Z");
const ago = (days: number, extraHours = 0) => new Date(now.getTime() - days * 86_400_000 - extraHours * 3_600_000).toISOString();

describe("7-day freshness rule for external content", () => {
  it.each([
    [1, "FRESH"],
    [6, "FRESH"],
    [7, "FRESH"],
    [8, "STALE"],
    [30, "STALE"],
    [365, "STALE"],
  ])("published %i days ago → %s", (days, status) => {
    expect(evaluateFreshness({ publishedAt: ago(days) }, now).status).toBe(status);
  });

  it("7 days and 23 hours is still day 7 (whole days, no off-by-one)", () => {
    expect(evaluateFreshness({ publishedAt: ago(7, 23) }, now)).toMatchObject({ status: "FRESH", ageDays: 7 });
  });

  it("uses the newer of published/updated: an old article updated 2 days ago is fresh", () => {
    expect(evaluateFreshness({ publishedAt: ago(400), updatedAt: ago(2) }, now)).toMatchObject({ status: "FRESH", basis: "updated", ageDays: 2 });
  });

  it("missing date → UNKNOWN (never assumed recent)", () => {
    expect(evaluateFreshness({}, now)).toMatchObject({ status: "UNKNOWN", ageDays: null });
  });

  it("unparseable or far-future date → INVALID_DATE", () => {
    expect(evaluateFreshness({ publishedAt: "not a date" }, now).status).toBe("INVALID_DATE");
    expect(evaluateFreshness({ publishedAt: "2027-01-01T00:00:00Z" }, now).status).toBe("INVALID_DATE");
  });

  it("time zones: a date-only or offset timestamp is compared in UTC", () => {
    expect(evaluateFreshness({ publishedAt: "2026-10-01T23:30:00-05:00" }, now)).toMatchObject({ status: "FRESH", ageDays: 6 });
  });
});
