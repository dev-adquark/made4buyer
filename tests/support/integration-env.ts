import { inject } from "vitest";

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
