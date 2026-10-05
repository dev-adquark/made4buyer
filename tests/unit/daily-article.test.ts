import { describe, expect, it } from "vitest";
import {
  istParts,
  nextSlotRun,
  similarity,
  SIMILARITY_THRESHOLD,
} from "@/lib/automation/daily-article";

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
