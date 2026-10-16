import { db } from "@/lib/db";
import { config } from "@/lib/config";
import { log } from "@/lib/log";
import { safeFetch } from "@/lib/net/safe-fetch";
import { guardedApiCall } from "@/lib/ops/api-guard";
import { refreshQueueStatus } from "./publish";
import { persistPageRenderModel, textRightsFor } from "./render-model";
import { revalidateReviewPaths } from "./revalidate-paths";

/**
 * Content rewrite: a server-side Claude API call that turns one EXCERPT-rights review's body
 * (scraped from a third-party site we may not republish verbatim) into genuinely original
 * wording — every factual claim preserved exactly, no copied phrasing — so the page can show it
 * in full as Made4Buyers' own content, with no third-party name or link (owner decision,
 * 2026-10-16). Facts aren't copyrightable; a specific author's expression of them is, so the
 * rewrite is rejected (and retried later, never stored) when it shares too much wording with the
 * source — shingleSimilarity() below is the check.
 *
 * Schedule: the content-rewrite job (vercel.json, same biweekly cadence as other paid-API jobs)
 * processes REWRITE_PER_RUN_LIMIT reviews per run, so the one-time backfill of already-published
 * EXCERPT reviews spreads across many runs instead of one costly burst, same as future ones.
 */

const STATE_KEY = "rewrite:state";
const monthOf = (d: Date) => d.toISOString().slice(0, 7);

type RewriteState = { month: string; spentUsd: number };

async function readState(now: Date): Promise<RewriteState> {
  const row = await db.automationSetting.findUnique({ where: { key: STATE_KEY } }).catch(() => null);
  let s: RewriteState = { month: monthOf(now), spentUsd: 0 };
  if (row) {
    try {
      const v = JSON.parse(row.value) as RewriteState;
      if (v && typeof v === "object" && typeof v.spentUsd === "number") s = v;
    } catch {
      /* unreadable state: counting restarts at 0 */
    }
  }
  if (s.month !== monthOf(now)) s = { month: monthOf(now), spentUsd: 0 };
  return s;
}

async function writeState(s: RewriteState): Promise<void> {
  const value = JSON.stringify(s);
  await db.automationSetting.upsert({ where: { key: STATE_KEY }, create: { key: STATE_KEY, value, updatedBy: "content-rewrite" }, update: { value, updatedBy: "content-rewrite" } });
}

/** Read-only view for Admin: this month's spend and budget. */
export async function rewriteUsage(now = new Date()): Promise<{ month: string; spentUsd: number; budgetUsd: number }> {
  const s = await readState(now);
  return { month: s.month, spentUsd: s.spentUsd, budgetUsd: config.rewrite.monthlyBudgetUsd() };
}

export function rewriteConfigured(): boolean {
  return Boolean(config.rewrite.apiKey());
}

// ── Similarity (pure) ────────────────────────────────────────────────────

/** Every lowercased, punctuation-stripped `n`-word shingle in `s`. */
function shingles(s: string, n: number): Set<string> {
  const words = s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
  const out = new Set<string>();
  for (let i = 0; i <= words.length - n; i++) out.add(words.slice(i, i + n).join(" "));
  return out;
}

/**
 * The fraction of `a`'s 5-word shingles that also appear in `b` (0 = no shared phrasing, 1 =
 * every phrase of `a` appears in `b`). A real rewrite shares almost none; a light paraphrase of
 * the same sentences shares most of them. Measured against the SHORTER text's shingle count so
 * a long rewrite that happens to contain a few of the original's phrases isn't penalized for its
 * own length.
 */
export function shingleSimilarity(a: string, b: string, n = 5): number {
  const sa = shingles(a, n);
  const sb = shingles(b, n);
  if (!sa.size || !sb.size) return 0;
  let shared = 0;
  for (const g of sa) if (sb.has(g)) shared++;
  return shared / Math.min(sa.size, sb.size);
}

