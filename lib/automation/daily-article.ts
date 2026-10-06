import type { ContentQueueItem } from "@prisma/client";
import { config } from "@/lib/config";
import {
  contentOpportunities,
  subjectKey,
  type Opportunity,
} from "@/lib/content/calendar";
import { db } from "@/lib/db";
import { log } from "@/lib/log";
import {
  aiGuidesConfigured,
  AI_GUIDE_SOURCE,
  generateGuide,
  type GuideRequest,
} from "@/lib/pipeline/ai-guides";
import { recordFailure } from "@/lib/pipeline/failures";
import { guideRequestFor } from "@/lib/pipeline/guide-ideas";
import { ingestGeneratedPost } from "@/lib/pipeline/ingest";
import { publishReview } from "@/lib/pipeline/publish";
import { audit, SYSTEM_ACTOR } from "@/lib/security/audit";
import { CATEGORY_BY_SLUG } from "@/lib/taxonomy/definitions";
import { slugify } from "@/lib/util/text";
import { addDays, businessTimezone, zonedParts, zonedTimeToUtc } from "@/lib/util/timezone";
import { bodyHash, keywordItemsPerSlot, keywordRelevance, keywordRequest, runOutcome, IN_PROGRESS, MAX_ITEM_ATTEMPTS } from "./keywords";
import { allowed } from "./settings";

/**
 * Daily article automation: a buying GUIDE in the MORNING slot (08:00 business time, default
 * Asia/Kolkata) and an informational ARTICLE in the EVENING slot (19:00). Direct publish (owner's rule):
 *
 *   Relevant topic or due keyword → exact-duplicate check (calendar topics: same topic + type; no
 *   API call on a repeat) → Keyword-to-Blog → exact check (same title + type, same slug, same body
 *   content hash) → store → publish as returned
 *
 * No quality, SEO or approval gate. Commerce offers and images are optional enrichment and never block.
 * Runs are idempotent (KEYWORD_ITEMS_PER_SLOT posts per slot per day, default 1), serialised by a
 * job lock, and bounded by the provider's daily quota and a per-slot attempt cap. Scheduled
 * keywords (lib/automation/keywords.ts) that are due go before calendar topics.
 */

export type Slot = "MORNING" | "EVENING";
/** Slot hours in the business time zone (BUSINESS_TIMEZONE, default Asia/Kolkata). */
export const SLOT_HOUR_IST: Record<Slot, number> = { MORNING: 8, EVENING: 19 };
export const MAX_SLOT_ATTEMPTS = 2;
/** Minimum gap between two attempts on one slot (exponential across runs: ×2 per attempt). */
export const RETRY_BACKOFF_MS = 45 * 60_000;
const STUCK_MS = 30 * 60_000;
export const AUTOMATION_APPROVER = "automation:direct-publish";
/** Morning publishes a buying guide, evening an informational article. */
export type ArticleType = "GUIDE" | "ARTICLE";
export const SLOT_TYPE: Record<Slot, ArticleType> = {
  MORNING: "GUIDE",
  EVENING: "ARTICLE",
};
const typeOfKey = (key: string): ArticleType =>
  key.startsWith("article:") ? "ARTICLE" : "GUIDE";

/** Day and wall-clock time in the business time zone (named for its default, IST). */
export function istParts(now: Date) {
  const { day, hour, minute } = zonedParts(now, businessTimezone());
  return { day, hour, minute };
}

/** The next run time (UTC) for a slot, after `now`. */
export function nextSlotRun(slot: Slot, now: Date): Date {
  const tz = businessTimezone();
  const { day } = zonedParts(now, tz);
  const at = zonedTimeToUtc(day, SLOT_HOUR_IST[slot], 0, tz);
  return at > now ? at : zonedTimeToUtc(addDays(day, 1), SLOT_HOUR_IST[slot], 0, tz);
}

// ─── Duplicate agent (exact repeats only) ────────────────────────────────────

/**
 * Finds existing content (any status, including drafts and rejected) or queue work that already
 * covers this subject. Returns the reason, or null when the topic is genuinely new.
 */
