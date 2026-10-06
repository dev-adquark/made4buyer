import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { commerceEngineOn, commerceMonthUsage, ENGINE_SWITCH, retryFailed, setCommerceEngine } from "@/lib/commerce/admin-actions";
import { resetDb } from "../support/db";
import { withEnv } from "../support/env";

const admin = { actor: "admin@test" };

beforeEach(() => resetDb());

const brand = (slug: string, data: Record<string, unknown> = {}) =>
  db.commerceBrand.create({ data: { name: slug, slug, officialDomain: `${slug}.example.test`, ...data } });
const run = (status: string, data: Record<string, unknown> = {}) => db.commerceRun.create({ data: { purpose: "PRODUCT", actorId: "apify/web-scraper", trigger: "test", status, ...data } });

describe("commerce engine pause / resume", () => {
  it("toggles the commerce_engine switch and audits each change", async () => {
    expect(await commerceEngineOn()).toBe(true);

    expect(await setCommerceEngine(false, admin)).toEqual({ before: true, after: false });
    expect(await commerceEngineOn()).toBe(false);
    expect((await db.automationSetting.findUniqueOrThrow({ where: { key: ENGINE_SWITCH } })).value).toBe("off");

    expect(await setCommerceEngine(true, admin)).toEqual({ before: false, after: true });
    expect(await commerceEngineOn()).toBe(true);

    const logs = await db.auditLog.findMany({ where: { action: `automation.switch.${ENGINE_SWITCH}` }, orderBy: { createdAt: "asc" } });
    expect(logs).toHaveLength(2);
    expect(logs.map((l) => l.after)).toEqual([{ on: false }, { on: true }]);
    expect(logs.every((l) => l.actor === "admin@test")).toBe(true);
  });
});

describe("commerce retry-failed", () => {
  it("re-queues only failed brands and marks only FAILED runs RETRY_QUEUED", async () => {
    const later = new Date(Date.now() + 7 * 86_400_000);
    const failing = await brand("failing", { consecutiveFailures: 3, nextCrawlAt: later, crawlStatus: "OK" });
    const crashed = await brand("crashed", { crawlStatus: "FAILED", nextCrawlAt: later });
    const healthy = await brand("healthy", { crawlStatus: "OK", nextCrawlAt: later });
    const failedRun = await run("FAILED", { brandId: failing.id });
    const okRun = await run("SUCCEEDED", { brandId: healthy.id });
    const runningRun = await run("RUNNING");

    const now = new Date();
    expect(await retryFailed(admin, now)).toEqual({ brands: 2, runs: 1 });

    for (const id of [failing.id, crashed.id]) {
      const b = await db.commerceBrand.findUniqueOrThrow({ where: { id } });
      expect(b.nextCrawlAt?.getTime()).toBe(now.getTime());
      expect(b.consecutiveFailures).toBe(0);
      expect(b.crawlStatus).toBe("RETRY_QUEUED");
    }
    const h = await db.commerceBrand.findUniqueOrThrow({ where: { id: healthy.id } });
    expect(h.nextCrawlAt?.getTime()).toBe(later.getTime());
    expect(h.crawlStatus).toBe("OK");

    expect((await db.commerceRun.findUniqueOrThrow({ where: { id: failedRun.id } })).status).toBe("RETRY_QUEUED");
    expect((await db.commerceRun.findUniqueOrThrow({ where: { id: okRun.id } })).status).toBe("SUCCEEDED");
    expect((await db.commerceRun.findUniqueOrThrow({ where: { id: runningRun.id } })).status).toBe("RUNNING");

    const log = await db.auditLog.findFirstOrThrow({ where: { action: "commerce.retry_failed" } });
    expect(log.metadata).toMatchObject({ brands: 2, runs: 1, runIds: [failedRun.id] });

    // Nothing left to retry: a second call touches nothing.
    expect(await retryFailed(admin)).toEqual({ brands: 0, runs: 0 });
  });
});

describe("commerce monthly usage", () => {
  it("sums this month's run usage against the budget and warns at 80%", async () => {
    const restore = withEnv({ COMMERCE_MONTHLY_BUDGET_USD: "5" });
    try {
      const now = new Date();
      const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15));
      await run("SUCCEEDED", { usageUsd: 1.5 });
      await run("SUCCEEDED", { usageUsd: 2.5 });
      await run("SUCCEEDED", { usageUsd: 9, startedAt: lastMonth });
      const u = await commerceMonthUsage(now);
      expect(u.used).toBeCloseTo(4);
      expect(u.budget).toBe(5);
      expect(u.warn).toBe(true);
    } finally {
      restore();
    }
  });
});
