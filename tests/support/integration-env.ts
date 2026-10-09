import { beforeEach, inject } from "vitest";

// Must run before any module imports lib/db (Prisma reads DATABASE_URL on first query).
process.env.DATABASE_URL = inject("databaseUrl");
process.env.DIRECT_URL = process.env.DATABASE_URL;

// The sample fixtures are a fixed, historical snapshot (September 2026). The suite treats them as
// in-window; the 7-day rule itself is covered by tests that set FRESHNESS_MAX_DAYS=7 explicitly.
process.env.FRESHNESS_MAX_DAYS ??= "36500";

// No real Wikidata/Commons calls from the suite; the Wikidata test points these at the stub.
process.env.WIKIDATA_ENABLED ??= "false";

// No live Commons file search from the suite; tests that need it point COMMONS_API_URL at the stub.
process.env.COMMONS_SEARCH_ENABLED ??= "false";

// Hero-image rule changes are dated in production; the suite never depends on the wall clock.
process.env.IMAGE_RULES_CHANGED_AT ??= "2000-01-01T00:00:00Z";

// Paid-API guard state is per process: start every test without a recorded Pexels rate limit or a
// cached schema verdict (lib/ops/api-guard.ts, lib/pipeline/pexels.ts). Imported lazily: lib/db must
// not load before DATABASE_URL is set above.
beforeEach(async () => {
  (await import("@/lib/ops/api-guard")).resetApiGuardCache();
  (await import("@/lib/pipeline/pexels")).resetPexelsBlock();
});