export async function findDuplicate(
  subject: string,
  categorySlug: string,
  opts: { title?: string; excludeQueueId?: string; type?: ArticleType } = {},
): Promise<string | null> {
  const key = subjectKey(subject);
  const type = opts.type ?? "GUIDE";
  const [content, queued] = await Promise.all([
    db.normalizedReview.findMany({
      where: {
        OR: [{ kind: { in: ["AI_GUIDE", "BUYING_GUIDE"] } }, { categorySlug }],
      },
      select: {
        id: true,
        canonicalTitle: true,
        productName: true,
        kind: true,
        status: true,
        generationMeta: true,
      },
    }),
    db.contentQueueItem.findMany({
      where: {
        status: { in: ["LOCKED", "GENERATING", "QA", "PUBLISHED"] },
        ...(opts.excludeQueueId ? { id: { not: opts.excludeQueueId } } : {}),
      },
      select: { topic: true, status: true, key: true },
    }),
  ]);
  for (const c of content) {
    // Same subject only counts as a repeat within the same post type (a guide and an article
    // on one subject are different posts); identical titles always count.
    const cType =
      (c.generationMeta as { articleType?: ArticleType } | null)?.articleType ??
      "GUIDE";
    // Our own posts only: a publisher's guide on the same subject is not a repeat of ours.
    const isGuide = c.kind === "AI_GUIDE" && cType === type;
    if (isGuide && subjectKey(c.productName) === key)
      return `already covered by "${c.canonicalTitle}" (${c.status})`;
    // Exact returned title (case and punctuation aside) of an AI post of the same type.
    if (opts.title && c.kind === "AI_GUIDE" && cType === type && subjectKey(c.canonicalTitle) === subjectKey(opts.title))
      return `same title as "${c.canonicalTitle}" (${c.status})`;
  }
  for (const q of queued.filter((q) => typeOfKey(q.key) === type))
    if (
      subjectKey(q.topic) === key
    )
      return `already ${q.status.toLowerCase()} in the queue: "${q.topic}"`;
  return null;
}

/**
 * Exact repeats of a generated post among our own posts (any status): the same normalized title
 * or the same canonical slug within one post type, or the same body text (content hash, any type).
 * Different articles about the same product or category are never blocked.
 */
export async function findExactDuplicate(post: { title: string; body: string }, type: ArticleType): Promise<string | null> {
  const titleKey = subjectKey(post.title);
  const slug = slugify(post.title, 90);
  const hash = bodyHash(post.body);
  const own = await db.normalizedReview.findMany({
    where: { kind: "AI_GUIDE" },
    select: { id: true, canonicalTitle: true, slug: true, status: true, generationMeta: true },
  });
  // Posts stored before the hash was recorded are hashed from their stored body.
  const unhashed = own.filter((c) => !(c.generationMeta as { bodyHash?: string } | null)?.bodyHash).map((c) => c.id);
  const bodies = unhashed.length ? await db.normalizedReview.findMany({ where: { id: { in: unhashed } }, select: { id: true, body: true } }) : [];
  const legacy = new Map(bodies.map((b) => [b.id, bodyHash(b.body)]));
  for (const c of own) {
    const meta = (c.generationMeta ?? null) as { articleType?: ArticleType; bodyHash?: string } | null;
    const cType = meta?.articleType ?? "GUIDE";
    if (cType === type && subjectKey(c.canonicalTitle) === titleKey) return `same title as "${c.canonicalTitle}" (${c.status})`;
    if (cType === type && slug && (c.slug === slug || slugify(c.canonicalTitle, 90) === slug)) return `same slug as "${c.canonicalTitle}" (${c.status})`;
    if ((meta?.bodyHash ?? legacy.get(c.id)) === hash) return `same content (body hash) as "${c.canonicalTitle}" (${c.status})`;
  }
  return null;
}

// ─── Topic agent ─────────────────────────────────────────────────────────────

/** Adds new calendar opportunities to the persistent queue (existing keys are left alone). */
export async function refreshQueue(now = new Date()) {
  const opps = await contentOpportunities({ now, limit: 100 });
  const rows = opps.flatMap((o: Opportunity) =>
    (["GUIDE", "ARTICLE"] as const).map((type) => {
      const req = guideRequestFor(o, type);
      return {
        key: type === "ARTICLE" ? `article:${o.key}` : o.key,
        topic: o.subject,
        keyword: req.keywords[0],
        kind: o.kind,
        categorySlug: o.categorySlug,
        subcategorySlug: o.subcategorySlug ?? null,
        productName: o.kind === "PRODUCT_GUIDE" ? o.subject : null,
        brand: o.brand ?? null,
        priority: o.score,
      };
    }),
  );
  const created = rows.length
    ? await db.contentQueueItem.createMany({ data: rows, skipDuplicates: true })
    : { count: 0 };
  // Refresh priorities of still-queued topics (coverage and season change over time).
  for (const r of rows)
    await db.contentQueueItem.updateMany({
      where: { key: r.key, status: "QUEUED" },
      data: { priority: r.priority },
    });
  return created.count;
}

