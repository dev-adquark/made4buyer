import { afterEach, describe, expect, it } from "vitest";
import { istParts, nextSlotRun } from "@/lib/automation/daily-article";
import { bodyHash, itemType, keywordItemsPerSlot, keywordKey, nextRunAfter, normalizeKeyword, runOutcome, validateKeywordInput } from "@/lib/automation/keywords";
import { addDays, businessTimezone, isValidTimezone, zonedParts, zonedTimeToUtc } from "@/lib/util/timezone";
import { withEnv } from "../support/env";

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

describe("keyword normalization and dedupe key", () => {
  it("lowercases, trims, strips punctuation and collapses spaces", () => {
    expect(normalizeKeyword("  Best   Robot-Vacuum, for PET hair!!  ")).toBe("best robot vacuum for pet hair");
    expect(normalizeKeyword("Men’s running shoes")).toBe("mens running shoes");
    expect(normalizeKeyword("Wi‑Fi 7 routers?")).toBe("wi fi 7 routers");
    expect(normalizeKeyword("Café espresso")).toBe("café espresso");
  });

  it("derives one key per normalized keyword + kind (articles keep the article: prefix)", () => {
    expect(keywordKey("Best Robot Vacuum!", "GUIDE")).toBe("kw:best robot vacuum");
    expect(keywordKey("best   robot vacuum", "GUIDE")).toBe(keywordKey("BEST ROBOT VACUUM", "GUIDE"));
    expect(keywordKey("best robot vacuum", "ARTICLE")).toBe("article:kw:best robot vacuum");
    expect(keywordKey("best robot vacuum", "ARTICLE")).not.toBe(keywordKey("best robot vacuum", "GUIDE"));
    expect(itemType({ key: keywordKey("x y", "ARTICLE") })).toBe("ARTICLE");
    expect(itemType({ key: keywordKey("x y", "GUIDE") })).toBe("GUIDE");
    // Calendar keys keep working.
    expect(itemType({ key: "article:guide:laptops:ultrabooks" })).toBe("ARTICLE");
    expect(itemType({ key: "guide:laptops:ultrabooks" })).toBe("GUIDE");
  });

  it("hashes the body exactly, ignoring only case, punctuation and spacing", () => {
    expect(bodyHash("Hello,  World.\n\nSecond line")).toBe(bodyHash("hello world second line"));
    expect(bodyHash("Hello world")).not.toBe(bodyHash("Hello world!! And more"));
  });

  it("validates admin input (category from the taxonomy, priority 0–100, known frequency)", () => {
    const ok = validateKeywordInput({ keyword: " best  laptops for students ", kind: "guide", categorySlug: "laptops", priority: "80", frequency: "twice_weekly" });
    expect(ok).toMatchObject({ ok: true, value: { keyword: "best laptops for students", kind: "GUIDE", priority: 80, frequency: "TWICE_WEEKLY", enabled: true } });
    expect(validateKeywordInput({ keyword: "x", categorySlug: "laptops" }).ok).toBe(false);
    expect(validateKeywordInput({ keyword: "!!!", categorySlug: "laptops" }).ok).toBe(false);
    expect(validateKeywordInput({ keyword: "good laptops", categorySlug: "nope" }).ok).toBe(false);
    expect(validateKeywordInput({ keyword: "good laptops", categorySlug: "laptops", priority: "101" }).ok).toBe(false);
    expect(validateKeywordInput({ keyword: "good laptops", categorySlug: "laptops", frequency: "HOURLY" }).ok).toBe(false);
    expect(validateKeywordInput({ keyword: "good laptops", categorySlug: "laptops", kind: "REVIEW" }).ok).toBe(false);
    // Admin keywords default to weekly.
    expect(validateKeywordInput({ keyword: "good laptops", categorySlug: "laptops" })).toMatchObject({ ok: true, value: { frequency: "WEEKLY", priority: 50 } });
  });

  it("caps KEYWORD_ITEMS_PER_SLOT at 1–3 (default 1)", () => {
    restore = withEnv({ KEYWORD_ITEMS_PER_SLOT: undefined });
    expect(keywordItemsPerSlot()).toBe(1);
    restore();
    restore = withEnv({ KEYWORD_ITEMS_PER_SLOT: "9" });
    expect(keywordItemsPerSlot()).toBe(3);
    restore();
    restore = withEnv({ KEYWORD_ITEMS_PER_SLOT: "0" });
    expect(keywordItemsPerSlot()).toBe(1);
  });
});

