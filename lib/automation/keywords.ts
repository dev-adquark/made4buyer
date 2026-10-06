import type { ContentQueueItem, Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import type { GuideRequest } from "@/lib/pipeline/ai-guides";
import { audit, type AuditContext } from "@/lib/security/audit";
import { CATEGORY_BY_SLUG } from "@/lib/taxonomy/definitions";
import { sha256 } from "@/lib/util/text";
import { addDays, businessTimezone, dayDiff, zonedParts, zonedTimeToUtc } from "@/lib/util/timezone";

/**
 * Keyword scheduler. Admin and imported keywords live in the same persistent queue as the content
 * calendar's topics (ContentQueueItem) and are published by the two daily slots:
 *
 *   KEYWORD → relevance check → Keyword-to-Blog request → successful response →
 *   EXACT duplicate check (normalized title + type, content hash of the body, slug) → publish
 *
 * No approval, word-count, SEO or similarity gate. A recurring keyword produces a new article only
 * when the API returns one that is not an exact duplicate; otherwise the run is recorded as
 * DUPLICATE and nothing is published. Search volumes are never invented: priority is the owner's.
 */

export const FREQUENCIES = ["DAILY", "TWICE_WEEKLY", "WEEKLY", "MONTHLY", "ONCE"] as const;
export type Frequency = (typeof FREQUENCIES)[number];
export const KEYWORD_KINDS = ["GUIDE", "ARTICLE"] as const;
export type KeywordKind = (typeof KEYWORD_KINDS)[number];
export type RunResult = "PUBLISHED" | "DUPLICATE" | "FAILED" | "SKIPPED";
/** Admin-created keywords recur weekly unless the admin says otherwise; calendar topics are one-off. */
export const DEFAULT_ADMIN_FREQUENCY: Frequency = "WEEKLY";
export const MAX_ITEM_ATTEMPTS = 3;
export const KEYWORD_LIMITS = { keywordMin: 2, keywordMax: 120, maxWords: 16, priorityMin: 0, priorityMax: 100, importLines: 500 } as const;
/** Queue items that are being worked on right now: never edited or re-queued under a running slot. */
export const IN_PROGRESS = ["LOCKED", "GENERATING", "QA"];
const TERMINAL = ["PUBLISHED", "REJECTED", "EXHAUSTED", "FAILED"];

export const isFrequency = (v: unknown): v is Frequency => typeof v === "string" && (FREQUENCIES as readonly string[]).includes(v);
export const isKeywordKind = (v: unknown): v is KeywordKind => typeof v === "string" && (KEYWORD_KINDS as readonly string[]).includes(v);

/** Items per slot (the controlled batch): KEYWORD_ITEMS_PER_SLOT, default 1, at most 3. */
export function keywordItemsPerSlot(): number {
  const n = Number((process.env.KEYWORD_ITEMS_PER_SLOT ?? "").trim() || 1);
  return Number.isInteger(n) ? Math.max(1, Math.min(3, n)) : 1;
}

// ── Normalization and keys ───────────────────────────────────────────────────

/** Lowercase, trimmed, punctuation stripped, spaces collapsed: the dedupe form of a keyword. */
export function normalizeKeyword(raw: string): string {
  return String(raw ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/['’`]/g, "")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The keyword as the admin wrote it, tidied (spaces collapsed): used as the article topic. */
export function cleanKeyword(raw: string): string {
  return String(raw ?? "").normalize("NFKC").replace(/\s+/g, " ").trim();
}

/**
 * Unique queue key from the normalized keyword + kind. Articles keep the calendar's "article:"
 * prefix so the slot type of every queue item is read the same way (calendar keys are unchanged).
 */
export function keywordKey(keyword: string, kind: KeywordKind): string {
  return `${kind === "ARTICLE" ? "article:" : ""}kw:${normalizeKeyword(keyword)}`;
}

/** GUIDE (morning) or ARTICLE (evening) for any queue item, calendar or keyword. */
export function itemType(item: Pick<ContentQueueItem, "key">): KeywordKind {
  return item.key.startsWith("article:") ? "ARTICLE" : "GUIDE";
}

/** Exact content hash: sha256 of the body with case, punctuation and spacing normalized. */
export function bodyHash(body: string): string {
  return sha256(normalizeKeyword(body));
}

// ── Frequency → next run ─────────────────────────────────────────────────────

/**
 * The next due time after a run at `now`: the start (00:00) of a later day in the business time
 * zone, so a daily keyword is due on every slot day however the cron drifts. TWICE_WEEKLY
 * alternates +3 and +4 days (two runs a week); ONCE has no next run.
 */
export function nextRunAfter(freq: string, now: Date, prev: { lastRunAt?: Date | null; nextRunAt?: Date | null } = {}, tz = businessTimezone()): Date | null {
  if (!isFrequency(freq) || freq === "ONCE") return null;
  let days: number;
  if (freq === "DAILY") days = 1;
  else if (freq === "WEEKLY") days = 7;
  else if (freq === "MONTHLY") days = 30;
  else {
    // The gap the previous run was scheduled with decides this one: 3 → 4, anything else → 3.
    const gap = prev.lastRunAt && prev.nextRunAt ? dayDiff(zonedParts(prev.lastRunAt, tz).day, zonedParts(prev.nextRunAt, tz).day) : 0;
    days = gap === 3 ? 4 : 3;
  }
  return zonedTimeToUtc(addDays(zonedParts(now, tz).day, days), 0, 0, tz);
}

/**
 * Queue-item update for a finished run. `attempts` is the item's attempt count after this run.
 * FAILED keeps the item due (the slot's retry backoff decides when), EXHAUSTED after 3 tries for a
 * one-off keyword; a recurring keyword instead waits for its next period with a clean slate.
 */
export function runOutcome(
  item: Pick<ContentQueueItem, "frequency" | "lastRunAt" | "nextRunAt"> & { attempts: number },
  result: RunResult,
  now: Date,
  opts: { reason?: string | null; permanent?: boolean } = {},
): Prisma.ContentQueueItemUpdateInput {
  const recurring = isFrequency(item.frequency) && item.frequency !== "ONCE";
  const next = () => nextRunAfter(item.frequency, now, item);
  const base = { lastRunAt: now, lastResult: result, lockedAt: null, failureReason: opts.reason ? opts.reason.slice(0, 500) : null };
  switch (result) {
    case "PUBLISHED":
      return recurring ? { ...base, status: "QUEUED", attempts: 0, nextRunAt: next(), publishedAt: now } : { ...base, status: "PUBLISHED", nextRunAt: null, publishedAt: now };
    case "DUPLICATE":
      return recurring ? { ...base, status: "QUEUED", attempts: 0, nextRunAt: next() } : { ...base, status: "REJECTED", nextRunAt: null };
    case "FAILED": {
      const exhausted = opts.permanent || item.attempts >= MAX_ITEM_ATTEMPTS;
      if (!exhausted) return { ...base, status: "QUEUED" };
      return recurring ? { ...base, status: "QUEUED", attempts: 0, nextRunAt: next() } : { ...base, status: opts.permanent ? "FAILED" : "EXHAUSTED" };
    }
    case "SKIPPED":
      return { ...base, status: "QUEUED" };
  }
}

// ── Relevance and the Keyword-to-Blog request ────────────────────────────────

/** The relevance check: a real category of the site and a keyword with words in it. */
export function keywordRelevance(item: Pick<ContentQueueItem, "keyword" | "categorySlug">): { ok: true } | { ok: false; reason: string } {
  if (!CATEGORY_BY_SLUG.has(item.categorySlug)) return { ok: false, reason: `category "${item.categorySlug}" is not in the taxonomy` };
  const k = normalizeKeyword(item.keyword);
  if (k.length < KEYWORD_LIMITS.keywordMin || !/\p{L}/u.test(k)) return { ok: false, reason: "the keyword has no words" };
  if (k.split(" ").length > KEYWORD_LIMITS.maxWords) return { ok: false, reason: `the keyword is longer than ${KEYWORD_LIMITS.maxWords} words` };
  return { ok: true };
}

/** What to ask Keyword-to-Blog for an admin keyword: the keyword itself, nothing invented. */
export function keywordRequest(item: Pick<ContentQueueItem, "topic" | "keyword" | "categorySlug" | "productName" | "brand">, type: KeywordKind): GuideRequest {
  const cat = CATEGORY_BY_SLUG.get(item.categorySlug);
  return { productName: item.productName ?? item.topic, brand: item.brand ?? undefined, category: cat?.name, keywords: [normalizeKeyword(item.keyword)], topic: item.topic, articleType: type };
}

// ── Admin: validation ────────────────────────────────────────────────────────

export type KeywordInput = { keyword: string; kind: KeywordKind; categorySlug: string; priority: number; frequency: Frequency; enabled: boolean };
export type KeywordInputRaw = Partial<Record<keyof KeywordInput, string | number | boolean | null | undefined>>;
type Validation<T> = { ok: true; value: T } | { ok: false; error: string };

export function validateKeywordInput(raw: KeywordInputRaw, defaults: Partial<KeywordInput> = {}): Validation<KeywordInput> {
  const has = (k: keyof KeywordInput) => raw[k] !== undefined && raw[k] !== null && String(raw[k]).trim() !== "";
  const keyword = cleanKeyword(String(has("keyword") ? raw.keyword : (defaults.keyword ?? "")));
  const norm = normalizeKeyword(keyword);
  if (norm.length < KEYWORD_LIMITS.keywordMin || keyword.length > KEYWORD_LIMITS.keywordMax || !/\p{L}/u.test(norm)) return { ok: false, error: `Keyword: ${KEYWORD_LIMITS.keywordMin}–${KEYWORD_LIMITS.keywordMax} characters with at least one word` };
  if (norm.split(" ").length > KEYWORD_LIMITS.maxWords) return { ok: false, error: `Keyword: at most ${KEYWORD_LIMITS.maxWords} words` };
  const kind = String(has("kind") ? raw.kind : (defaults.kind ?? "GUIDE")).trim().toUpperCase();
  if (!isKeywordKind(kind)) return { ok: false, error: "Kind: GUIDE or ARTICLE" };
  const categorySlug = String(has("categorySlug") ? raw.categorySlug : (defaults.categorySlug ?? "")).trim();
  if (!CATEGORY_BY_SLUG.has(categorySlug)) return { ok: false, error: categorySlug ? `Unknown category: ${categorySlug}` : "Choose a category" };
  const priority = has("priority") ? Number(String(raw.priority).trim()) : (defaults.priority ?? 50);
  if (!Number.isInteger(priority) || priority < KEYWORD_LIMITS.priorityMin || priority > KEYWORD_LIMITS.priorityMax) return { ok: false, error: `Priority: a whole number ${KEYWORD_LIMITS.priorityMin}–${KEYWORD_LIMITS.priorityMax}` };
  const frequency = String(has("frequency") ? raw.frequency : (defaults.frequency ?? DEFAULT_ADMIN_FREQUENCY)).trim().toUpperCase();
  if (!isFrequency(frequency)) return { ok: false, error: `Frequency: ${FREQUENCIES.join(", ")}` };
  const enabled = raw.enabled === undefined || raw.enabled === null || raw.enabled === "" ? (defaults.enabled ?? true) : /^(1|true|on|yes)$/i.test(String(raw.enabled).trim());
  return { ok: true, value: { keyword, kind, categorySlug, priority, frequency, enabled } };
}

// ── Admin: mutations (every one audited) ─────────────────────────────────────

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export async function createKeyword(input: KeywordInput, ctx: AuditContext, opts: { now?: Date; source?: string } = {}): Promise<Result<ContentQueueItem>> {
  const now = opts.now ?? new Date();
  const key = keywordKey(input.keyword, input.kind);
  const clash = await db.contentQueueItem.findUnique({ where: { key }, select: { id: true, topic: true } });
  if (clash) return { ok: false, error: `"${input.keyword}" (${input.kind}) is already scheduled as "${clash.topic}"` };
  const item = await db.contentQueueItem.create({
    data: { key, topic: input.keyword, keyword: normalizeKeyword(input.keyword), kind: input.kind, categorySlug: input.categorySlug, priority: input.priority, frequency: input.frequency, enabled: input.enabled, source: opts.source ?? "admin", status: "QUEUED", nextRunAt: now },
  });
  await audit(ctx, { action: "keyword.create", entityType: "content_queue", entityId: item.id, after: item });
  return { ok: true, value: item };
}

export async function updateKeyword(id: string, raw: KeywordInputRaw, ctx: AuditContext, now = new Date()): Promise<Result<ContentQueueItem>> {
  const before = await db.contentQueueItem.findUnique({ where: { id } });
  if (!before) return { ok: false, error: "Keyword not found" };
  if (IN_PROGRESS.includes(before.status)) return { ok: false, error: "This keyword is being generated right now; edit it after the run" };
  const calendar = before.source === "calendar";
  const v = validateKeywordInput(calendar ? { ...raw, keyword: before.topic, kind: itemType(before), categorySlug: before.categorySlug } : raw, {
    keyword: before.topic,
    kind: before.kind === "ARTICLE" || before.kind === "GUIDE" ? before.kind : itemType(before),
    categorySlug: before.categorySlug,
    priority: Math.max(0, Math.min(100, before.priority)),
    frequency: isFrequency(before.frequency) ? before.frequency : "ONCE",
    enabled: before.enabled,
  });
  if (!v.ok) return v;
  const input = v.value;
  // Calendar topics keep their key (the calendar recognises them by it); keyword items re-key.
  const key = calendar ? before.key : keywordKey(input.keyword, input.kind);
  if (key !== before.key) {
    const clash = await db.contentQueueItem.findUnique({ where: { key }, select: { id: true } });
    if (clash && clash.id !== id) return { ok: false, error: `"${input.keyword}" (${input.kind}) is already scheduled` };
  }
  const reschedule = before.frequency !== input.frequency && input.frequency !== "ONCE" && TERMINAL.includes(before.status);
  const after = await db.contentQueueItem.update({
    where: { id },
    data: {
      ...(calendar ? {} : { key, topic: input.keyword, keyword: normalizeKeyword(input.keyword), kind: input.kind, categorySlug: input.categorySlug }),
      priority: input.priority,
      frequency: input.frequency,
      enabled: input.enabled,
      // A finished one-off keyword made recurring is scheduled again from its last run.
      ...(reschedule ? { status: "QUEUED", attempts: 0, nextRunAt: nextRunAfter(input.frequency, before.lastRunAt ?? now, before) ?? now } : {}),
    },
  });
  await audit(ctx, { action: "keyword.update", entityType: "content_queue", entityId: id, before, after });
  return { ok: true, value: after };
}

export async function setKeywordEnabled(id: string, enabled: boolean, ctx: AuditContext): Promise<Result<ContentQueueItem>> {
  const before = await db.contentQueueItem.findUnique({ where: { id } });
  if (!before) return { ok: false, error: "Keyword not found" };
  const after = await db.contentQueueItem.update({ where: { id }, data: { enabled } });
  await audit(ctx, { action: enabled ? "keyword.enable" : "keyword.disable", entityType: "content_queue", entityId: id, before: { enabled: before.enabled }, after: { enabled } });
  return { ok: true, value: after };
}

/**
 * "Run now": due at the next slot of its type (nextRunAt = now). It does not bypass the daily
 * cadence; a finished, rejected or exhausted item is put back in the queue with fresh attempts.
 */
export async function runKeywordNow(id: string, ctx: AuditContext, now = new Date()): Promise<Result<ContentQueueItem>> {
  const before = await db.contentQueueItem.findUnique({ where: { id } });
  if (!before) return { ok: false, error: "Keyword not found" };
  if (IN_PROGRESS.includes(before.status)) return { ok: false, error: "This keyword is being generated right now" };
  const after = await db.contentQueueItem.update({ where: { id }, data: { nextRunAt: now, ...(before.status === "QUEUED" ? {} : { status: "QUEUED", attempts: 0 }) } });
  await audit(ctx, { action: "keyword.run_now", entityType: "content_queue", entityId: id, before: { status: before.status, nextRunAt: before.nextRunAt }, after: { status: after.status, nextRunAt: after.nextRunAt } });
  return { ok: true, value: after };
}

export type ImportResult = { created: number; duplicates: number; invalid: Array<{ line: string; error: string }>; total: number };

/** Bulk import, one keyword per line, with shared kind/category/priority/frequency. Exact repeats (normalized keyword + kind) are skipped. */
export async function importKeywords(text: string, rawDefaults: Omit<KeywordInputRaw, "keyword">, ctx: AuditContext, now = new Date()): Promise<Result<ImportResult>> {
  const lines = String(text ?? "").split(/\r?\n/).map(cleanKeyword).filter(Boolean);
  if (!lines.length) return { ok: false, error: "Paste at least one keyword, one per line" };
  // The shared settings are validated once (a placeholder keyword stands in for the lines).
  const shared = validateKeywordInput({ ...rawDefaults, keyword: "placeholder" });
  if (!shared.ok) return shared;
  const { kind, categorySlug, priority, frequency, enabled } = shared.value;
  const defaults = { kind, categorySlug, priority, frequency, enabled };
  if (lines.length > KEYWORD_LIMITS.importLines) return { ok: false, error: `At most ${KEYWORD_LIMITS.importLines} keywords per import` };
  const result: ImportResult = { created: 0, duplicates: 0, invalid: [], total: lines.length };
  const rows = new Map<string, Prisma.ContentQueueItemCreateManyInput>();
  for (const line of lines) {
    const v = validateKeywordInput({ ...defaults, keyword: line });
    if (!v.ok) {
      result.invalid.push({ line: line.slice(0, 80), error: v.error });
      continue;
    }
    const key = keywordKey(v.value.keyword, v.value.kind);
    if (rows.has(key)) {
      result.duplicates++;
      continue;
    }
    rows.set(key, { key, topic: v.value.keyword, keyword: normalizeKeyword(v.value.keyword), kind: v.value.kind, categorySlug: v.value.categorySlug, priority: v.value.priority, frequency: v.value.frequency, enabled: v.value.enabled, source: "import", status: "QUEUED", nextRunAt: now });
  }
  const created = rows.size ? await db.contentQueueItem.createMany({ data: [...rows.values()], skipDuplicates: true }) : { count: 0 };
  result.created = created.count;
  result.duplicates += rows.size - created.count;
  await audit(ctx, { action: "keyword.import", entityType: "content_queue", entityId: "import", metadata: { ...result, invalid: result.invalid.slice(0, 20), defaults } });
  return { ok: true, value: result };
}

/**
 * "Publish now": one immediate slot attempt for this keyword through the daily-article runner
 * (trigger "admin:…", the same job lock as the scheduler). Exact-duplicate checks still apply.
 */
export async function publishKeywordNow(id: string, ctx: AuditContext, now = new Date()) {
  const { runDailyArticle } = await import("./daily-article");
  const { withLock } = await import("@/lib/jobs/lock");
  const result = await withLock("job:daily-article", 6 * 60_000, () => runDailyArticle(`admin:keywords:${ctx.actor}`, { now, queueItemId: id }));
  await audit(ctx, { action: "keyword.publish_now", entityType: "content_queue", entityId: id, metadata: result });
  return result;
}

// ── Admin: queries ───────────────────────────────────────────────────────────

export type KeywordFilter = { source?: "keywords" | "calendar" | "all"; kind?: KeywordKind; status?: string; enabled?: boolean; category?: string; frequency?: Frequency; lastResult?: string; q?: string };

export function keywordWhere(f: KeywordFilter = {}): Prisma.ContentQueueItemWhereInput {
  const and: Prisma.ContentQueueItemWhereInput[] = [];
  const source = f.source ?? "keywords";
  if (source === "keywords") and.push({ source: { not: "calendar" } });
  else if (source === "calendar") and.push({ source: "calendar" });
  if (f.kind === "ARTICLE") and.push({ key: { startsWith: "article:" } });
  else if (f.kind === "GUIDE") and.push({ NOT: { key: { startsWith: "article:" } } });
  if (f.status) and.push({ status: f.status });
  if (f.enabled !== undefined) and.push({ enabled: f.enabled });
  if (f.category) and.push({ categorySlug: f.category });
  if (f.frequency) and.push({ frequency: f.frequency });
  if (f.lastResult) and.push({ lastResult: f.lastResult });
  const q = f.q?.trim().slice(0, 80);
  if (q) and.push({ OR: [{ topic: { contains: q, mode: "insensitive" } }, { keyword: { contains: normalizeKeyword(q) } }] });
  return and.length ? { AND: and } : {};
}

export function listKeywords(f: KeywordFilter = {}, take = 300) {
  return db.contentQueueItem.findMany({ where: keywordWhere(f), orderBy: [{ enabled: "desc" }, { priority: "desc" }, { createdAt: "asc" }], take });
}
