import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import vercelConfig from "@/vercel.json";
import { describeCron, formatInZone, GITHUB_SCHEDULES, jobFromCronPath, nextRun, parseCron, previousRun, scheduledEntries } from "@/lib/ops/cron-schedule";

const NOW = new Date("2026-10-07T12:00:00Z");
const iso = (d: Date | null) => d?.toISOString();

describe("cron parsing", () => {
  it("parses numbers, lists, ranges and steps", () => {
    const c = parseCron("*/15 1-3,22 * * 1-5");
    expect(c.minute.values).toEqual([0, 15, 30, 45]);
    expect(c.hour.values).toEqual([1, 2, 3, 22]);
    expect(c.dow.values).toEqual([1, 2, 3, 4, 5]);
    expect(parseCron("0 0 * * 7").dow.values).toEqual([0]);
    expect(parseCron("5-20/5 * * * *").minute.values).toEqual([5, 10, 15, 20]);
  });

  it("rejects malformed expressions", () => {
    expect(() => parseCron("0 5 * *")).toThrow();
    expect(() => parseCron("60 5 * * *")).toThrow();
    expect(() => parseCron("a 5 * * *")).toThrow();
    expect(() => parseCron("0 5-2 * * *")).toThrow();
  });
});

describe("next / previous run (UTC)", () => {
  // Jobs that call no paid/budget-limited API (plain HTTP GETs we fully control the volume of) may run
  // on their own cadence: there is no cost to pace against, unlike every Apify-calling job below.
  const COST_FREE_EXEMPT: Record<string, [string, string]> = { "/api/cron/commerce-direct-crawl": ["*", "*"], "/api/cron/deal-price-recheck": ["*", "*"] };

  it("every vercel.json schedule is cost-free-job cadence, weekly (Monday-only) or biweekly (the 1st and 15th), never more often than that", () => {
    // Coupons and other Apify-calling jobs aside, data this site tracks (reviews, prices, images,
    // links) does not change fast enough to need daily runs; every Apify-backed schedule here is
    // capped at a 2-week gap between runs.
    const crons = (vercelConfig as { crons: Array<{ path: string; schedule: string }> }).crons;
    expect(crons.length).toBeGreaterThan(0);
    for (const { path, schedule } of crons) {
      const [, , dom, , dow] = schedule.split(" ");
      const key = path.split("?")[0];
      if (key in COST_FREE_EXEMPT) {
        expect([dom, dow], `${path}: ${schedule}`).toEqual(COST_FREE_EXEMPT[key]);
        continue;
      }
      expect([dom, dow], `${path}: ${schedule}`).toEqual(dow === "1" ? ["*", "1"] : ["1,15", "*"]);
    }
  });

  it("computes next and previous for every vercel.json schedule, and confirms no gap exceeds 16 days", () => {
    const crons = (vercelConfig as { crons: Array<{ path: string; schedule: string }> }).crons;
    for (const { schedule } of crons) {
      const next = nextRun(schedule, NOW)!;
      const prev = previousRun(schedule, NOW)!;
      expect(next.getTime(), schedule).toBeGreaterThan(NOW.getTime());
      expect(prev.getTime(), schedule).toBeLessThanOrEqual(NOW.getTime());
      const nextAfterPrev = nextRun(schedule, prev)!;
      expect(nextAfterPrev.getTime() - prev.getTime(), schedule).toBeLessThanOrEqual(16 * 86_400_000);
    }
  });

  it("runs the Feedico coupon sync on the 1st and 15th of the month, 11:30 IST (06:00 UTC)", () => {
    const crons = (vercelConfig as { crons: Array<{ path: string; schedule: string }> }).crons;
    const feedico = crons.filter((c) => c.path === "/api/cron/feedico-coupons");
    expect(feedico.map((c) => c.schedule)).toEqual(["0 6 1,15 * *"]);
    expect(iso(nextRun("0 6 1,15 * *", NOW))).toBe("2026-10-15T06:00:00.000Z");
    expect(formatInZone(nextRun("0 6 1,15 * *", NOW)!, "Asia/Kolkata")).toMatch(/11:30/);
    expect(new Date("2026-10-15T06:00:00Z").toLocaleString("en-US", { timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit" })).toBe("11:30 AM");
    expect(iso(previousRun("0 6 1,15 * *", NOW))).toBe("2026-10-01T06:00:00.000Z");
  });

  it("matches hand-checked values for the current schedules", () => {
    expect(iso(nextRun("0 5 * * 1", NOW))).toBe("2026-10-12T05:00:00.000Z"); // 2026-10-07 is a Wednesday
    expect(iso(previousRun("0 5 * * 1", NOW))).toBe("2026-10-05T05:00:00.000Z");
    expect(iso(nextRun("30 2 * * 1", NOW))).toBe("2026-10-12T02:30:00.000Z");
    expect(iso(nextRun("20 9 1,15 * *", NOW))).toBe("2026-10-15T09:20:00.000Z");
    expect(iso(previousRun("20 9 1,15 * *", NOW))).toBe("2026-10-01T09:20:00.000Z");
  });

  it("handles the GitHub Actions schedules", () => {
    expect(iso(nextRun("10 */6 * * *", NOW))).toBe("2026-10-07T12:10:00.000Z");
    expect(iso(previousRun("10 */6 * * *", NOW))).toBe("2026-10-07T06:10:00.000Z");
    expect(iso(nextRun("40 * * * *", NOW))).toBe("2026-10-07T12:40:00.000Z");
    expect(iso(previousRun("40 * * * *", NOW))).toBe("2026-10-07T11:40:00.000Z");
    expect(iso(nextRun("10 */6 * * *", new Date("2026-10-07T18:10:00Z")))).toBe("2026-10-08T00:10:00.000Z");
  });

  it("next is strictly after, previous is at or before", () => {
    const at = new Date("2026-10-07T05:00:00Z");
    expect(iso(nextRun("0 5 * * *", at))).toBe("2026-10-08T05:00:00.000Z");
    expect(iso(previousRun("0 5 * * *", at))).toBe("2026-10-07T05:00:00.000Z");
    expect(iso(nextRun("0 5 * * *", new Date("2026-10-07T04:59:30Z")))).toBe("2026-10-07T05:00:00.000Z");
  });

  it("crosses month and year boundaries and honours day fields", () => {
    expect(iso(nextRun("0 0 1 * *", new Date("2026-12-15T00:00:00Z")))).toBe("2027-01-01T00:00:00.000Z");
    expect(iso(previousRun("0 0 1 * *", new Date("2026-12-15T00:00:00Z")))).toBe("2026-12-01T00:00:00.000Z");
    // 2026-10-07 is a Wednesday; next Monday is 2026-10-12.
    expect(iso(nextRun("0 9 * * 1", NOW))).toBe("2026-10-12T09:00:00.000Z");
    expect(iso(previousRun("0 9 * * 1", NOW))).toBe("2026-10-05T09:00:00.000Z");
    // Both day fields restricted: either matches (standard cron).
    expect(iso(nextRun("0 0 13 * 5", NOW))).toBe("2026-10-09T00:00:00.000Z");
    expect(iso(nextRun("0 0 29 2 *", NOW))).toBe("2028-02-29T00:00:00.000Z");
  });
});

describe("descriptions", () => {
  it("describes the schedules in plain English", () => {
    expect(describeCron("0 5 * * *")).toBe("Every day at 05:00 UTC");
    expect(describeCron("40 * * * *")).toBe("Every hour at minute 40");
    expect(describeCron("10 */6 * * *")).toBe("Every 6 hours at minute 10 (00:10, 06:10, 12:10, 18:10 UTC)");
    expect(describeCron("0 9 * * 1")).toBe("At 09:00 UTC on Monday");
  });

  it("formats a time in the business timezone", () => {
    expect(formatInZone(new Date("2026-10-07T02:30:00Z"), "Asia/Kolkata")).toBe("2026-10-07 08:00");
    expect(formatInZone(new Date("2026-10-07T13:30:00Z"), "Asia/Kolkata")).toBe("2026-10-07 19:00");
  });
});

describe("scheduled jobs", () => {
  it("lists every vercel.json cron with its job name, then the GitHub schedules", () => {
    const entries = scheduledEntries();
    const vercel = entries.filter((e) => e.origin === "vercel");
    expect(vercel).toHaveLength((vercelConfig as { crons: unknown[] }).crons.length);
    expect(vercel.filter((e) => e.job === "daily-article").map((e) => e.query)).toEqual([undefined]);
    expect(entries.filter((e) => e.origin === "github-actions")).toEqual([]);
    expect(jobFromCronPath("/api/cron/commerce-collect")).toEqual({ job: "commerce-collect", query: undefined });
    expect(jobFromCronPath("/elsewhere")).toBeNull();
  });

  it("the GitHub Actions workflow has no schedule trigger (vercel.json's own cadence covers it)", () => {
    expect(GITHUB_SCHEDULES).toEqual([]);
    const yml = fs.readFileSync(path.join(process.cwd(), ".github/workflows/scheduled-jobs.yml"), "utf8");
    expect(yml).not.toMatch(/^\s*schedule:/m);
    expect(yml).toMatch(/workflow_dispatch:/);
  });
});
