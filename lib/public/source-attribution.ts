import { displayDate, displayText, displayUrl } from "@/lib/public/display";

export const MADE4BUYERS_SOURCE_NAME = "Made4Buyers";
export const MADE4BUYERS_SITE_URL = "https://made4buyers.com";

type SourceKind = "REVIEW" | "AI_GUIDE" | "COMPARISON" | "BUYING_GUIDE";

export type SourceAttributionInput = {
  kind: SourceKind;
  contentRewritten?: boolean;
  sourceName?: string | null;
  sourceKey?: string | null;
  sourceUrl?: string | null;
  author?: string | null;
  sourcePublishedAt?: Date | string | null;
  publishedAt?: Date | string | null;
  canonicalPath: string;
};

export type PublicSourceAttribution = {
  name: string | null;
  url: string | null;
  author: string | null;
  publishedAt: string | null;
  isMade4Buyers: boolean;
};

const INTERNAL_SOURCE_NAME =
  /^(?:apify(?:$|[:\s_-].*)|keyword[- ]to[- ]blog(?:$|[:\s_-].*)|content[- ]api(?:$|[:\s_-].*)|anthropic(?:$|[:\s_-].*)|claude(?: ai)?(?:$|[:\s_-].*)|openai(?:$|[:\s_-].*)|chatgpt(?:$|[:\s_-].*)|gemini(?:$|[:\s_-].*)|google ai(?:$|[:\s_-].*)|ai writing tool|made4buyers|unconfigured|invalid-url|system|internal|source)$/i;

function dateString(value: Date | string | null | undefined): string | null {
  return displayDate(value)?.toISOString() ?? null;
}

function publisherHost(value: string | null): string | null {
  if (!value) return null;
  try {
    const host = new URL(value).hostname.toLowerCase().replace(/^www\./, "");
    if (!host || host === "made4buyers.com" || host.endsWith(".made4buyers.com")) return null;
    return host;
  } catch {
    return null;
  }
}

function isSuppressedSourceUrl(value: string | null): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return (
      url.hostname.toLowerCase().replace(/^www\./, "") === "packhacker.com" &&
      url.pathname.replace(/\/+$/, "").toLowerCase() ===
        "/travel-gear/fjallraven/high-coast-pro-foldsack-26"
    );
  } catch {
    return false;
  }
}

/** Builds an absolute canonical URL on Made4Buyers, never on an origin supplied by content. */
export function made4buyersCanonicalUrl(path: string): string {
  const safePath = path.startsWith("/") && !path.startsWith("//") && !/[\r\n\\]/.test(path) ? path : "/";
  const url = new URL(safePath, `${MADE4BUYERS_SITE_URL}/`);
  return url.origin === MADE4BUYERS_SITE_URL ? url.toString() : `${MADE4BUYERS_SITE_URL}/`;
}

/**
 * Shared public attribution policy for review pages, cards, metadata and generated content.
 * Operational provider/source keys are not publisher names; use the actual source host when
 * available, otherwise omit the source rather than implying that a provider wrote the content.
 */
export function resolveSourceAttribution(input: SourceAttributionInput): PublicSourceAttribution {
  const isMade4Buyers =
    input.kind === "AI_GUIDE" ||
    input.contentRewritten === true ||
    displayText(input.sourceName)?.toLowerCase() === MADE4BUYERS_SOURCE_NAME.toLowerCase();
  if (isMade4Buyers) {
    return {
      name: MADE4BUYERS_SOURCE_NAME,
      url: made4buyersCanonicalUrl(input.canonicalPath),
      author: null,
      publishedAt: dateString(input.publishedAt),
      isMade4Buyers: true,
    };
  }

  if (isSuppressedSourceUrl(displayUrl(input.sourceUrl))) {
    return { name: null, url: null, author: null, publishedAt: null, isMade4Buyers: false };
  }

  const candidate = displayText(input.sourceName);
  const isIngestionKey = candidate && displayText(input.sourceKey)?.toLowerCase() === candidate.toLowerCase();
  const publisherName = candidate && !isIngestionKey && !INTERNAL_SOURCE_NAME.test(candidate)
    ? candidate
    : publisherHost(displayUrl(input.sourceUrl));

  return {
    name: publisherName,
    url: displayUrl(input.sourceUrl),
    author: displayText(input.author),
    publishedAt: dateString(input.sourcePublishedAt) ?? dateString(input.publishedAt),
    isMade4Buyers: false,
  };
}
