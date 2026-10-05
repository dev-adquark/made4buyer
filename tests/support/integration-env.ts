import { inject } from "vitest";

// Must run before any module imports lib/db (Prisma reads DATABASE_URL on first query).
process.env.DATABASE_URL = inject("databaseUrl");
process.env.DIRECT_URL = process.env.DATABASE_URL;

// The sample fixtures are a fixed, historical snapshot (September 2026). The suite treats them as
// in-window; the 7-day rule itself is covered by tests that set FRESHNESS_MAX_DAYS=7 explicitly.
process.env.FRESHNESS_MAX_DAYS ??= "36500";
