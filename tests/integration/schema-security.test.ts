import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";

describe("database security", () => {
  it("has Row Level Security enabled on every public table (Supabase API roles are denied)", async () => {
    const rows = await db.$queryRaw<Array<{ tablename: string }>>`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND NOT rowsecurity`;
    expect(rows.map((r) => r.tablename)).toEqual([]);
  });
});
