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

  ingest: {
    maxItemsPerRun: () => num("INGEST_MAX_ITEMS_PER_RUN", 50, 1, 1000),
    autoPublish: () => bool("AUTO_PUBLISH_ENABLED", false),
  },

  taxonomy: {
    autoAcceptThreshold: () => num("TAXONOMY_AUTO_ACCEPT_THRESHOLD", 0.8, 0, 1),
  },

  entities: {
    lowConfidenceThreshold: () => num("ENTITY_LOW_CONFIDENCE_THRESHOLD", 0.6, 0, 1),
  },

  sovrn: {
    apiUrl: () => str("SOVRN_API_URL"),
    apiKey: () => str("SOVRN_API_KEY"),
    authScheme: () => str("SOVRN_AUTH_SCHEME") ?? "secret",
    queryParam: () => str("SOVRN_QUERY_PARAM") ?? "search-keywords",
    siteKey: () => str("SOVRN_SITE_KEY"),
    linkWrapperUrl: () => str("SOVRN_LINK_WRAPPER_URL") ?? "https://redirect.viglink.com",
    timeoutMs: () => num("SOVRN_TIMEOUT_MS", 12000, 1000, 60000),
    cacheTtlMinutes: () => num("SOVRN_CACHE_TTL_MINUTES", 360, 5, 7 * 24 * 60),
    minScore: () => num("SOVRN_MIN_MATCH_SCORE", 0.55, 0, 1),
    alternates: () => num("SOVRN_ALTERNATE_OFFERS", 2, 0, 5),
    trustedMerchants: () =>
      (str("SOVRN_TRUSTED_MERCHANTS") ?? "amazon,best buy,walmart,target,newegg,b&h,adorama,apple,samsung,dell,lenovo,hp,microsoft")
        .split(",")
        .map((m) => m.trim().toLowerCase())
        .filter(Boolean),
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
    sovrn: state(Boolean(config.sovrn.apiUrl() && config.sovrn.apiKey())),
    sovrnLinkWrapper: state(Boolean(config.sovrn.siteKey())),
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