/** Items stuck in LOCKED/GENERATING/QA (a crashed run) go back to the queue. */
export async function recoverStuck(now = new Date()) {
  const r = await db.contentQueueItem.updateMany({
    where: {
      // A QA item that already has its stored post is published by the recovery step instead.
      OR: [{ status: { in: ["LOCKED", "GENERATING"] } }, { status: "QA", normalizedReviewId: null }],
      lockedAt: { lt: new Date(now.getTime() - STUCK_MS) },
    },
    data: {
      status: "QUEUED",
      lockedAt: null,
      failureReason: "recovered after a stuck run",
    },
  });
  return r.count;
}

/**
 * Next topic for a slot. First the scheduled keywords that are due (nextRunAt ≤ now: admin and
 * imported keywords, recurring keywords, "Run now"), highest priority first. Otherwise the
 * highest-priority calendar topic, balanced: categories published by automation in the last 7
 * days are penalised, and the last two automated articles' categories are skipped.
 */
export async function pickNextTopic(
  now = new Date(),
  type: ArticleType = "GUIDE",
): Promise<ContentQueueItem | null> {
  const due = await db.contentQueueItem.findMany({
    where: {
      status: "QUEUED",
      enabled: true,
      attempts: { lt: MAX_ITEM_ATTEMPTS },
      nextRunAt: { lte: now },
      ...(type === "ARTICLE" ? { key: { startsWith: "article:" } } : { NOT: { key: { startsWith: "article:" } } }),
    },
    orderBy: [{ priority: "desc" }, { nextRunAt: "asc" }, { createdAt: "asc" }],
    take: 50,
  });
  const scheduled = due.find((q) => CATEGORY_BY_SLUG.has(q.categorySlug));
  if (scheduled) return scheduled;
  const recent = await db.contentQueueItem.findMany({
    where: {
      status: "PUBLISHED",
      publishedAt: { gte: new Date(now.getTime() - 7 * 86_400_000) },
    },
    orderBy: { publishedAt: "desc" },
    select: { categorySlug: true },
  });
  const lastTwo = new Set(recent.slice(0, 2).map((r) => r.categorySlug));
  const count = (c: string) =>
    recent.filter((r) => r.categorySlug === c).length;
  const queued = await db.contentQueueItem.findMany({
    where: { status: "QUEUED", enabled: true, attempts: { lt: MAX_ITEM_ATTEMPTS }, nextRunAt: null },
    orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
    take: 200,
  });
  const ranked = queued
    .filter(
      (q) => CATEGORY_BY_SLUG.has(q.categorySlug) && typeOfKey(q.key) === type,
    )
    .map((q) => ({
      q,
      score:
        q.priority -
        count(q.categorySlug) * 25 -
        (lastTwo.has(q.categorySlug) ? 1000 : 0),
    }))
    .sort((a, b) => b.score - a.score);
  return ranked[0]?.q ?? null;
}

/** Atomically claims a topic so two runs can never generate the same article. */
async function claim(id: string, now: Date): Promise<boolean> {
  const r = await db.contentQueueItem.updateMany({
    where: { id, status: "QUEUED" },
    data: { status: "LOCKED", lockedAt: now },
  });
  return r.count === 1;
}

// ─── The run ─────────────────────────────────────────────────────────────────

export type DailyArticleResult = {
  status:
    | "PAUSED"
    | "PUBLISHED"
    | "SKIPPED"
    | "NOT_DUE"
    | "BLOCKED"
    | "RETRYING"
    | "REJECTED"
    | "DISABLED"
    | "BLOCKED_BY_ENVIRONMENT";
  slot?: Slot;
  day?: string;
  reason?: string;
  topic?: string;
  reviewSlug?: string;
  attempts?: number;
  queueItemId?: string;
};

export function dueSlot(
  now: Date,
  slots: Array<{ slot: string; status: string }>,
): Slot | null {
  const { hour } = istParts(now);
  // The current slot goes first: after 19:00 the evening post is not delayed by a morning retry
  // (the morning retry still runs on a later trigger the same day).
  const order: Slot[] = hour >= SLOT_HOUR_IST.EVENING ? ["EVENING", "MORNING"] : ["MORNING", "EVENING"];
  for (const s of order) {
    if (hour < SLOT_HOUR_IST[s]) continue;
    const row = slots.find((r) => r.slot === s);
    if (!row || !["PUBLISHED", "BLOCKED"].includes(row.status)) return s;
  }
  return null;
}

