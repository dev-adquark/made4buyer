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
 * verified Sovrn offers), and cannot be published until an editor approves them.
 */

export const AI_GUIDE_SOURCE = "keyword-to-blog";

export type GuideRequest = { productName: string; brand?: string; category?: string; keywords: string[]; topic?: string; audience?: string };

type Section = { type?: string; heading?: string; contentMarkdown?: string; callout?: { label?: string; text?: string } };
type KtbResponse = {
  requestId?: string;
  post?: { title?: string; meta?: { description?: string; primaryKeyword?: string }; sections?: Section[]; faqs?: Array<{ question?: string; answer?: string }>; conclusion?: string };
  debug?: { generationModel?: string };
  quality?: { status?: string; score?: number; revisionCount?: number; qualityVersion?: string };
};

export function aiGuidesConfigured(): boolean {
  return Boolean(config.aiGuides.url() && config.aiGuides.key());
}

/** Markdown → the plain-text paragraph format the review body uses ("## " marks a heading). */
export function markdownToPlain(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\{\{[^}]*\}\}|\[\[[^\]]*\]\]/g, "")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(\*|_)(.*?)\1/g, "$2")
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
  if (!post?.title || !post.sections?.length) throw new PipelineError("CONTENT_API_RESPONSE_INVALID", "Keyword-to-Blog response has no post title or sections");
  const parts: string[] = [];
  for (const s of post.sections) {
    if (s.type === "faq") continue; // rendered from post.faqs below
    if (s.heading && s.type !== "introduction" && s.type !== "conclusion") parts.push(`## ${cleanText(s.heading)}`);
    if (s.contentMarkdown?.trim()) parts.push(markdownToPlain(s.contentMarkdown));
    if (s.callout?.text) parts.push(`${s.callout.label ? `${cleanText(s.callout.label)}: ` : ""}${markdownToPlain(s.callout.text)}`);
  }
  const faqs = (post.faqs ?? []).filter((f) => f.question && f.answer);
  if (faqs.length) {
    parts.push("## Frequently asked questions");
    for (const f of faqs) parts.push(`${cleanText(f.question!)}\n${markdownToPlain(f.answer!)}`);
  }
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
  const key = config.aiGuides.key();
  if (!url || !key) throw new PipelineError("CONTENT_API_NOT_CONFIGURED", "KEYWORD_TO_BLOG_API_URL / KEYWORD_TO_BLOG_API_KEY are not configured");
  const endpoint = /\/v1\/generate\/?$/.test(url) ? url : `${url.replace(/\/+$/, "")}/v1/generate`;
  const topic = req.topic?.trim() || `A practical buying guide to the ${[req.brand, req.productName].filter(Boolean).join(" ")}`;
  const body = {
    keywords: req.keywords,
    topic,
    language: "en",
    region: "US",
    tone: "professional", // API enum: "professional" | "friendly" | "bold"
    targetAudience: req.audience?.trim() || "technology buyers comparing options before they purchase",
    brandVoice: "clear, practical, honest about trade-offs; no invented specifications, prices or test results",
    industry: "consumer technology",
    // maxWords stays under the smallest plan's 1,500 words/request cap.
    constraints: { minWords: 600, maxWords: config.aiGuides.maxWords(), maxSections: 7, includeFAQs: true, includeInternalLinksPlaceholders: false, keywordUsageStrategy: "natural" },
    format: { responseTypes: ["json"] },
    // Source-grounded factuality checks: prefer omission over unverifiable claims.
    factualityMode: "verified",
  };
  const idempotencyKey = idempotencyKeyFor(body);
  const res = await safeFetch(endpoint, {
    method: "POST",
    // Idempotency-Key: a retried request can never generate (or bill) twice.
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json", "Idempotency-Key": idempotencyKey, "X-Request-ID": crypto.randomUUID() },
    body: JSON.stringify(body),
    timeoutMs: config.aiGuides.timeoutMs(),
    maxRedirects: 0,
    readBody: true,
    maxBytes: 5_000_000,
  });
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
