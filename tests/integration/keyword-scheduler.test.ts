import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { runDailyArticle } from "@/lib/automation/daily-article";
import { createKeyword, importKeywords, keywordKey, publishKeywordNow, runKeywordNow, setKeywordEnabled, updateKeyword, validateKeywordInput, type KeywordInput } from "@/lib/automation/keywords";
import { seedTaxonomy } from "@/lib/taxonomy/persist";
import { zonedTimeToUtc } from "@/lib/util/timezone";
import { startStubServer } from "../../scripts/support/stub-server";
import { resetDb } from "../support/db";
import { withEnv } from "../support/env";

// SAMPLE data only: local Keyword-to-Blog and Pexels stubs (same stub as the daily-article tests).
// The stub writes a subject-specific article for "How to choose …" topics and one fixed sample
// body for any other topic (useful for the content-hash check).
let stub: Awaited<ReturnType<typeof startStubServer>>;
let restore: () => void;
const at = (iso: string) => new Date(iso);
const ADMIN = { actor: "admin@example.com", ip: "127.0.0.1", userAgent: "vitest" };
// Morning slot (08:10 IST) on consecutive days; keywords are created the evening before.
const morning = (day: number) => at(`2026-10-${String(day).padStart(2, "0")}T02:40:00Z`);
const CREATED = at("2026-10-05T12:00:00Z");

