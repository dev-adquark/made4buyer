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
} from "@/lib/pipeline/ai-guides";
import { recordFailure } from "@/lib/pipeline/failures";
import { guideRequestFor } from "@/lib/pipeline/guide-ideas";
import { runIngestion } from "@/lib/pipeline/ingest";
import { evaluateQa, publishReview } from "@/lib/pipeline/publish";
import { buildPageRenderModel } from "@/lib/pipeline/render-model";
import { audit, SYSTEM_ACTOR } from "@/lib/security/audit";
import { CATEGORY_BY_SLUG } from "@/lib/taxonomy/definitions";

/**
 * Daily article automation: one article in the MORNING slot (08:00 Asia/Kolkata) and one in the
 * EVENING slot (19:00), published without a human only after every automated gate passes:
 *
 *   Topic → Duplicate check → Entity → Keyword-to-Blog → Duplicate check (generated) →
 *   Pipeline (entities, taxonomy, unique image, offers) → Content QA → SEO QA → Publish
 *
 * Any failed gate: nothing is published, the reason is recorded, the next run moves on.
 * Runs are idempotent (one article per slot per day), serialised by a job lock, and bounded
 * by the provider's daily quota and a per-slot attempt cap.
 */

export type Slot = "MORNING" | "EVENING";
export const SLOT_HOUR_IST: Record<Slot, number> = { MORNING: 8, EVENING: 19 };
export const MAX_SLOT_ATTEMPTS = 2;
/** Minimum gap between two attempts on one slot (exponential across runs: ×2 per attempt). */
export const RETRY_BACKOFF_MS = 45 * 60_000;
const STUCK_MS = 30 * 60_000;
export const AUTOMATION_APPROVER = "automation:qa-gates";
const IST_OFFSET_MS = 5.5 * 3_600_000;

export function istParts(now: Date) {
  const t = new Date(now.getTime() + IST_OFFSET_MS);
  return {
    day: t.toISOString().slice(0, 10),
    hour: t.getUTCHours(),
    minute: t.getUTCMinutes(),
  };
}

/** The next run time (UTC) for a slot, after `now`. */
export function nextSlotRun(slot: Slot, now: Date): Date {
  const { day } = istParts(now);
  let at = new Date(
    `${day}T${String(SLOT_HOUR_IST[slot]).padStart(2, "0")}:00:00+05:30`,
  );
  if (at <= now) at = new Date(at.getTime() + 86_400_000);
  return at;
}

// ─── Duplicate & similarity agent ────────────────────────────────────────────

const STOP = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "for",
  "to",
  "of",
  "in",
  "on",
  "with",
  "your",
  "you",
  "how",
  "what",
  "best",
  "guide",
  "buying",
  "choose",
  "choosing",
  "before",
  "buy",
  "matters",
  "actually",
  "that",
  "is",
  "are",
  "vs",
  "review",
  "reviews",
  "2024",
  "2025",
  "2026",
  "2027",
]);

export function titleTokens(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .split(" ")
      .map((w) => (w.length > 4 && w.endsWith("s") ? w.slice(0, -1) : w))
      .filter((w) => w.length > 1 && !STOP.has(w)),
  );
}

export function similarity(a: string, b: string): number {
  const x = titleTokens(a);
  const y = titleTokens(b);
  if (!x.size || !y.size) return 0;
  let inter = 0;
  for (const t of x) if (y.has(t)) inter++;
  return inter / Math.min(x.size, y.size);
}

/** Threshold above which two topics are "substantially the same" (shared significant words). */
export const SIMILARITY_THRESHOLD = 0.75;

/**
 * Finds existing content (any status, including drafts and rejected) or queue work that already
 * covers this subject. Returns the reason, or null when the topic is genuinely new.
 */