// ── Claude API ───────────────────────────────────────────────────────────

export type RewriteInput = { title: string; productName: string; brand: string | null; body: string };
export type RewriteOutput = { summary: string; body: string };

function buildPrompt(input: RewriteInput): string {
  return [
    "Rewrite the following product review in completely original wording: new sentence structure and phrasing throughout. Preserve every factual claim exactly (specifications, numbers, pros, cons, verdict) — invent nothing that is not in the source. Do not reuse any run of 5 or more consecutive words from the source. Do not include the source publication's name, the source author's name, or source URLs, and do not imply that Made4Buyers authored the original review. Write in a neutral, informative tone.",
    "",
    `Product: ${input.productName}${input.brand ? ` (${input.brand})` : ""}`,
    `Title: ${input.title}`,
    "",
    "Source text:",
    input.body.slice(0, 12_000),
    "",
    'Respond with ONLY a JSON object, no other text: {"summary": "<one sentence>", "body": "<the rewritten review, plain text, paragraphs separated by a blank line>"}',
  ].join("\n");
}

type ClaudeError = { kind: "NOT_CONFIGURED" | "AUTH_FAILED" | "RATE_LIMITED" | "RESPONSE_INVALID" | "UNAVAILABLE"; message: string };

async function callClaude(prompt: string): Promise<{ ok: true; text: string } | { ok: false; error: ClaudeError }> {
  const key = config.rewrite.apiKey();
  if (!key) return { ok: false, error: { kind: "NOT_CONFIGURED", message: "ANTHROPIC_API_KEY not configured" } };
  const res = await safeFetch(`${config.rewrite.baseUrl()}/v1/messages`, {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
    body: JSON.stringify({ model: config.rewrite.model(), max_tokens: 3000, messages: [{ role: "user", content: prompt }] }),
    timeoutMs: 60_000,
    maxRedirects: 0,
    readBody: true,
    maxBytes: 2_000_000,
  });
  if (res.error) return { ok: false, error: { kind: "UNAVAILABLE", message: String(res.error.kind) } };
  if (res.status === 401 || res.status === 403) return { ok: false, error: { kind: "AUTH_FAILED", message: "Claude API rejected the key" } };
  if (res.status === 429) return { ok: false, error: { kind: "RATE_LIMITED", message: "Claude API rate limit" } };
  if (res.status !== 200) return { ok: false, error: { kind: "UNAVAILABLE", message: `HTTP ${res.status}` } };
  let json: unknown;
  try {
    json = JSON.parse(res.body ?? "");
  } catch {
    return { ok: false, error: { kind: "RESPONSE_INVALID", message: "response is not JSON" } };
  }
  const content = (json as { content?: unknown })?.content;
  const text = Array.isArray(content) ? (content[0] as { text?: unknown })?.text : undefined;
  if (typeof text !== "string" || !text.trim()) return { ok: false, error: { kind: "RESPONSE_INVALID", message: "no text content in response" } };
  return { ok: true, text };
}