/**
 * One slot attempt. Scheduled runs pick the slot that is due and the best topic for it.
 * `queueItemId` (Admin → Keywords → "Publish now", trigger "admin:…") runs that one keyword
 * immediately, outside the slot cadence: it spends quota like any run but never changes the
 * slot's own state, so the scheduled post of the day still follows.
 */
export async function runDailyArticle(
  trigger: string,
  opts: { now?: Date; slot?: Slot; queueItemId?: string } = {},
): Promise<DailyArticleResult> {
  const now = opts.now ?? new Date();
  if (!config.aiGuides.autoGenerate())
    return { status: "DISABLED", reason: "GUIDE_AUTOGEN_ENABLED is not true" };
  if (!aiGuidesConfigured())
    return {
      status: "BLOCKED_BY_ENVIRONMENT",
      reason: "Keyword-to-Blog is not configured",
    };
  const manual = Boolean(opts.queueItemId);
  if (manual && !trigger.startsWith("admin:"))
    return { status: "SKIPPED", reason: "a single keyword can only be published from Admin" };
  const forced = opts.queueItemId
    ? await db.contentQueueItem.findUnique({ where: { id: opts.queueItemId } })
    : null;
  if (manual && !forced) return { status: "SKIPPED", reason: "keyword not found" };
  if (forced && !forced.enabled)
    return { status: "SKIPPED", reason: "this keyword is disabled: enable it first", queueItemId: forced.id };
  if (forced && IN_PROGRESS.includes(forced.status))
    return { status: "SKIPPED", reason: "this keyword is being generated right now", queueItemId: forced.id };
  const { day } = istParts(now);
  const todays = await db.automationSlot.findMany({ where: { day } });
  const slot = forced
    ? typeOfKey(forced.key) === "ARTICLE" ? "EVENING" : "MORNING"
    : (opts.slot ?? dueSlot(now, todays));
  if (!slot)
    return {
      status: "NOT_DUE",
      day,
      reason: `next run ${nextSlotRun("MORNING", now) < nextSlotRun("EVENING", now) ? "MORNING" : "EVENING"} at ${[nextSlotRun("MORNING", now), nextSlotRun("EVENING", now)].sort((a, b) => a.getTime() - b.getTime())[0].toISOString()}`,
    };

  // Concurrent first runs of the day may both try to create the slot row: the loser reads it.
  // Per-type switches (morning guides / evening articles) apply to scheduled runs.
  if (!trigger.startsWith("admin:")) {
    const gate = await allowed(SLOT_TYPE[slot] === "GUIDE" ? "guides" : "articles");
    if (!gate.ok) return { status: "PAUSED", slot, day, reason: gate.reason };
  }
  const row = await db.automationSlot
    .upsert({
      where: { day_slot: { day, slot } },
      create: { day, slot },
      update: {},
    })
    .catch(async (error: { code?: string }) => {
      if (error.code !== "P2002") throw error;
      return db.automationSlot.findUniqueOrThrow({
        where: { day_slot: { day, slot } },
      });
    });
  if (!manual && row.status === "PUBLISHED")
    return {
      status: "SKIPPED",
      slot,
      day,
      reason: "this slot already published an article today",
    };
  if (!manual && row.status === "BLOCKED")
    return { status: "BLOCKED", slot, day, reason: row.lastError ?? "blocked" };
  if (
    row.status === "RUNNING" &&
    row.lastAttemptAt &&
    now.getTime() - row.lastAttemptAt.getTime() < STUCK_MS
  )
    return {
      status: "SKIPPED",
      slot,
      day,
      reason: "another run is already working on this slot",
    };
  if (!manual && row.attempts >= MAX_SLOT_ATTEMPTS) {
    await db.automationSlot.update({
      where: { id: row.id },
      data: { status: "BLOCKED" },
    });
    return {
      status: "BLOCKED",
      slot,
      day,
      reason: `gave up after ${row.attempts} attempts: ${row.lastError ?? ""}`,
    };
  }
  // Exponential backoff between attempts on the same slot (45 min, then 90...).
  if (
    !manual &&
    row.lastAttemptAt &&
    now.getTime() - row.lastAttemptAt.getTime() <
      RETRY_BACKOFF_MS * 2 ** Math.max(0, row.attempts - 1)
  ) {
    return {
      status: "RETRYING",
      slot,
      day,
      reason: `backing off after: ${row.lastError ?? "previous attempt"}`,
      attempts: row.attempts,
    };
  }
  // Provider quota: the plan's daily requests, keeping one for the evening while it is pending.
  const used = todays.reduce((n, s) => n + s.apiCalls, 0);
  const eveningPending =
    !manual &&
    slot === "MORNING" &&
    !todays.some((s) => s.slot === "EVENING" && s.status === "PUBLISHED");
  const budget = config.aiGuides.dailyLimit() - used - (eveningPending ? 1 : 0);
  if (budget <= 0) {
    if (!manual)
      await db.automationSlot.update({
        where: { id: row.id },
        // A slot that already published part of its batch keeps that: it is done for today.
        data: row.publishedAt
          ? { status: "PUBLISHED" }
          : {
              status: "BLOCKED",
              lastError: `Keyword-to-Blog daily quota used (${used}/${config.aiGuides.dailyLimit()})`,
            },
      });
    return {
      status: "BLOCKED",
      slot,
      day,
      reason: "Keyword-to-Blog daily quota used",
    };
  }

  await recoverStuck(now);
  await refreshQueue(now);
  const attemptNo = manual ? row.attempts : row.attempts + 1;
  // Atomic claim of the slot: a second concurrent runner finds it RUNNING and stops.
  if (!manual) {
    const claimed = await db.automationSlot.updateMany({
      where: { id: row.id, status: row.status, attempts: row.attempts },
      data: { status: "RUNNING", attempts: attemptNo, lastAttemptAt: now },
    });
    if (!claimed.count)
      return {
        status: "SKIPPED",
        slot,
        day,
        reason: "another run is already working on this slot",
      };
  }
  const fail = async (reason: string, retry: boolean) => {
    const status =
      retry && (manual || attemptNo < MAX_SLOT_ATTEMPTS)
        ? ("RETRYING" as const)
        : ("BLOCKED" as const);
    // A manual attempt never blocks or retries the scheduled slot; its outcome is on the keyword.
    if (!manual)
      await db.automationSlot.update({
        where: { id: row.id },
        data: { status, lastError: reason.slice(0, 500) },
      });
    await recordFailure({
      stage: "PUBLISH",
      code: "DAILY_ARTICLE_NOT_PUBLISHED",
      message: `daily article ${day} ${manual ? "admin" : slot}: ${reason}`,
      entityType: "job",
      entityId: `daily-article:${day}:${manual ? `admin:${opts.queueItemId}` : slot}`,
      retryable: false,
    });
    log.warn("daily article not published", {
      stage: "PUBLISH",
      day,
      slot,
      manual,
      reason,
    });
    return {
      status: manual ? (/duplicate/i.test(reason) ? ("REJECTED" as const) : ("BLOCKED" as const)) : status,
      slot,
      day,
      reason,
      attempts: attemptNo,
      ...(opts.queueItemId ? { queueItemId: opts.queueItemId } : {}),
    };
  };

  const type = SLOT_TYPE[slot];
  const slotKey = `${day}:${slot}`;
  // Marks the slot done once its batch (KEYWORD_ITEMS_PER_SLOT) is published; until then it
  // stays open (PENDING, fresh attempts) and the next trigger after the backoff adds the next post.
  const slotPublished = async (reviewId: string, queueItemId: string) => {
    if (manual) return;
    const perSlot = keywordItemsPerSlot();
    const count =
      perSlot > 1
        ? await db.normalizedReview.count({
            where: { status: "PUBLISHED", generationMeta: { path: ["slotKey"], equals: slotKey } },
          })
        : perSlot;
    await db.automationSlot.update({
      where: { id: row.id },
      data: {
        status: count >= perSlot ? "PUBLISHED" : "PENDING",
        ...(count >= perSlot ? {} : { attempts: 0 }),
        normalizedReviewId: reviewId,
        publishedAt: now,
        lastError: null,
        queueItemId,
      },
    });
  };
  // Recovery: a post generated earlier but not yet published (e.g. a publish error) is published
  // now, with no new API call.
  const pending = manual ? null : await db.contentQueueItem.findFirst({ where: { status: "QA", normalizedReviewId: { not: null }, key: type === "ARTICLE" ? { startsWith: "article:" } : { not: { startsWith: "article:" } } } });
  if (pending?.normalizedReviewId) {
    const rev = await db.normalizedReview.findUnique({ where: { id: pending.normalizedReviewId }, select: { id: true, slug: true, status: true } });
    if (rev && rev.status !== "PUBLISHED" && rev.status !== "REJECTED") {
      const ok = await publishReview(rev.id, { ...SYSTEM_ACTOR, actor: AUTOMATION_APPROVER }, "auto", { skipQa: true }).catch(() => null);
      if (ok?.ok) {
        await db.contentQueueItem.update({ where: { id: pending.id }, data: runOutcome(pending, "PUBLISHED", now) });
        await slotPublished(rev.id, pending.id);
        return { status: "PUBLISHED", slot, day, topic: pending.topic, reviewSlug: rev.slug, attempts: attemptNo, queueItemId: pending.id };
      }
    }
  }
  // Topic agent + duplicate agent: free checks first, so no API call is spent on a duplicate.
  let topic: ContentQueueItem | null = null;
  if (forced) {
    // "Publish now" re-queues a finished, rejected or exhausted keyword with fresh attempts.
    if (forced.status !== "QUEUED")
      await db.contentQueueItem.updateMany({
        where: { id: forced.id, status: forced.status },
        data: { status: "QUEUED", attempts: 0 },
      });
    if (!(await claim(forced.id, now)))
      return { status: "SKIPPED", slot, day, reason: "another run took this keyword", queueItemId: forced.id };
    const relevant = keywordRelevance(forced);
    if (!relevant.ok) {
      await db.contentQueueItem.update({ where: { id: forced.id }, data: runOutcome({ ...forced, attempts: 0 }, "SKIPPED", now, { reason: `not relevant: ${relevant.reason}` }) });
      return { status: "REJECTED", slot, day, reason: `not relevant: ${relevant.reason}`, queueItemId: forced.id };
    }
    topic = { ...forced, status: "LOCKED", attempts: forced.status === "QUEUED" ? forced.attempts : 0 };
  }
  for (let i = 0; !topic && i < 25; i++) {
    const next = await pickNextTopic(now, type);
    if (!next) break;
    if (!(await claim(next.id, now))) continue;
    // Relevance check: a real category and a keyword with words in it.
    const relevant = keywordRelevance(next);
    if (!relevant.ok) {
      await db.contentQueueItem.update({
        where: { id: next.id },
        data: { ...runOutcome(next, "SKIPPED", now, { reason: `not relevant: ${relevant.reason}` }), status: "REJECTED", nextRunAt: null },
      });
      continue;
    }
    // Calendar topics: the same subject is not generated twice (no API call on a repeat).
    // Scheduled keywords recur by design; only the exact checks after generation apply to them.
    const dup =
      next.source === "calendar"
        ? await findDuplicate(next.topic, next.categorySlug, {
            excludeQueueId: next.id,
            type,
          })
        : null;
    if (dup) {
      await db.contentQueueItem.update({
        where: { id: next.id },
        data: runOutcome(next, "DUPLICATE", now, { reason: `duplicate before generation: ${dup}` }),
      });
      continue;
    }
    topic = next;
  }
  if (!topic)
    return fail(
      "no new topic available: every queued topic is covered, duplicate or exhausted",
      false,
    );
  if (!manual)
    await db.automationSlot.update({
      where: { id: row.id },
      data: { queueItemId: topic.id },
    });

  // Content generation agent (Keyword-to-Blog). Topic-only: no source text is ever sent.
  const opp: Opportunity = {
    key: topic.key,
    kind: topic.kind as Opportunity["kind"],
    subject: topic.topic,
    categorySlug: topic.categorySlug,
    subcategorySlug: topic.subcategorySlug ?? undefined,
    brand: topic.brand,
    score: topic.priority,
    why: "",
  };
  const request =
    topic.source === "calendar" ? guideRequestFor(opp, type) : keywordRequest(topic, type);
  const attemptsAfter = topic.attempts + 1;
  await db.contentQueueItem.update({
    where: { id: topic.id },
    data: {
      status: "GENERATING",
      attempts: { increment: 1 },
      lastAttemptAt: now,
    },
  });
  let item: Awaited<ReturnType<typeof generateGuide>>["item"];
  try {
    const out = await generateWithRetry(request, async () => {
      await db.automationSlot.update({
        where: { id: row.id },
        data: { apiCalls: { increment: 1 } },
      });
    });
    item = out.item;
  } catch (error) {
    const message = (
      error instanceof Error ? error.message : String(error)
    ).replace(/^Keyword-to-Blog:\s*/, "");
    // The provider's daily quota is spent: the topic did nothing wrong (its attempt is not
    // counted), and further calls today would only fail, so the slot stops for today.
    const quota = /daily (api )?request limit|quota/i.test(message);
    await db.contentQueueItem.update({
      where: { id: topic.id },
      data: quota
        ? { ...runOutcome({ ...topic, attempts: attemptsAfter }, "SKIPPED", now, { reason: message }), attempts: { decrement: 1 } }
        : runOutcome({ ...topic, attempts: attemptsAfter }, "FAILED", now, { reason: message }),
    });
    // The provider failed, not the topic: back to the queue (EXHAUSTED after 3 tries).
    return fail(`Keyword-to-Blog: ${message}`, !quota);
  }

  // Duplicate agent, again: the generated post against everything that exists (exact only).
  const dupAfter =
    (topic.source === "calendar"
      ? await findDuplicate(topic.topic, topic.categorySlug, {
          title: item.title,
          excludeQueueId: topic.id,
          type,
        })
      : null) ?? (await findExactDuplicate(item, type));
  if (dupAfter) {
    await db.contentQueueItem.update({
      where: { id: topic.id },
      data: runOutcome({ ...topic, attempts: attemptsAfter }, "DUPLICATE", now, {
        reason: `generated article duplicates existing content: ${dupAfter}`,
      }),
    });
    return fail(`generated article rejected as duplicate: ${dupAfter}`, true);
  }
  // Entity + taxonomy + image + affiliate agents: the normal pipeline (unique image enforced).
  await db.contentQueueItem.update({
    where: { id: topic.id },
    data: { status: "QA" },
  });
  // Store and process this one post only: no global ingestion lock, no backlog processing.
  // The body hash and the queue key are stored with the post (exact-duplicate checks, batches).
  const toStore = {
    ...item,
    generation: {
      ...item.generation,
      bodyHash: bodyHash(item.body),
      queueKey: topic.key,
      ...(manual ? { manual: true } : { slotKey }),
    },
  };
  const stored = await ingestGeneratedPost(toStore, AI_GUIDE_SOURCE, `daily-article:${trigger}`);
  const review = stored.reviewId ? await db.normalizedReview.findUnique({ where: { id: stored.reviewId } }) : null;
  if (!review) {
    const duplicate = /duplicate/i.test(stored.reason ?? "");
    const reason = (stored.reason ?? "the generated post was not stored").slice(0, 500);
    await db.contentQueueItem.update({
      where: { id: topic.id },
      data: duplicate
        ? runOutcome({ ...topic, attempts: attemptsAfter }, "DUPLICATE", now, { reason })
        : runOutcome({ ...topic, attempts: attemptsAfter }, "FAILED", now, { reason, permanent: true }),
    });
    return fail(duplicate ? `duplicate prevented: ${stored.reason}` : `the generated post was not stored: ${stored.reason}`, true);
  }
  await db.contentQueueItem.update({
    where: { id: topic.id },
    data: { normalizedReviewId: review.id },
  });

  // Direct publish (owner's rule): a successful generation is published as it is, with no
  // content, SEO or editorial gate. Only duplicates are prevented (above). Recorded and labelled.
  await db.normalizedReview.update({
    where: { id: review.id },
    data: { editorApprovedAt: now, editorApprovedBy: AUTOMATION_APPROVER },
  });
  await audit(
    { ...SYSTEM_ACTOR, actor: AUTOMATION_APPROVER },
    {
      action: "guide.direct_publish",
      entityType: "normalized_review",
      entityId: review.id,
      metadata: { day, slot, topic: topic.key, ...(manual ? { manual: true, trigger } : {}) },
    },
  );
  let published: Awaited<ReturnType<typeof publishReview>>;
  try {
    published = await publishReview(review.id, { ...SYSTEM_ACTOR, actor: AUTOMATION_APPROVER }, "auto", { skipQa: true });
  } catch (error) {
    // Keep the stored post linked to its queue item so the next run publishes it, not regenerates.
    await db.contentQueueItem.update({ where: { id: topic.id }, data: { status: "QA", lockedAt: null, failureReason: `publish error: ${String(error).slice(0, 300)}` } });
    return fail(`publishing the stored post failed: ${String(error).slice(0, 200)}`, true);
  }
  if (!published.ok) {
    await db.contentQueueItem.update({
      where: { id: topic.id },
      data: runOutcome({ ...topic, attempts: attemptsAfter }, "FAILED", now, {
        reason: `publish: ${published.failures.map((f) => f.code).join(", ")}`,
        permanent: true,
      }),
    });
    return fail(
      `publish failed: ${published.failures.map((f) => `${f.code}: ${f.message}`).join("; ")}`,
      true,
    );
  }
  await db.contentQueueItem.update({
    where: { id: topic.id },
    data: runOutcome({ ...topic, attempts: attemptsAfter }, "PUBLISHED", now),
  });
  await slotPublished(review.id, topic.id);
  log.info("daily article published", {
    stage: "PUBLISH",
    day,
    slot,
    manual,
    topic: topic.key,
    reviewId: review.id,
  });
  return {
    status: "PUBLISHED",
    slot,
    day,
    topic: topic.topic,
    reviewSlug: review.slug,
    attempts: attemptNo,
    queueItemId: topic.id,
  };
}

