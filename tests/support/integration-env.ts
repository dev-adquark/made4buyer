import { inject } from "vitest";

// Must run before any module imports lib/db (Prisma reads DATABASE_URL on first query).
process.env.DATABASE_URL = inject("databaseUrl");
process.env.DIRECT_URL = process.env.DATABASE_URL;
