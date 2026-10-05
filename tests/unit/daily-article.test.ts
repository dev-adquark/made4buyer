import { describe, expect, it } from "vitest";
import {
  contentQualityIssues,
  istParts,
  nextSlotRun,
  similarity,
  SIMILARITY_THRESHOLD,
} from "@/lib/automation/daily-article";

const words = (n: number) =>
  Array.from({ length: n }, (_, i) => `word${i % 50}`).join(" ");
const good = {
  title: "How to choose robot vacuums: a practical buying guide",
  summary:
    "What actually matters when choosing a robot vacuum, explained without hype for busy homes.",
  body: `## Size\n${words(200)}\n## Use\n${words(200)}\n## Upkeep\n${words(200)}`,
  generation: { qualityStatus: "pass" },
};

describe("schedule (Asia/Kolkata)", () => {
  it("maps UTC to the IST day and hour", () => {
    expect(istParts(new Date("2026-10-06T02:30:00Z"))).toMatchObject({
      day: "2026-10-06",
      hour: 8,
      minute: 0,
    });
    expect(istParts(new Date("2026-10-06T19:00:00Z"))).toMatchObject({
      day: "2026-10-07",
      hour: 0,
    });
  });
  it("computes the next morning (08:00) and evening (19:00) runs", () => {
    const now = new Date("2026-10-06T05:00:00Z"); // 10:30 IST
    expect(nextSlotRun("MORNING", now).toISOString()).toBe(
      "2026-10-07T02:30:00.000Z",
    );
    expect(nextSlotRun("EVENING", now).toISOString()).toBe(
      "2026-10-06T13:30:00.000Z",
    );
  });
});

describe("duplicate similarity", () => {
  it("treats rewordings of one topic as duplicates and different topics as new", () => {
    expect(
      similarity("Robot vacuums", "How to choose a robot vacuum"),
    ).toBeGreaterThanOrEqual(SIMILARITY_THRESHOLD);
    expect(
      similarity(
        "Office chairs",
        "Best office chair for back pain buying guide",
      ),
    ).toBeGreaterThanOrEqual(SIMILARITY_THRESHOLD);
    expect(similarity("Robot vacuums", "Air purifiers")).toBeLessThan(
      SIMILARITY_THRESHOLD,
    );
    expect(similarity("Carry-on luggage", "Checked luggage sets")).toBeLessThan(
      SIMILARITY_THRESHOLD,
    );
  });
});

describe("content QA gate", () => {
  it("passes a substantive, structured, claim-free article", () => {
    expect(contentQualityIssues(good, "how to choose robot vacuums")).toEqual(
      [],
    );
  });
  it.each([
    [
      "hands-on claims",
      { body: `${good.body}\nWe tested each one for a month.` },
      /hands-on/,
    ],
    [
      "invented prices",
      { body: `${good.body}\nExpect to pay around $299.` },
      /price/,
    ],
    [
      "unsupported statistics",
      { body: `${good.body}\nA recent survey found 73% of owners regret it.` },
      /statistic/,
    ],
    [
      "thin content",
      { body: "## A\nshort\n## B\nshort\n## C\nshort" },
      /too short/,
    ],
    ["missing structure", { body: words(700) }, /headings/],
    [
      "generator quality failure",
      { generation: { qualityStatus: "fail" } },
      /quality check/,
    ],
  ])("rejects %s", (_, patch, re) => {
    expect(
      contentQualityIssues(
        { ...good, ...patch },
        "how to choose robot vacuums",
      ).join("; "),
    ).toMatch(re);
  });
});