/**
 * One Keyword-to-Blog call, retried once on a fast transient failure ("temporarily
 * unavailable", 429, 5xx) after a short wait. The same Idempotency-Key is reused, so a retry
 * can never bill or generate twice. Slow failures (timeouts) are not retried in-run: the next
 * scheduled run retries with backoff, within the 5-minute function limit.
 */
async function generateWithRetry(req: GuideRequest, onCall: () => Promise<void>) {
  // One call per run: a generation can take up to ~4 minutes and the function limit is 5, so a
  // second in-run call could be killed mid-flight. The next scheduled/hourly run retries.
  await onCall();
  return generateGuide(req);
}

// ─── Health ──────────────────────────────────────────────────────────────────

export type AutomationHealth = {
  ok: boolean;
  problems: string[];
  lastPublished: { day: string; slot: string; at: Date | null } | null;
  queued: number;
};

export async function automationHealth(
  now = new Date(),
): Promise<AutomationHealth> {
  const problems: string[] = [];
  if (!config.aiGuides.autoGenerate())
    problems.push(
      "GUIDE_AUTOGEN_ENABLED is not true: no articles will be published",
    );
  if (!aiGuidesConfigured()) problems.push("Keyword-to-Blog is not configured");
  if (!config.images.pexelsKey())
    problems.push(
      "PEXELS_API_KEY missing: articles still publish, but with the category placeholder image",
    );
  const [last, recent, stuck, queued, lastAttempt] = await Promise.all([
    db.automationSlot.findFirst({
      where: { status: "PUBLISHED" },
      orderBy: { publishedAt: "desc" },
    }),
    db.automationSlot.findMany({
      orderBy: [{ day: "desc" }, { slot: "desc" }],
      take: 4,
    }),
    db.contentQueueItem.count({
      where: {
        status: { in: ["LOCKED", "GENERATING", "QA"] },
        lockedAt: { lt: new Date(now.getTime() - STUCK_MS) },
      },
    }),
    db.contentQueueItem.count({ where: { status: "QUEUED" } }),
    db.automationSlot.findFirst({
      orderBy: { lastAttemptAt: "desc" },
      select: { lastAttemptAt: true },
    }),
  ]);
  if (stuck)
    problems.push(
      `${stuck} queue item(s) stuck in progress for over 30 minutes`,
    );
  if (
    recent.length >= 3 &&
    recent.slice(0, 3).every((s) => s.status === "BLOCKED")
  )
    problems.push("the last 3 slots were blocked: repeated failures");
  const { hour } = istParts(now);
  if (
    hour >= 9 &&
    (!lastAttempt?.lastAttemptAt ||
      now.getTime() - lastAttempt.lastAttemptAt.getTime() > 26 * 3_600_000)
  )
    problems.push(
      "no automation run in the last 26 hours: the scheduler may not be running",
    );
  const lastErr = recent.find(
    (s) => s.lastError && /Keyword-to-Blog/.test(s.lastError),
  );
  if (lastErr && lastErr.status !== "PUBLISHED")
    problems.push(`Keyword-to-Blog last failed: ${lastErr.lastError}`);
  return {
    ok: problems.length === 0,
    problems,
    lastPublished: last
      ? { day: last.day, slot: last.slot, at: last.publishedAt }
      : null,
    queued,
  };
}