export async function findDuplicate(
  subject: string,
  categorySlug: string,
  opts: { title?: string; excludeQueueId?: string } = {},
): Promise<string | null> {
  const key = subjectKey(subject);
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
      },
    }),
    db.contentQueueItem.findMany({
      where: {
        status: { in: ["LOCKED", "GENERATING", "QA", "PUBLISHED"] },
        ...(opts.excludeQueueId ? { id: { not: opts.excludeQueueId } } : {}),
      },
      select: { topic: true, status: true },
    }),
  ]);
  for (const c of content) {
    const isGuide = c.kind === "AI_GUIDE" || c.kind === "BUYING_GUIDE";
    if (isGuide && subjectKey(c.productName) === key)
      return `already covered by "${c.canonicalTitle}" (${c.status})`;
    if (opts.title && subjectKey(c.canonicalTitle) === subjectKey(opts.title))
      return `same title as "${c.canonicalTitle}" (${c.status})`;
    const s = Math.max(
      isGuide ? similarity(subject, c.productName) : 0,
      similarity(opts.title ?? subject, c.canonicalTitle),
    );
    if (isGuide && s >= SIMILARITY_THRESHOLD)
      return `overlaps "${c.canonicalTitle}" (${Math.round(s * 100)}% shared terms, ${c.status})`;
  }
  for (const q of queued)
    if (
      subjectKey(q.topic) === key ||
      similarity(subject, q.topic) >= SIMILARITY_THRESHOLD
    )
      return `already ${q.status.toLowerCase()} in the queue: "${q.topic}"`;
  return null;
}

// ─── Content & SEO quality agents ────────────────────────────────────────────

const HANDS_ON =
  /\b(we|I)\s+(tested|have tested|benchmarked|measured)\b|\bin our (tests|testing|lab|review)\b|\bour testing\b|\bhands-on (test|testing|review)\b|\bafter (weeks|months|days) of (use|testing)\b/i;
const PRICE = /(?:[$₹£€]|\bUSD|\bINR|\bRs\.?)\s?\d/;
const PERCENT = /\b\d+(?:\.\d+)?\s?%/;
const EVIDENCE =
  /\b(study|studies|survey|surveys|research|according to|statistics|data shows|experts say)\b/i;

/** A sentence that cites a percentage as evidence ("a 2023 study found 73%…"): unverifiable here. */
function statisticClaim(body: string): string | undefined {
  return body
    .split(/(?<=[.!?])\s+|\n+/)
    .find((sentence) => PERCENT.test(sentence) && EVIDENCE.test(sentence));
}

