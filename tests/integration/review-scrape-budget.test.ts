import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { JOBS } from "@/lib/jobs/registry";
import { db } from "@/lib/db";
import { runCollectScrapes, runScrapeSources, startSourceRun } from "@/lib/pipeline/apify";
import { reviewScrapeBudget } from "@/lib/pipeline/review-budget";
import { resetDb } from "../support/db";
import { withEnv } from "../support/env";

/**
 * Review-scraping spending cap (lib/pipeline/review-budget.ts). Local Apify + robots.txt stub only:
 * no real Apify call, no token. Every run start (POST …/runs) is counted.
 */
type Stub = { base: string; starts: number; usage: number | null; status: string; startDelayMs: number; close: () => Promise<void> };
async function startStub(): Promise<Stub> {
  const stub: Stub = { base: "", starts: 0, usage: 0.8, status: "RUNNING", startDelayMs: 0, close: async () => undefined };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://stub");
    const send = (code: number, body: unknown, type = "application/json") => {
      res.writeHead(code, { "content-type": type });
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    };
    if (url.pathname === "/robots.txt") return send(200, "User-agent: *\nAllow: /\n", "text/plain");
    if (req.headers.authorization !== "Bearer test-apify-token") return send(401, {});
    if (req.method === "POST" && /\/runs$/.test(url.pathname)) {
      req.resume();
      stub.starts++;
      const id = `run-${stub.starts}`;
      setTimeout(() => send(201, { data: { id, status: "READY", defaultDatasetId: `ds-${id}` } }), stub.startDelayMs);
      return;
    }
    const run = url.pathname.match(/\/actor-runs\/([^/]+)$/);
    if (run) return send(200, { data: { id: run[1], status: stub.status, defaultDatasetId: `ds-${run[1]}`, usageTotalUsd: stub.usage } });
    send(404, {});
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  stub.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  stub.close = () => new Promise((r) => server.close(() => r()));
  return stub;
}

let stub: Stub;
let restore: () => void;
beforeAll(async () => {
  stub = await startStub();
  restore = withEnv({ APIFY_API_TOKEN: "test-apify-token", APIFY_API_BASE_URL: `${stub.base}/apify/v2`, UNSAFE_ALLOW_LOOPBACK_FOR_TESTS: "true", REVIEW_SCRAPE_MONTHLY_BUDGET_USD: "2", REVIEW_SCRAPE_RUN_ESTIMATE_USD: "0.5" });
});
afterAll(async () => {
  restore();
  await stub.close();
});
beforeEach(async () => {
  await resetDb();
  stub.starts = 0;
  stub.usage = 0.8;
  stub.status = "RUNNING";
  stub.startDelayMs = 0;
});

const addSource = (slug: string) =>
  db.reviewSource.create({ data: { slug, name: `Source ${slug}`, homepageUrl: `${stub.base}/`, allowedDomains: ["example.test"], startUrls: [`${stub.base}/${slug}`], reviewUrlPatterns: ["https://reviews.example.test/**"], enabled: true } });

describe("review-scraping spending cap", () => {
  it("is read from REVIEW_SCRAPE_MONTHLY_BUDGET_USD and counts runs Apify has not reported at the expected cost", async () => {
    const s = await addSource("a");
    expect(await reviewScrapeBudget()).toMatchObject({ budgetUsd: 2, spentUsd: 0, allowed: true });
    await db.apifyRun.create({ data: { sourceId: s.id, apifyRunId: "old-1", status: "SUCCEEDED", trigger: "t" } });
    expect(await reviewScrapeBudget()).toMatchObject({ unknownRuns: 1, perRunUsd: 0.5, spentUsd: 0.5 });
  });

  it("records the usage Apify reports and stops starting runs once the next one would pass the cap", async () => {
    for (const slug of ["a", "b", "c", "d"]) await addSource(slug);
    // $0.50 expected per run, $2 cap: 4 starts would reach $2.00; a fifth never starts.
    expect(await runScrapeSources("cron")).toMatchObject({ started: 4 });
    expect(stub.starts).toBe(4);
    // Apify reports $0.80 per run: recorded spend $3.20 is over the cap.
    await runCollectScrapes("cron");
    const b = await reviewScrapeBudget();
    expect(b).toMatchObject({ recordedUsd: expect.closeTo(3.2, 5), unknownRuns: 0, allowed: false });
    await db.reviewSource.updateMany({ data: { lastRunAt: null } });
    await db.apifyRun.updateMany({ data: { status: "COLLECTED" } }); // no active run blocks the next start
    const again = await runScrapeSources("cron");
    expect(again.started).toBe(0);
    expect(again.results?.every((r) => r.status === "BUDGET_EXHAUSTED")).toBe(true);
    expect(again.results?.[0].reason).toMatch(/REVIEW_SCRAPE_MONTHLY_BUDGET_USD/);
    expect(stub.starts).toBe(4); // no paid call
  });

  it("applies to every trigger: the scheduler job, a second scheduler and Admin 'Run now'", async () => {
    const s = await addSource("a");
    const budget = withEnv({ REVIEW_SCRAPE_MONTHLY_BUDGET_USD: "0.4" }); // below one expected run
    expect(await JOBS["scrape-sources"].run("cron")).toMatchObject({ started: 0 });
    expect(await runScrapeSources("github")).toMatchObject({ started: 0 });
    expect(await startSourceRun(s, "admin:owner@example.com")).toMatchObject({ status: "BUDGET_EXHAUSTED" });
    budget();
    expect(stub.starts).toBe(0);
  });

  it("concurrent triggers cannot both pass the check: room for one run starts exactly one", async () => {
    await addSource("a");
    await addSource("b");
    const budget = withEnv({ REVIEW_SCRAPE_MONTHLY_BUDGET_USD: "0.5" }); // exactly one expected run
    stub.startDelayMs = 150; // the first start is still in flight when the others check
    const results = await Promise.all([runScrapeSources("cron-1"), runScrapeSources("cron-2"), runScrapeSources("cron-3")]);
    budget();
    expect(stub.starts).toBe(1);
    expect(results.reduce((n, r) => n + r.started, 0)).toBe(1);
    expect(await db.apifyRun.count()).toBe(1);
  });

  it("fails closed: when the spend cannot be read, nothing starts and the reason is reported", async () => {
    const s = await addSource("a");
    const key = `apify-review-spend:${new Date().toISOString().slice(0, 7)}`;
    await db.automationSetting.create({ data: { key, value: "not json" } });
    const r = await startSourceRun(s, "cron");
    expect(r.status).toBe("BUDGET_UNVERIFIED");
    expect(r.reason).toMatch(/could not be read/);
    expect(stub.starts).toBe(0);
  });

  it("a failed start is not retried and leaves no extra run", async () => {
    const s = await addSource("a");
    const bad = withEnv({ APIFY_API_TOKEN: "wrong-token" });
    const r = await startSourceRun(s, "cron");
    bad();
    expect(r.status).not.toBe("STARTED");
    expect(stub.starts).toBe(0); // rejected before a run exists (401), and not tried again
    expect(await db.apifyRun.count()).toBe(0);
  });

  it("keeps the existing duplicate-run protection: an active run blocks a second start", async () => {
    const s = await addSource("a");
    expect(await startSourceRun(s, "cron")).toMatchObject({ status: "STARTED" });
    expect(await startSourceRun(s, "cron")).toMatchObject({ status: "SKIPPED" });
    expect(stub.starts).toBe(1);
  });
});