async function addKeyword(over: Partial<Record<keyof KeywordInput, string | number>>, now = CREATED) {
  const v = validateKeywordInput({ categorySlug: "kitchen-appliances", kind: "GUIDE", frequency: "ONCE", priority: 50, ...over });
  if (!v.ok) throw new Error(v.error);
  const r = await createKeyword(v.value, ADMIN, { now });
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

const publishedFor = (topic: string) => db.normalizedReview.count({ where: { status: "PUBLISHED", productName: topic } });

beforeAll(async () => {
  await seedTaxonomy();
  stub = await startStubServer({});
  restore = withEnv({
    KEYWORD_TO_BLOG_API_URL: `${stub.base}/ktb/v1/generate`,
    KEYWORD_TO_BLOG_API_KEY: "test-ktb-key",
    KEYWORD_TO_BLOG_API_KEY_SECONDARY: undefined,
    GUIDE_AUTOGEN_ENABLED: "true",
    KEYWORD_TO_BLOG_DAILY_LIMIT: "3",
    KEYWORD_ITEMS_PER_SLOT: undefined,
    BUSINESS_TIMEZONE: undefined,
    PEXELS_API_KEY: "test-pexels-key",
    PEXELS_API_BASE_URL: `${stub.base}/pexels/v1`,
    UNSAFE_ALLOW_LOOPBACK_FOR_TESTS: "true",
    IMAGE_ENRICHMENT_URL: undefined,
    CONTENT_API_URL: undefined,
  });
});
afterAll(async () => {
  restore();
  await stub.close();
});
beforeEach(async () => {
  await resetDb();
  Object.assign(stub.ktb, { unavailable: 0, handsOn: false, delayMs: 0, requests: 0, quotaReached: false, rejectPrimary: false, keysUsed: [], tinyPost: false, fixedTitle: "" });
});

describe("keyword scheduler", () => {
  it("picks the highest-priority enabled due keyword before calendar topics; disabled and not-yet-due keywords wait", async () => {
    const low = await addKeyword({ keyword: "How to choose air fryers", priority: 40 });
    const high = await addKeyword({ keyword: "How to choose espresso machines", priority: 90 });
    const off = await addKeyword({ keyword: "How to choose toasters", priority: 100 });
    await setKeywordEnabled(off.id, false, ADMIN);
    const later = await addKeyword({ keyword: "How to choose stand mixers", priority: 99 });
    await db.contentQueueItem.update({ where: { id: later.id }, data: { nextRunAt: at("2026-10-20T00:00:00Z") } });
    // An evening (ARTICLE) keyword never runs in the morning slot.
    await addKeyword({ keyword: "How to choose blenders", priority: 100, kind: "ARTICLE" });

    expect(await runDailyArticle("test", { now: morning(6) })).toMatchObject({ status: "PUBLISHED", slot: "MORNING", topic: high.topic });
    expect(await runDailyArticle("test", { now: morning(7) })).toMatchObject({ status: "PUBLISHED", topic: low.topic });
    const after = await db.contentQueueItem.findUniqueOrThrow({ where: { id: high.id } });
    expect(after).toMatchObject({ status: "PUBLISHED", lastResult: "PUBLISHED", nextRunAt: null, failureReason: null });
    expect(after.lastRunAt?.toISOString()).toBe(morning(6).toISOString());
    expect(await publishedFor(off.topic)).toBe(0);
    expect(await publishedFor(later.topic)).toBe(0);
    // Only the controlled batch: one post per slot per day.
    expect(await db.normalizedReview.count({ where: { status: "PUBLISHED" } })).toBe(2);
  });

  it("never reruns a ONCE keyword after it is published", async () => {
    const once = await addKeyword({ keyword: "How to choose rice cookers", priority: 100, frequency: "ONCE" });
    expect(await runDailyArticle("test", { now: morning(6) })).toMatchObject({ status: "PUBLISHED", topic: once.topic });
    // The next days publish other (calendar) topics; the one-off keyword is not touched again.
    expect((await runDailyArticle("test", { now: morning(7) })).topic).not.toBe(once.topic);
    expect((await runDailyArticle("test", { now: morning(8) })).topic).not.toBe(once.topic);
    expect(await publishedFor(once.topic)).toBe(1);
    const item = await db.contentQueueItem.findUniqueOrThrow({ where: { id: once.id } });
    expect(item).toMatchObject({ status: "PUBLISHED", nextRunAt: null, lastResult: "PUBLISHED" });
    expect(item.lastRunAt?.toISOString()).toBe(morning(6).toISOString());
  });

  it("a recurring keyword whose new result is an exact duplicate is recorded DUPLICATE and not published", async () => {
    const daily = await addKeyword({ keyword: "How to choose coffee grinders", priority: 100, frequency: "DAILY" });
    expect(await runDailyArticle("test", { now: morning(6) })).toMatchObject({ status: "PUBLISHED", topic: daily.topic });
    let item = await db.contentQueueItem.findUniqueOrThrow({ where: { id: daily.id } });
    // Recurring: back in the queue, due from 00:00 IST the next day.
    expect(item).toMatchObject({ status: "QUEUED", lastResult: "PUBLISHED", attempts: 0 });
    expect(item.nextRunAt?.toISOString()).toBe(zonedTimeToUtc("2026-10-07", 0, 0, "Asia/Kolkata").toISOString());

    // Day 2: the API returns the same article again (same title and body) → not published.
    const r = await runDailyArticle("test", { now: morning(7) });
    expect(r.status).not.toBe("PUBLISHED");
    expect(r.reason).toMatch(/duplicate/);
    item = await db.contentQueueItem.findUniqueOrThrow({ where: { id: daily.id } });
    expect(item).toMatchObject({ status: "QUEUED", lastResult: "DUPLICATE", attempts: 0 });
    expect(item.failureReason).toMatch(/same title|same content/);
    expect(item.nextRunAt?.toISOString()).toBe(zonedTimeToUtc("2026-10-08", 0, 0, "Asia/Kolkata").toISOString());
    expect(await publishedFor(daily.topic)).toBe(1);

    // Day 3: a new title over the same body text is still an exact repeat (content hash).
    stub.ktb.fixedTitle = "Coffee grinders: burr or blade, revisited";
    expect(await runDailyArticle("test", { now: morning(8) })).toMatchObject({ status: "RETRYING" });
    item = await db.contentQueueItem.findUniqueOrThrow({ where: { id: daily.id } });
    expect(item).toMatchObject({ lastResult: "DUPLICATE" });
    expect(item.failureReason).toMatch(/body hash/);
    expect(await publishedFor(daily.topic)).toBe(1);

    // Day 4: the API returns a genuinely new article (new title, different text) → published.
    stub.ktb.handsOn = true;
    expect(await runDailyArticle("test", { now: morning(9) })).toMatchObject({ status: "PUBLISHED", topic: daily.topic });
    expect(await publishedFor(daily.topic)).toBe(2);
    expect(await db.contentQueueItem.findUniqueOrThrow({ where: { id: daily.id } })).toMatchObject({ status: "QUEUED", lastResult: "PUBLISHED" });
  });

  it("blocks an exact content-hash duplicate under a different title", async () => {
    // Topics outside "How to choose …" get the stub's one fixed sample body, each with its own title.
    const a = await addKeyword({ keyword: "portable monitors for travel", priority: 100, categorySlug: "laptops" });
    const b = await addKeyword({ keyword: "usb c docks for laptops", priority: 90, categorySlug: "laptops" });
    expect(await runDailyArticle("test", { now: morning(6) })).toMatchObject({ status: "PUBLISHED", topic: a.topic });
    const r = await runDailyArticle("test", { now: morning(7) });
    expect(r.status).not.toBe("PUBLISHED");
    expect(r.reason).toMatch(/body hash/);
    expect(await db.contentQueueItem.findUniqueOrThrow({ where: { id: b.id } })).toMatchObject({ status: "REJECTED", lastResult: "DUPLICATE" });
    expect(await db.normalizedReview.count({ where: { status: "PUBLISHED" } })).toBe(1);
    const stored = await db.normalizedReview.findFirstOrThrow({ where: { status: "PUBLISHED" } });
    expect((stored.generationMeta as { bodyHash?: string; queueKey?: string }).bodyHash).toMatch(/^[0-9a-f]{64}$/);
    expect((stored.generationMeta as { queueKey?: string }).queueKey).toBe(keywordKey(a.topic, "GUIDE"));
  });

  it("publishes different articles about the same product or category", async () => {
    const a = await addKeyword({ keyword: "How to choose espresso machines", priority: 100 });
    const b = await addKeyword({ keyword: "How to choose espresso machines for small kitchens", priority: 90 });
    expect(await runDailyArticle("test", { now: morning(6) })).toMatchObject({ status: "PUBLISHED", topic: a.topic });
    expect(await runDailyArticle("test", { now: morning(7) })).toMatchObject({ status: "PUBLISHED", topic: b.topic });
    const posts = await db.normalizedReview.findMany({ where: { status: "PUBLISHED" }, select: { canonicalTitle: true, categorySlug: true } });
    expect(posts).toHaveLength(2);
    expect(posts.every((p) => /espresso machines/i.test(p.canonicalTitle))).toBe(true);
  });

  it("KEYWORD_ITEMS_PER_SLOT publishes a controlled batch per slot, spaced by the retry backoff", async () => {
    const env = withEnv({ KEYWORD_ITEMS_PER_SLOT: "2", KEYWORD_TO_BLOG_DAILY_LIMIT: "5" });
    try {
      await addKeyword({ keyword: "How to choose kettles", priority: 100 });
      await addKeyword({ keyword: "How to choose slow cookers", priority: 90 });
      await addKeyword({ keyword: "How to choose juicers", priority: 80 });
      expect(await runDailyArticle("test", { now: morning(6) })).toMatchObject({ status: "PUBLISHED" });
      const slot = () => db.automationSlot.findUniqueOrThrow({ where: { day_slot: { day: "2026-10-06", slot: "MORNING" } } });
      expect((await slot()).status).toBe("PENDING");
      // Within the backoff nothing more is generated.
      expect(await runDailyArticle("test", { now: at("2026-10-06T03:00:00Z") })).toMatchObject({ status: "RETRYING" });
      expect(await runDailyArticle("test", { now: at("2026-10-06T03:40:00Z") })).toMatchObject({ status: "PUBLISHED" });
      expect((await slot()).status).toBe("PUBLISHED");
      // The batch is complete: the third keyword waits for tomorrow.
      expect(await runDailyArticle("test", { now: at("2026-10-06T04:40:00Z") })).toMatchObject({ status: "NOT_DUE" });
      expect(await db.normalizedReview.count({ where: { status: "PUBLISHED" } })).toBe(2);
    } finally {
      env();
    }
  });

  it("admin actions are audited: create, exact-repeat refusal, edit, disable/enable, run now, import, publish now", async () => {
    const kw = await addKeyword({ keyword: "How to choose water filters", priority: 30, frequency: "WEEKLY" }, at("2026-10-06T00:00:00Z"));
    // Exact repeat (case/punctuation aside) of the same kind is refused; the other kind is a different post.
    const v = validateKeywordInput({ keyword: "how to choose WATER filters!", categorySlug: "kitchen-appliances", kind: "GUIDE" });
    expect(v.ok && (await createKeyword(v.value, ADMIN)).ok).toBe(false);

    const edited = await updateKeyword(kw.id, { priority: "70", frequency: "TWICE_WEEKLY" }, ADMIN);
    expect(edited).toMatchObject({ ok: true, value: { priority: 70, frequency: "TWICE_WEEKLY", key: kw.key } });
    await setKeywordEnabled(kw.id, false, ADMIN);
    await setKeywordEnabled(kw.id, true, ADMIN);

    const imported = await importKeywords("How to choose dishwashers\nhow to choose DISHWASHERS?\nx\nHow to choose water filters", { kind: "GUIDE", categorySlug: "kitchen-appliances", priority: "20", frequency: "MONTHLY" }, ADMIN, at("2026-10-06T00:00:00Z"));
    expect(imported).toMatchObject({ ok: true, value: { created: 1, duplicates: 2, total: 4 } });
    if (imported.ok) expect(imported.value.invalid).toHaveLength(1);
    const dish = await db.contentQueueItem.findUniqueOrThrow({ where: { key: keywordKey("How to choose dishwashers", "GUIDE") } });
    expect(dish).toMatchObject({ source: "import", frequency: "MONTHLY", priority: 20, status: "QUEUED" });

    // Morning slot publishes the higher-priority keyword; "Run now" only queues, it does not publish.
    expect(await runDailyArticle("test", { now: morning(6) })).toMatchObject({ status: "PUBLISHED", topic: kw.topic });
    const runNow = await runKeywordNow(dish.id, ADMIN, morning(6));
    expect(runNow).toMatchObject({ ok: true });
    expect(await publishedFor(dish.topic)).toBe(0);
    expect(await runDailyArticle("test", { now: at("2026-10-06T05:00:00Z") })).toMatchObject({ status: "NOT_DUE" });

    // "Publish now" runs one attempt immediately, outside the cadence, without touching the slot.
    const calls = stub.ktb.requests;
    const pub = await publishKeywordNow(dish.id, ADMIN, at("2026-10-06T05:00:00Z"));
    expect(pub).toMatchObject({ status: "PUBLISHED", topic: dish.topic });
    expect(stub.ktb.requests - calls).toBe(1);
    expect(await publishedFor(dish.topic)).toBe(1);
    const slot = await db.automationSlot.findUniqueOrThrow({ where: { day_slot: { day: "2026-10-06", slot: "MORNING" } } });
    expect(slot).toMatchObject({ status: "PUBLISHED", apiCalls: 2 });
    // Monthly keyword: next run 30 days later.
    expect((await db.contentQueueItem.findUniqueOrThrow({ where: { id: dish.id } })).nextRunAt?.toISOString()).toBe(zonedTimeToUtc("2026-11-05", 0, 0, "Asia/Kolkata").toISOString());

    const actions = (await db.auditLog.findMany({ where: { action: { startsWith: "keyword." } }, select: { action: true, actor: true } })).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["keyword.create", "keyword.update", "keyword.disable", "keyword.enable", "keyword.import", "keyword.run_now", "keyword.publish_now"]));
    expect((await db.auditLog.findMany({ where: { action: { startsWith: "keyword." } } })).every((a) => a.actor === ADMIN.actor)).toBe(true);
  });

  it("Publish now refuses a disabled keyword and spends no request", async () => {
    const kw = await addKeyword({ keyword: "How to choose food processors" });
    await setKeywordEnabled(kw.id, false, ADMIN);
    expect(await publishKeywordNow(kw.id, ADMIN, morning(6))).toMatchObject({ status: "SKIPPED", reason: expect.stringMatching(/disabled/) });
    expect(stub.ktb.requests).toBe(0);
  });
});