/** Validates the model's reply; anything else (prose, missing fields, fenced-but-broken JSON) is null. */
export function parseRewriteResponse(text: string): RewriteOutput | null {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  let obj: unknown;
  try {
    obj = JSON.parse(cleaned);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  if (typeof o.summary !== "string" || typeof o.body !== "string" || !o.summary.trim() || !o.body.trim()) return null;
  return { summary: o.summary.trim().slice(0, 300), body: o.body.trim() };
}

// ── One review ───────────────────────────────────────────────────────────

export type RewriteResult =
  | { status: "OK"; summary: string; body: string; similarity: number; costUsd: number }
  | { status: "SKIPPED" | "TOO_SIMILAR" | "FAILED"; code: string; reason: string; similarity?: number };

/**
 * Rewrites one review's body. Never stores anything itself (the caller writes the result once
 * it also records the attempt) — this is the pure "ask Claude, validate what came back" step.
 */
export async function rewriteReviewBody(input: RewriteInput & { id: string; attempts: number }, trigger: string, now = new Date()): Promise<RewriteResult> {
  if (!rewriteConfigured()) return { status: "SKIPPED", code: "REWRITE_NOT_CONFIGURED", reason: "ANTHROPIC_API_KEY not configured" };
  const state = await readState(now);
  const budget = config.rewrite.monthlyBudgetUsd();
  if (state.spentUsd >= budget) return { status: "SKIPPED", code: "BUDGET_EXHAUSTED", reason: `$${state.spentUsd.toFixed(2)} of $${budget} spent in ${state.month}` };

  const guarded = await guardedApiCall({
    api: "rewrite",
    unit: `review:${input.id}`,
    // Changes with each attempt, so a genuine retry after a prior failure is a new unit of work,
    // while a duplicate trigger for the SAME attempt is blocked.
    idempotencyBasis: `attempt:${input.attempts}`,
    trigger,
    config: [() => (rewriteConfigured() ? null : { code: "REWRITE_NOT_CONFIGURED", reason: "ANTHROPIC_API_KEY not configured" })],
    budget: [() => (state.spentUsd >= budget ? { code: "BUDGET_EXHAUSTED", reason: `budget $${budget} reached for ${state.month}` } : null)],
    call: async () => {
      state.spentUsd += config.rewrite.runEstimateUsd();
      await writeState(state);
      return callClaude(buildPrompt(input));
    },
  });
  if (guarded.status === "SKIPPED") return { status: "SKIPPED", code: guarded.code, reason: guarded.reason };
  if (guarded.status === "INVALID_RESPONSE") return { status: "FAILED", code: "REWRITE_RESPONSE_INVALID", reason: guarded.reason };
  const res = guarded.value;
  if (!res.ok) return { status: "FAILED", code: res.error.kind, reason: res.error.message };

  const parsed = parseRewriteResponse(res.text);
  if (!parsed) return { status: "FAILED", code: "REWRITE_RESPONSE_INVALID", reason: "Claude's reply was not the documented JSON shape" };

  const similarity = shingleSimilarity(parsed.body, input.body);
  if (similarity > config.rewrite.maxSimilarityPct()) {
    log.warn("rewrite too similar to source", { stage: "CONTENT_FETCH", reviewId: input.id, similarity });
    return { status: "TOO_SIMILAR", code: "REWRITE_TOO_SIMILAR", reason: `shared ${Math.round(similarity * 100)}% of 5-word phrases with the source (max ${Math.round(config.rewrite.maxSimilarityPct() * 100)}%)`, similarity };
  }
  return { status: "OK", summary: parsed.summary, body: parsed.body, similarity, costUsd: config.rewrite.runEstimateUsd() };
}

// ── Batch job ────────────────────────────────────────────────────────────

export type ContentRewriteSummary = {
  status: string;
  reason?: string;
  candidates: number;
  processed: number;
  rewritten: number;
  tooSimilar: number;
  failed: number;
};

/**
 * content-rewrite job: every PUBLISHED review still on EXCERPT rights (scraped third-party
 * reviews never rewritten, or a prior attempt below REWRITE_MAX_ATTEMPTS), newest first, up to
 * REWRITE_PER_RUN_LIMIT per run. A successful rewrite replaces body/summary and flips
 * contentRewritten so lib/pipeline/render-model.ts shows it in full as Made4Buyers' own content.
 * A too-similar or failed rewrite counts as an attempt and is retried on a later run; budget
 * exhaustion stops the run (the same budget applies to every remaining review this month).
 */
export async function runContentRewrite(trigger: string, now = new Date()): Promise<ContentRewriteSummary> {
  if (!rewriteConfigured()) return { status: "BLOCKED_BY_ENVIRONMENT", reason: "ANTHROPIC_API_KEY not configured", candidates: 0, processed: 0, rewritten: 0, tooSimilar: 0, failed: 0 };
  const maxAttempts = config.rewrite.maxAttempts();
  const limit = config.rewrite.perRunLimit();
  const candidates = await db.normalizedReview.findMany({
    // PUBLISHED: the one-time backfill of already-published EXCERPT reviews. NEEDS_REVIEW/QUEUED:
    // freshly ingested content the publish QA gate (lib/pipeline/publish.ts CONTENT_NOT_REWRITTEN)
    // is holding back until it's rewritten. REJECTED/UNPUBLISHED are owner decisions, left alone.
    where: { status: { in: ["PUBLISHED", "NEEDS_REVIEW", "QUEUED"] }, contentRewritten: false, rewriteAttempts: { lt: maxAttempts }, kind: { not: "AI_GUIDE" } },
    select: { id: true, canonicalTitle: true, productName: true, brand: true, body: true, source: true, rewriteAttempts: true, status: true, slug: true, categorySlug: true, brandSlug: true },
    orderBy: { publishedAt: "desc" },
    take: limit * 4, // over-fetch: most will already be FULL rights (licensed/content-api) and need no rewrite
  });

  let processed = 0;
  let rewritten = 0;
  let tooSimilar = 0;
  let failed = 0;
  let stop = false;
  for (const r of candidates) {
    if (stop || processed >= limit) break;
    const rights = await textRightsFor(r.source);
    if (rights !== "EXCERPT") continue; // already full rights: nothing to rewrite
    processed++;
    const result = await rewriteReviewBody({ id: r.id, title: r.canonicalTitle, productName: r.productName, brand: r.brand, body: r.body, attempts: r.rewriteAttempts }, trigger, now);
    if (result.status === "OK") {
      await db.normalizedReview.update({ where: { id: r.id }, data: { body: result.body, summary: result.summary, contentRewritten: true, rewrittenAt: now, rewriteAttempts: { increment: 1 } } });
      if (r.status === "PUBLISHED") {
        // Already live (the backfill case): refresh its cached page and purge it now, rather than
        // waiting for the page's own next rebuild, so the rewritten body is live immediately.
        await persistPageRenderModel(r.id).catch((error: unknown) => log.warn("render model refresh after rewrite failed", { stage: "CONTENT_FETCH", reviewId: r.id, error: String(error).slice(0, 200) }));
        revalidateReviewPaths({ slug: r.slug, categorySlug: r.categorySlug, brandSlug: r.brandSlug });
      } else {
        // A freshly ingested review the publish QA gate was holding back (CONTENT_NOT_REWRITTEN)
        // can now pass QA: move it NEEDS_REVIEW → QUEUED so the next publish-cycle run picks it up.
        await refreshQueueStatus(r.id).catch((error: unknown) => log.warn("refreshQueueStatus after rewrite failed", { stage: "CONTENT_FETCH", reviewId: r.id, error: String(error).slice(0, 200) }));
      }
      rewritten++;
    } else if (result.status === "TOO_SIMILAR") {
      await db.normalizedReview.update({ where: { id: r.id }, data: { rewriteAttempts: { increment: 1 } } });
      tooSimilar++;
    } else {
      failed++;
      // A systemic failure (bad key, rate limit, Claude unreachable, budget gone) applies to every
      // remaining review too: stop the run instead of burning each one's attempt count on it.
      if (["BUDGET_EXHAUSTED", "AUTH_FAILED", "RATE_LIMITED", "UNAVAILABLE", "REWRITE_NOT_CONFIGURED"].includes(result.code)) stop = true;
      else await db.normalizedReview.update({ where: { id: r.id }, data: { rewriteAttempts: { increment: 1 } } });
    }
  }
  log.info("content rewrite run", { stage: "CONTENT_FETCH", candidates: candidates.length, processed, rewritten, tooSimilar, failed });
  return { status: "OK", candidates: candidates.length, processed, rewritten, tooSimilar, failed };
}
