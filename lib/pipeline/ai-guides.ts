import crypto from "node:crypto";
import { config } from "@/lib/config";
import { PipelineError } from "@/lib/errors";
import { log } from "@/lib/log";
import { safeFetch } from "@/lib/net/safe-fetch";
import { cleanText, sha256, stableStringify } from "@/lib/util/text";

/**
 * AI-assisted buying guides via the Keyword-to-Blog API (POST /v1/generate).
 *
 * The API writes a new article with an AI model; it is NOT a source of reviews. Generated
 * posts therefore enter the pipeline as kind AI_GUIDE: they are labelled as AI-assisted,
 * never given Review schema or ratings, never carry prices (deals still come only from
 * verified Sovrn offers), and are published automatically, exactly as returned.
 */

export const AI_GUIDE_SOURCE = "keyword-to-blog";

export type GuideRequest = { productName: string; brand?: string; category?: string; keywords: string[]; topic?: string; audience?: string; industry?: string; articleType?: "GUIDE" | "ARTICLE" };

type Section = { type?: string; heading?: string; contentMarkdown?: string; callout?: { label?: string; text?: string } };
type KtbResponse = {
  requestId?: string;
  post?: { title?: string; meta?: { description?: string; primaryKeyword?: string }; sections?: Section[]; faqs?: Array<{ question?: string; answer?: string }>; conclusion?: string };
  debug?: { generationModel?: string };
  quality?: { status?: string; score?: number; revisionCount?: number; qualityVersion?: string };
};

export function aiGuidesConfigured(): boolean {
  return Boolean(config.aiGuides.url() && config.aiGuides.keys().length);
}

/**
 * Markdown → the plain-text paragraph format the review body uses ("## " marks a heading).
 * Only markup is removed; every word the provider wrote is kept (code blocks become plain text,
 * and underscores inside words such as snake_case are left alone).
 */
export function markdownToPlain(md: string): string {
  return md
    .replace(/```[^\n]*\n?([\s\S]*?)```/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(^|[^\w*])\*(?!\s)([^*\n]+?)\*(?!\w)/g, "$1$2")
    .replace(/(^|[^\w_])_(?!\s)([^_\n]+?)_(?!\w)/g, "$1$2")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^#{1,6}[ \t]*/gm, "")
    .replace(/^[ \t]*[-*+][ \t]+/gm, "• ")
    .split(/\n{2,}/)
    .map((p) => p.split("\n").map((l) => l.trim()).filter(Boolean).join("\n"))
    .filter(Boolean)
    .join("\n\n");
}

/** Maps a Keyword-to-Blog response onto the Content API item shape consumed by validation. */
export function guideToContentItem(res: KtbResponse, req: GuideRequest, now = new Date()) {
  const post = res.post;
  // Everything the provider returned is kept: headings, sections (including intro/conclusion and
  // FAQ sections), the conclusion field and FAQs. Refused only when there is no title or no text.
  const parts: string[] = [];
  for (const s of post?.sections ?? []) {
    // An empty FAQ section is just the slot for post.faqs (rendered below); no double heading.
    if (s.type === "faq" && !s.contentMarkdown?.trim() && post?.faqs?.length) continue;
    if (s.heading?.trim()) parts.push(`## ${cleanText(s.heading)}`);
    if (s.contentMarkdown?.trim()) parts.push(markdownToPlain(s.contentMarkdown));
    if (s.callout?.text) parts.push(`${s.callout.label ? `${cleanText(s.callout.label)}: ` : ""}${markdownToPlain(s.callout.text)}`);
  }
  if (post?.conclusion?.trim()) parts.push(markdownToPlain(post.conclusion));
  const faqs = (post?.faqs ?? []).filter((f) => f.question && f.answer);
  if (faqs.length) {
    parts.push("## Frequently asked questions");
    for (const f of faqs) parts.push(`${cleanText(f.question!)}\n${markdownToPlain(f.answer!)}`);
  }
  if (!post?.title?.trim() || !parts.join("").trim()) throw new PipelineError("CONTENT_API_RESPONSE_INVALID", "Keyword-to-Blog returned no title or no text");
  return {
    id: `ktb:${res.requestId ?? now.getTime()}`,
    title: post.title,
    summary: post.meta?.description,
    body: parts.join("\n\n"),
    productName: req.productName,
    brand: req.brand,
    category: req.category,
    tags: req.keywords,
    publishedAt: now.toISOString(),
    publisher: "Made4Buyers (AI-assisted)",
    contentKind: "AI_GUIDE",
    generation: {
      provider: AI_GUIDE_SOURCE,
      requestId: res.requestId ?? null,
      model: res.debug?.generationModel ?? null,
      qualityStatus: res.quality?.status ?? null,
      qualityScore: res.quality?.score ?? null,
      keywords: req.keywords,
      articleType: req.articleType ?? "GUIDE",
      generatedAt: now.toISOString(),
    },
  };
}

