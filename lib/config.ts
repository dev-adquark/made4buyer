/**
 * Central environment configuration. Every external integration reports an explicit
 * status so the UI, reports and health endpoint can say BLOCKED_BY_ENVIRONMENT instead
 * of pretending an integration works.
 */

export const BLOCKED_BY_ENVIRONMENT = "BLOCKED_BY_ENVIRONMENT" as const;
export const NOT_AVAILABLE_IN_ENVIRONMENT = "NOT_AVAILABLE_IN_ENVIRONMENT" as const;
export const INSUFFICIENT_DATA = "INSUFFICIENT_DATA" as const;

function str(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : undefined;
}

function num(name: string, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const raw = str(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function bool(name: string, fallback: boolean): boolean {
  const raw = str(name);
  if (raw === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

export const config = {
  siteUrl: () => (str("NEXT_PUBLIC_SITE_URL") ?? "http://localhost:3000").replace(/\/+$/, ""),
  isProduction: () => process.env.NODE_ENV === "production",

  contentApi: {
    url: () => str("CONTENT_API_URL"),
    key: () => str("CONTENT_API_KEY"),
    authHeader: () => str("CONTENT_API_AUTH_HEADER") ?? "Authorization",
    authScheme: () => str("CONTENT_API_AUTH_SCHEME") ?? "Bearer",
    sourceName: () => str("CONTENT_API_SOURCE_NAME"),
    timeoutMs: () => num("CONTENT_API_TIMEOUT_MS", 15000, 1000, 60000),
    maxRetries: () => num("CONTENT_API_MAX_RETRIES", 3, 0, 6),
    maxPages: () => num("CONTENT_API_MAX_PAGES", 5, 1, 50),
    imagesLicensed: () => bool("CONTENT_API_IMAGES_LICENSED", false),
  },

  aiGuides: {
    url: () => str("KEYWORD_TO_BLOG_API_URL"),
    key: () => str("KEYWORD_TO_BLOG_API_KEY"),
    /** Primary key first, then the fallback key (used when the primary returns an error). */
    keys: () => [...new Set([str("KEYWORD_TO_BLOG_API_KEY"), str("KEYWORD_TO_BLOG_API_KEY_SECONDARY")].filter((k): k is string => Boolean(k)))],
    timeoutMs: () => num("KEYWORD_TO_BLOG_TIMEOUT_MS", 270000, 5000, 280000),
    maxWords: () => num("KEYWORD_TO_BLOG_MAX_WORDS", 1200, 300, 4000),
    /** Draft original guides for newly reviewed products (never auto-approved). Off by default. */
    autoGenerate: () => bool("GUIDE_AUTOGEN_ENABLED", false),
    /** Keyword-to-Blog requests per day the auto job may use (plan quota). */
    dailyLimit: () => num("KEYWORD_TO_BLOG_DAILY_LIMIT", 3, 0, 500),
  },

  ingest: {
    maxItemsPerRun: () => num("INGEST_MAX_ITEMS_PER_RUN", 50, 1, 1000),
    autoPublish: () => bool("AUTO_PUBLISH_ENABLED", true),
  },

  freshness: {
    /** A published review whose source article is older than this is flagged in Admin (information only). */
    reviewMonths: () => num("STALE_REVIEW_MONTHS", 18, 1, 120),
    /** A published AI-assisted guide older than this is flagged for a refresh. */
    guideMonths: () => num("STALE_GUIDE_MONTHS", 12, 1, 120),
  },

  taxonomy: {
    autoAcceptThreshold: () => num("TAXONOMY_AUTO_ACCEPT_THRESHOLD", 0.8, 0, 1),
  },

  entities: {
    lowConfidenceThreshold: () => num("ENTITY_LOW_CONFIDENCE_THRESHOLD", 0.6, 0, 1),
  },

  /** Commerce engine data shown publicly (prices, offers). */
  commerce: {
    /** A stored price is shown only while its observation is at most this many hours old. */
    priceMaxAgeHours: () => num("PRODUCT_PRICE_MAX_AGE_HOURS", 48, 1, 24 * 30),
  },

  /**
   * Affiliate provider(s) for retailer links (lib/affiliate/provider.ts): none (default; links stay
   * plain), amazon, skimlinks, impact, or a comma list tried in order.
   */
  affiliate: {
    provider: () => (str("AFFILIATE_PROVIDER") ?? "none").toLowerCase(),
  },

  links: {
    timeoutMs: () => num("LINK_VERIFY_TIMEOUT_MS", 8000, 1000, 30000),
    maxRedirects: () => num("LINK_VERIFY_MAX_REDIRECTS", 8, 1, 15),
    intervalHours: () => num("LINK_VERIFY_INTERVAL_HOURS", 24, 1, 24 * 14),
    batchSize: () => num("LINK_VERIFY_BATCH_SIZE", 100, 1, 1000),
  },

  images: {
    enrichmentUrl: () => str("IMAGE_ENRICHMENT_URL"),
    enrichmentKey: () => str("IMAGE_ENRICHMENT_API_KEY"),
    pexelsKey: () => str("PEXELS_API_KEY"),
    /** Overridable only so tests can point at a local stub. */
    pexelsBaseUrl: () => (str("PEXELS_API_BASE_URL") ?? "https://api.pexels.com/v1").replace(/\/+$/, ""),
    cdnTemplate: () => str("IMAGE_CDN_URL_TEMPLATE"),
    requireLicense: () => bool("IMAGE_REQUIRE_LICENSE", true),
    timeoutMs: () => num("IMAGE_TIMEOUT_MS", 10000, 1000, 30000),
  },

  admin: {
    email: () => str("ADMIN_EMAIL"),
    password: () => str("ADMIN_PASSWORD"),
    sessionSecret: () => str("ADMIN_SESSION_SECRET"),
    sessionHours: () => num("ADMIN_SESSION_HOURS", 8, 1, 72),
  },

  cronSecret: () => str("CRON_SECRET"),

  gsc: {
    siteUrl: () => str("GSC_SITE_URL"),
    serviceAccountJson: () => str("GSC_SERVICE_ACCOUNT_JSON"),
    inspectionsPerRun: () => num("GSC_INSPECTIONS_PER_RUN", 50, 1, 500),
  },

  analytics: {
    externalId: () => str("NEXT_PUBLIC_ANALYTICS_ID"),
    minImpressionsForCtr: () => num("ANALYTICS_MIN_IMPRESSIONS", 100, 1, 1_000_000),
  },

  sponsored: {
    enabled: () => bool("FEATURE_SPONSORED_PLACEMENTS", false),
  },

  csv: {
    maxBytes: () => num("CSV_MAX_BYTES", 1_000_000, 1024, 10_000_000),
    maxRows: () => num("CSV_MAX_ROWS", 5000, 1, 50_000),
  },

  /** Apify Web Scraper: the source of genuine editorial reviews (server-side token only). */
  apify: {
    token: () => str("APIFY_API_TOKEN"),
    actorId: () => str("APIFY_ACTOR_ID") ?? "apify/web-scraper",
    /** Overridable only so tests can point at a local stub. */
    baseUrl: () => (str("APIFY_API_BASE_URL") ?? "https://api.apify.com/v2").replace(/\/+$/, ""),
    runTimeoutSecs: () => num("APIFY_RUN_TIMEOUT_SECS", 1800, 60, 7200),
    memoryMb: () => num("APIFY_MEMORY_MB", 2048, 256, 8192),
    maxItemsPerCollect: () => num("APIFY_MAX_ITEMS_PER_COLLECT", 100, 1, 1000),
  },

  /**
   * Feedico coupon feed (lib/commerce/feedico.ts): server-side Bearer key only. Weekly sync of every
   * brand; the Free plan allows 1,000 requests/month and the sync stops at FEEDICO_MONTHLY_REQUEST_BUDGET (600).
   */
  feedico: {
    apiKey: () => str("FEEDICO_API_KEY"),
    /** Overridable only so tests can point at a local stub. */
    baseUrl: () => (str("FEEDICO_API_BASE_URL") ?? "https://api.feedico.io").replace(/\/+$/, ""),
    monthlyRequestBudget: () => num("FEEDICO_MONTHLY_REQUEST_BUDGET", 600, 1, 1_000_000),
    /** A brand fetched successfully within this many hours is not fetched again (a re-run of the weekly sync is a no-op). */
    minRefetchHours: () => num("FEEDICO_MIN_REFETCH_HOURS", 12, 1, 144),
    brandsPerRun: () => num("FEEDICO_BRANDS_PER_RUN", 200, 1, 500),
    maxPagesPerBrand: () => num("FEEDICO_MAX_PAGES_PER_BRAND", 2, 1, 5),
    /** Freshness: a code Feedico has not confirmed (fetchedAt) within this many days is rejected and deactivated. At most 14. */
    maxFeedAgeDays: () => num("FEEDICO_MAX_FEED_AGE_DAYS", 14, 1, 14),
  },

  /** Test-only escape hatch so integration/E2E suites can verify links against loopback stubs. */
  allowLoopbackForTests: () =>
    bool("UNSAFE_ALLOW_LOOPBACK_FOR_TESTS", false) && process.env.VERCEL_ENV !== "production",
};

export type IntegrationState = "READY" | typeof BLOCKED_BY_ENVIRONMENT;

export function integrationStatus() {
  const state = (ok: boolean): IntegrationState => (ok ? "READY" : BLOCKED_BY_ENVIRONMENT);
  return {
    database: state(Boolean(str("DATABASE_URL"))),
    contentApi: state(Boolean(config.contentApi.url())),
    apify: state(Boolean(config.apify.token())),
    feedico: state(Boolean(config.feedico.apiKey())),
    aiGuides: state(Boolean(config.aiGuides.url() && config.aiGuides.key())),
    imageProvider: state(Boolean(config.images.enrichmentUrl() || config.images.pexelsKey())),
    imageCdn: state(Boolean(config.images.cdnTemplate())),
    gsc: state(Boolean(config.gsc.siteUrl() && config.gsc.serviceAccountJson())),
    admin: state(Boolean(config.admin.email() && config.admin.password() && config.admin.sessionSecret())),
    cron: state(Boolean(config.cronSecret())),
    externalAnalytics: state(Boolean(config.analytics.externalId())),
  };
}

export function releaseInfo() {
  return {
    version: process.env.npm_package_version ?? "1.0.0",
    commit: str("VERCEL_GIT_COMMIT_SHA") ?? str("GIT_COMMIT_SHA") ?? null,
    environment: str("VERCEL_ENV") ?? process.env.NODE_ENV ?? "development",
  };
}