/** Text-level gates: substance, structure, and no claims the article cannot support. */
export function contentQualityIssues(
  item: {
    title: string;
    summary?: string;
    body: string;
    generation?: { qualityStatus?: string | null };
  },
  keyword: string,
): string[] {
  const issues: string[] = [];
  const words = item.body.split(/\s+/).filter(Boolean).length;
  if (words < 500)
    issues.push(`too short for a useful guide (${words} words, need 500+)`);
  if (item.title.length < 15 || item.title.length > 110)
    issues.push(`title length ${item.title.length} (need 15–110)`);
  if (!item.summary || item.summary.length < 50)
    issues.push("meta description missing or under 50 characters");
  if ((item.body.match(/^## /gm) ?? []).length < 3)
    issues.push("fewer than 3 section headings");
  if (HANDS_ON.test(item.body))
    issues.push(
      "claims hands-on testing, which an AI-assisted guide cannot have done",
    );
  if (PRICE.test(item.body))
    issues.push("states a price; prices may only come from verified offers");
  const stat = statisticClaim(item.body);
  if (stat)
    issues.push(`unsupported statistic: "${stat.trim().slice(0, 100)}"`);
  const q = item.generation?.qualityStatus;
  if (q && q !== "pass") issues.push(`generator quality check: ${q}`);
  const kw = titleTokens(keyword);
  const covered = titleTokens(
    `${item.title} ${(item.body.match(/^## .*$/gm) ?? []).join(" ")}`,
  );
  if ([...kw].filter((t) => covered.has(t)).length < Math.min(1, kw.size))
    issues.push(`keyword "${keyword}" not reflected in the title or headings`);
  return issues;
}

/** Page-level gates on the built page: metadata, category, image, schema-relevant fields. */
export async function seoIssues(
  reviewId: string,
  expectedCategory: string,
): Promise<string[]> {
  const issues: string[] = [];
  const m = await buildPageRenderModel(reviewId);
  if (m.metaDescription.length < 50)
    issues.push("meta description under 50 characters");
  if (!m.category) issues.push("no category assigned");
  else if (m.category.slug !== expectedCategory)
    issues.push(`filed under ${m.category.slug}, expected ${expectedCategory}`);
  if (m.image.isFallback)
    issues.push("no unique real image (would show the placeholder)");
  if (m.rating)
    issues.push("carries a rating, which an AI-assisted guide must not");
  if (m.kind !== "AI_GUIDE")
    issues.push(`kind is ${m.kind}, expected AI_GUIDE`);
  const img = await db.imageAsset.findFirst({
    where: { normalizedReviewId: reviewId, isPrimary: true },
    select: { providerPhotoId: true },
  });
  if (img?.providerPhotoId) {
    const shared = await db.imageAsset.count({
      where: {
        isPrimary: true,
        providerPhotoId: img.providerPhotoId,
        normalizedReviewId: { not: reviewId },
      },
    });
    if (shared)
      issues.push(
        `image ${img.providerPhotoId} is already another article's image`,
      );
  }
  return issues;
}

// ─── Topic agent ─────────────────────────────────────────────────────────────

/** Adds new calendar opportunities to the persistent queue (existing keys are left alone). */
export async function refreshQueue(now = new Date()) {
  const opps = await contentOpportunities({ now, limit: 100 });
  const rows = opps.map((o: Opportunity) => {
    const req = guideRequestFor(o);
    return {
      key: o.key,
      topic: o.subject,
      keyword: req.keywords[0],
      kind: o.kind,
      categorySlug: o.categorySlug,
      subcategorySlug: o.subcategorySlug ?? null,
      productName: o.kind === "PRODUCT_GUIDE" ? o.subject : null,
      brand: o.brand ?? null,
      priority: o.score,
    };
  });
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
      status: { in: ["LOCKED", "GENERATING", "QA"] },
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
 * Highest-priority queued topic, balanced: categories published by automation in the last 7
 * days are penalised, and the last two automated articles' categories are skipped.
 */
export async function pickNextTopic(
  now = new Date(),
): Promise<ContentQueueItem | null> {
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
    where: { status: "QUEUED", attempts: { lt: 3 } },
    orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
    take: 200,
  });
  const ranked = queued
    .filter((q) => CATEGORY_BY_SLUG.has(q.categorySlug))
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
};

function dueSlot(
  now: Date,
  slots: Array<{ slot: string; status: string }>,
): Slot | null {
  const { hour } = istParts(now);
  for (const s of ["MORNING", "EVENING"] as Slot[]) {
    if (hour < SLOT_HOUR_IST[s]) continue;
    const row = slots.find((r) => r.slot === s);
    if (!row || !["PUBLISHED", "BLOCKED"].includes(row.status)) return s;
  }
  return null;
}

export async function runDailyArticle(
  trigger: string,
  opts: { now?: Date; slot?: Slot } = {},
): Promise<DailyArticleResult> {
  const now = opts.now ?? new Date();
  if (!config.aiGuides.autoGenerate())
    return { status: "DISABLED", reason: "GUIDE_AUTOGEN_ENABLED is not true" };
  if (!aiGuidesConfigured())
    return {
      status: "BLOCKED_BY_ENVIRONMENT",
      reason: "Keyword-to-Blog is not configured",
    };
  const { day } = istParts(now);
  const todays = await db.automationSlot.findMany({ where: { day } });
  const slot = opts.slot ?? dueSlot(now, todays);
  if (!slot)
    return {
      status: "NOT_DUE",
      day,
      reason: `next run ${nextSlotRun("MORNING", now) < nextSlotRun("EVENING", now) ? "MORNING" : "EVENING"} at ${[nextSlotRun("MORNING", now), nextSlotRun("EVENING", now)].sort((a, b) => a.getTime() - b.getTime())[0].toISOString()}`,
    };

  // Concurrent first runs of the day may both try to create the slot row: the loser reads it.
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
  if (row.status === "PUBLISHED")
    return {
      status: "SKIPPED",
      slot,
      day,
      reason: "this slot already published an article today",
    };
  if (row.status === "BLOCKED")
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
  if (row.attempts >= MAX_SLOT_ATTEMPTS) {
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
    slot === "MORNING" &&
    !todays.some((s) => s.slot === "EVENING" && s.status === "PUBLISHED");
  const budget = config.aiGuides.dailyLimit() - used - (eveningPending ? 1 : 0);
  if (budget <= 0) {
    await db.automationSlot.update({
      where: { id: row.id },
      data: {
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
  const attemptNo = row.attempts + 1;
  // Atomic claim of the slot: a second concurrent runner finds it RUNNING and stops.
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
  const fail = async (reason: string, retry: boolean) => {
    await db.automationSlot.update({
      where: { id: row.id },
      data: {
        status: retry && attemptNo < MAX_SLOT_ATTEMPTS ? "RETRYING" : "BLOCKED",
        lastError: reason.slice(0, 500),
      },
    });
    await recordFailure({
      stage: "PUBLISH",
      code: "DAILY_ARTICLE_NOT_PUBLISHED",
      message: `daily article ${day} ${slot}: ${reason}`,
      entityType: "job",
      entityId: `daily-article:${day}:${slot}`,
      retryable: false,
    });
    log.warn("daily article not published", {
      stage: "PUBLISH",
      day,
      slot,
      reason,
    });
    return {
      status:
        retry && attemptNo < MAX_SLOT_ATTEMPTS
          ? ("RETRYING" as const)
          : ("BLOCKED" as const),
      slot,
      day,
      reason,
      attempts: attemptNo,
    };
  };

  // Topic agent + duplicate agent: free checks first, so no API call is spent on a duplicate.
  let topic: ContentQueueItem | null = null;
  for (let i = 0; i < 25; i++) {
    const next = await pickNextTopic(now);
    if (!next) break;
    if (!(await claim(next.id, now))) continue;
    const dup = await findDuplicate(next.topic, next.categorySlug, {
      excludeQueueId: next.id,
    });
    if (dup) {
      await db.contentQueueItem.update({
        where: { id: next.id },
        data: {
          status: "REJECTED",
          failureReason: `duplicate before generation: ${dup}`,
          lockedAt: null,
        },
      });
      continue;
    }
    topic = next;
    break;
  }
  if (!topic)
    return fail(
      "no new topic available: every queued topic is covered, duplicate or exhausted",
      false,
    );
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
    const out = await generateWithRetry(guideRequestFor(opp), async () => {
      await db.automationSlot.update({
        where: { id: row.id },
        data: { apiCalls: { increment: 1 } },
      });
    });
    item = out.item;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // The provider failed, not the topic: back to the queue (EXHAUSTED after 3 tries).
    const exhausted = topic.attempts + 1 >= 3;
    await db.contentQueueItem.update({
      where: { id: topic.id },
      data: {
        status: exhausted ? "EXHAUSTED" : "QUEUED",
        lockedAt: null,
        failureReason: message.slice(0, 500),
      },
    });
    return fail(`Keyword-to-Blog: ${message}`, true);
  }

  // Duplicate agent, again: the generated title against everything that exists.
  const dupAfter = await findDuplicate(topic.topic, topic.categorySlug, {
    title: item.title,
    excludeQueueId: topic.id,
  });
  if (dupAfter) {
    await db.contentQueueItem.update({
      where: { id: topic.id },
      data: {
        status: "REJECTED",
        lockedAt: null,
        failureReason: `generated article duplicates existing content: ${dupAfter}`,
      },
    });
    return fail(`generated article rejected as duplicate: ${dupAfter}`, true);
  }
  // Content quality agent (text-level), before anything is stored.
  const textIssues = contentQualityIssues(item, topic.keyword);
  if (textIssues.length) {
    await db.contentQueueItem.update({
      where: { id: topic.id },
      data: {
        status: "REJECTED",
        lockedAt: null,
        failureReason: `content QA: ${textIssues.join("; ")}`.slice(0, 500),
      },
    });
    return fail(`content QA failed: ${textIssues.join("; ")}`, true);
  }

  // Entity + taxonomy + image + affiliate agents: the normal pipeline (unique image enforced).
  await db.contentQueueItem.update({
    where: { id: topic.id },
    data: { status: "QA" },
  });
  await runIngestion({
    trigger: `daily-article:${trigger}`,
    items: [item],
    source: AI_GUIDE_SOURCE,
  });
  const review = await db.normalizedReview.findUnique({
    where: { source_sourceId: { source: AI_GUIDE_SOURCE, sourceId: item.id } },
  });
  if (!review) {
    await db.contentQueueItem.update({
      where: { id: topic.id },
      data: {
        status: "FAILED",
        lockedAt: null,
        failureReason:
          "ingestion did not store the article (see Ingestion → failures)",
      },
    });
    return fail("ingestion did not store the generated article", true);
  }
  await db.contentQueueItem.update({
    where: { id: topic.id },
    data: { normalizedReviewId: review.id },
  });

  // SEO & quality agent on the built page, then the standard QA gate.
  const seo = await seoIssues(review.id, topic.categorySlug);
  if (seo.length) {
    await db.contentQueueItem.update({
      where: { id: topic.id },
      data: {
        status: "REJECTED",
        lockedAt: null,
        failureReason: `SEO QA: ${seo.join("; ")}`.slice(0, 500),
      },
    });
    return fail(
      `SEO QA failed (kept in QA for an editor, not published): ${seo.join("; ")}`,
      true,
    );
  }
  // Publishing agent: the automated gates stand in for the editor, and say so (audited).
  await db.normalizedReview.update({
    where: { id: review.id },
    data: { editorApprovedAt: now, editorApprovedBy: AUTOMATION_APPROVER },
  });
  const qa = await evaluateQa(review.id);
  if (qa.length) {
    await db.normalizedReview.update({
      where: { id: review.id },
      data: { editorApprovedAt: null, editorApprovedBy: null },
    });
    await db.contentQueueItem.update({
      where: { id: topic.id },
      data: {
        status: "REJECTED",
        lockedAt: null,
        failureReason: `publish QA: ${qa.map((q) => q.code).join(", ")}`,
      },
    });
    return fail(
      `publish QA failed (kept in QA for an editor): ${qa.map((q) => `${q.code}: ${q.message}`).join("; ")}`,
      true,
    );
  }
  await audit(
    { ...SYSTEM_ACTOR, actor: AUTOMATION_APPROVER },
    {
      action: "guide.auto_approve",
      entityType: "normalized_review",
      entityId: review.id,
      metadata: { day, slot, topic: topic.key },
    },
  );
  const published = await publishReview(
    review.id,
    { ...SYSTEM_ACTOR, actor: AUTOMATION_APPROVER },
    "auto",
  );
  if (!published.ok) {
    await db.contentQueueItem.update({
      where: { id: topic.id },
      data: {
        status: "FAILED",
        lockedAt: null,
        failureReason: `publish: ${published.failures.map((f) => f.code).join(", ")}`,
      },
    });
    return fail(
      `publish failed: ${published.failures.map((f) => `${f.code}: ${f.message}`).join("; ")}`,
      true,
    );
  }
  await db.contentQueueItem.update({
    where: { id: topic.id },
    data: {
      status: "PUBLISHED",
      lockedAt: null,
      publishedAt: now,
      failureReason: null,
    },
  });
  await db.automationSlot.update({
    where: { id: row.id },
    data: {
      status: "PUBLISHED",
      normalizedReviewId: review.id,
      publishedAt: now,
      lastError: null,
    },
  });
  log.info("daily article published", {
    stage: "PUBLISH",
    day,
    slot,
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
  };
}

/**
 * One Keyword-to-Blog call, retried once on a fast transient failure ("temporarily
 * unavailable", 429, 5xx) after a short wait. The same Idempotency-Key is reused, so a retry
 * can never bill or generate twice. Slow failures (timeouts) are not retried in-run: the next
 * scheduled run retries with backoff, within the 5-minute function limit.
 */
async function generateWithRetry(
  req: ReturnType<typeof guideRequestFor>,
  onCall: () => Promise<void>,
) {
  const started = Date.now();
  for (let attempt = 1; ; attempt++) {
    await onCall();
    try {
      return await generateGuide(req);
    } catch (error) {
      const retryable =
        (error as { retryable?: boolean }).retryable === true ||
        /temporarily unavailable|try again/i.test(
          String((error as Error).message),
        );
      if (attempt >= 2 || !retryable || Date.now() - started > 60_000)
        throw error;
      await new Promise((r) =>
        setTimeout(r, Number(process.env.KTB_RETRY_DELAY_MS ?? 20_000)),
      );
    }
  }
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
      "PEXELS_API_KEY missing: articles cannot get a unique image, so none will publish",
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