/**
 * Deterministic UUID for the Idempotency-Key header: same request body on the same UTC day →
 * same key, so resubmitting (e.g. after a timeout) returns the original generation instead of
 * generating and billing again.
 */
export function idempotencyKeyFor(body: unknown, day = new Date().toISOString().slice(0, 10)): string {
  const h = sha256(`${day}|${stableStringify(body)}`);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h[16], 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export async function generateGuide(req: GuideRequest) {
  const url = config.aiGuides.url();
  const keys = config.aiGuides.keys();
  if (!url || !keys.length) throw new PipelineError("CONTENT_API_NOT_CONFIGURED", "KEYWORD_TO_BLOG_API_URL / KEYWORD_TO_BLOG_API_KEY are not configured");
  const endpoint = /\/v1\/generate\/?$/.test(url) ? url : `${url.replace(/\/+$/, "")}/v1/generate`;
  const topic = req.topic?.trim() || `A practical buying guide to the ${[req.brand, req.productName].filter(Boolean).join(" ")}`;
  // Request shape verified against the live API on 2026-10-05. The extended shape (several
  // keywords, audience/voice/industry, section/FAQ constraints, "verified" factuality) made every
  // generation hit the provider's ~135 s internal limit and fail with INTERNAL_ERROR "temporarily
  // unavailable"; this shape returned quality "pass" (95) in 44–84 s on three keys.
  const body = {
    keywords: req.keywords.slice(0, 1),
    // The headline only: a subtitle after ":" lengthens generation without adding substance.
    topic: topic.split(":")[0].trim(),
    language: "en",
    tone: "professional", // API enum: "professional" | "friendly" | "bold"
    constraints: { minWords: 600, maxWords: Math.min(900, config.aiGuides.maxWords()) },
    format: { responseTypes: ["json"] },
    factualityMode: "standard",
  };
  const idempotencyKey = idempotencyKeyFor(body);
  // Primary key, then the fallback key when the primary is refused (auth, quota, rate limit,
  // provider error). A timeout is not failed over: the provider may still be generating, and a
  // second key would start (and bill) a second generation.
  let res: Awaited<ReturnType<typeof safeFetch>> | undefined;
  for (const [i, key] of keys.entries()) {
    res = await safeFetch(endpoint, {
      method: "POST",
      // Idempotency-Key: a retried request can never generate (or bill) twice.
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json", "Idempotency-Key": idempotencyKey, "X-Request-ID": crypto.randomUUID() },
      body: JSON.stringify(body),
      timeoutMs: config.aiGuides.timeoutMs(),
      maxRedirects: 0,
      readBody: true,
      maxBytes: 5_000_000,
    });
    const failover = !res.ok && res.error?.kind !== "TIMEOUT" && (res.status === 401 || res.status === 403 || res.status === 429 || res.status >= 500 || /limit|quota|unavailable/i.test(res.body ?? ""));
    if (res.ok || !failover || i === keys.length - 1) break;
    log.warn("Keyword-to-Blog key refused; trying the fallback key", { stage: "CONTENT_FETCH", status: res.status, key: i === 0 ? "primary" : "secondary" });
  }
  if (!res) throw new PipelineError("CONTENT_API_NOT_CONFIGURED", "No Keyword-to-Blog key configured");
  if (!res.ok) {
    let detail = res.error?.message ?? `HTTP ${res.status}`;
    try {
      const j = JSON.parse(res.body ?? "") as { error?: { code?: string; message?: string } | string; message?: string };
      detail = typeof j.error === "string" ? j.error : j.error?.message ?? j.message ?? detail;
    } catch {
      /* non-JSON error body */
    }
    log.warn("guide generation failed", { stage: "CONTENT_FETCH", status: res.status, detail });
    const timedOut = res.error?.kind === "TIMEOUT";
    throw new PipelineError(
      timedOut ? "CONTENT_API_TIMEOUT" : "CONTENT_API_HTTP_ERROR",
      timedOut ? "Keyword-to-Blog is still generating. Submit the same request again: it returns the finished guide without generating (or billing) twice." : `Keyword-to-Blog: ${detail}`,
      { status: res.status },
      res.status === 429 || res.status >= 500,
    );
  }
  let json: KtbResponse;
  try {
    json = JSON.parse(res.body ?? "") as KtbResponse;
  } catch {
    throw new PipelineError("CONTENT_API_RESPONSE_INVALID", "Keyword-to-Blog returned invalid JSON");
  }
  return { response: json, item: guideToContentItem(json, req) };
}