describe("frequency → next run (business time zone days)", () => {
  const IST = "Asia/Kolkata";
  // 2026-10-06 08:05 IST.
  const run = new Date("2026-10-06T02:35:00Z");
  const midnightIst = (day: string) => zonedTimeToUtc(day, 0, 0, IST).toISOString();

  it("DAILY +1, WEEKLY +7, MONTHLY +30 days, due from 00:00 business time; ONCE has no next run", () => {
    expect(nextRunAfter("DAILY", run, {}, IST)?.toISOString()).toBe(midnightIst("2026-10-07"));
    expect(nextRunAfter("DAILY", run, {}, IST)?.toISOString()).toBe("2026-10-06T18:30:00.000Z");
    expect(nextRunAfter("WEEKLY", run, {}, IST)?.toISOString()).toBe(midnightIst("2026-10-13"));
    expect(nextRunAfter("MONTHLY", run, {}, IST)?.toISOString()).toBe(midnightIst("2026-11-05"));
    expect(nextRunAfter("ONCE", run, {}, IST)).toBeNull();
    expect(nextRunAfter("NONSENSE", run, {}, IST)).toBeNull();
  });

  it("a daily keyword stays due for the next morning slot even when the cron fires early", () => {
    const next = nextRunAfter("DAILY", run, {}, IST)!;
    // The next morning's run at 08:00:00 IST (a little earlier in the minute than today's).
    expect(next <= new Date("2026-10-07T02:30:00Z")).toBe(true);
  });

  it("TWICE_WEEKLY alternates +3 and +4 days", () => {
    const first = nextRunAfter("TWICE_WEEKLY", run, {}, IST)!;
    expect(first.toISOString()).toBe(midnightIst("2026-10-09"));
    // Next run happens on 2026-10-09 morning; the previous schedule was a 3-day gap → +4.
    const run2 = new Date("2026-10-09T02:35:00Z");
    const second = nextRunAfter("TWICE_WEEKLY", run2, { lastRunAt: run, nextRunAt: first }, IST)!;
    expect(second.toISOString()).toBe(midnightIst("2026-10-13"));
    const run3 = new Date("2026-10-13T02:35:00Z");
    const third = nextRunAfter("TWICE_WEEKLY", run3, { lastRunAt: run2, nextRunAt: second }, IST)!;
    expect(third.toISOString()).toBe(midnightIst("2026-10-16"));
  });

  it("computes the day in the business time zone, not UTC", () => {
    // 2026-10-06 20:00 UTC is already 2026-10-07 01:30 in India.
    const lateUtc = new Date("2026-10-06T20:00:00Z");
    expect(zonedParts(lateUtc, IST)).toMatchObject({ day: "2026-10-07", hour: 1, minute: 30 });
    expect(nextRunAfter("DAILY", lateUtc, {}, IST)?.toISOString()).toBe(midnightIst("2026-10-08"));
    // The same instant in New York is still 2026-10-06 (DST-aware via Intl).
    expect(zonedParts(lateUtc, "America/New_York")).toMatchObject({ day: "2026-10-06", hour: 16 });
    expect(nextRunAfter("DAILY", lateUtc, {}, "America/New_York")?.toISOString()).toBe("2026-10-07T04:00:00.000Z");
    // Across the US DST change (2026-11-01): midnight on 11-02 is UTC-5.
    expect(zonedTimeToUtc(addDays("2026-10-31", 2), 0, 0, "America/New_York").toISOString()).toBe("2026-11-02T05:00:00.000Z");
  });

  it("BUSINESS_TIMEZONE drives the slots (default Asia/Kolkata); invalid values fall back", () => {
    restore = withEnv({ BUSINESS_TIMEZONE: undefined });
    expect(businessTimezone()).toBe("Asia/Kolkata");
    expect(istParts(new Date("2026-10-06T02:30:00Z"))).toMatchObject({ day: "2026-10-06", hour: 8, minute: 0 });
    restore();
    restore = withEnv({ BUSINESS_TIMEZONE: "Europe/London" });
    // 08:00 London (BST, UTC+1) on 2026-10-06 = 07:00 UTC.
    expect(nextSlotRun("MORNING", new Date("2026-10-06T05:00:00Z")).toISOString()).toBe("2026-10-06T07:00:00.000Z");
    restore();
    restore = withEnv({ BUSINESS_TIMEZONE: "Mars/Olympus" });
    expect(businessTimezone()).toBe("Asia/Kolkata");
    expect(isValidTimezone("Asia/Kolkata")).toBe(true);
    expect(isValidTimezone("+05:30")).toBe(false);
    expect(isValidTimezone("IST; drop")).toBe(false);
  });
});

describe("run outcome", () => {
  const now = new Date("2026-10-06T02:35:00Z");
  const base = { lastRunAt: null, nextRunAt: now };

  it("ONCE: published → PUBLISHED with no next run; duplicate → REJECTED", () => {
    expect(runOutcome({ ...base, frequency: "ONCE", attempts: 1 }, "PUBLISHED", now)).toMatchObject({ status: "PUBLISHED", nextRunAt: null, lastResult: "PUBLISHED", lastRunAt: now });
    expect(runOutcome({ ...base, frequency: "ONCE", attempts: 1 }, "DUPLICATE", now, { reason: "same title" })).toMatchObject({ status: "REJECTED", nextRunAt: null, lastResult: "DUPLICATE", failureReason: "same title" });
  });

  it("recurring: published or duplicate → back in the queue for the next period, attempts reset", () => {
    const pub = runOutcome({ ...base, frequency: "WEEKLY", attempts: 1 }, "PUBLISHED", now);
    expect(pub).toMatchObject({ status: "QUEUED", attempts: 0, lastResult: "PUBLISHED" });
    expect((pub.nextRunAt as Date) > now).toBe(true);
    expect(runOutcome({ ...base, frequency: "DAILY", attempts: 1 }, "DUPLICATE", now)).toMatchObject({ status: "QUEUED", attempts: 0, lastResult: "DUPLICATE" });
  });

  it("FAILED keeps the item due (slot backoff), exhausts a one-off after 3 tries, defers a recurring one", () => {
    const retry = runOutcome({ ...base, frequency: "ONCE", attempts: 1 }, "FAILED", now, { reason: "provider down" });
    expect(retry).toMatchObject({ status: "QUEUED", lastResult: "FAILED" });
    expect(retry.nextRunAt).toBeUndefined();
    expect(runOutcome({ ...base, frequency: "ONCE", attempts: 3 }, "FAILED", now)).toMatchObject({ status: "EXHAUSTED" });
    const deferred = runOutcome({ ...base, frequency: "WEEKLY", attempts: 3 }, "FAILED", now);
    expect(deferred).toMatchObject({ status: "QUEUED", attempts: 0 });
    expect((deferred.nextRunAt as Date) > now).toBe(true);
  });
});
