import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { checkSchema } from "@/lib/ops/schema-check";

describe("deploy gate: schema check", () => {
  it("passes when the database matches the build", async () => {
    expect(await checkSchema(db)).toEqual({ ok: true, missingTables: [], missingColumns: [], missingEnumValues: [] });
  });

  it("names a missing table, column and enum value (the 2026-10-05 incident)", async () => {
    const fake = {
      $queryRaw: (async (strings: TemplateStringsArray) => {
        const sql = strings.join("");
        const rows = (await db.$queryRawUnsafe(sql)) as Array<Record<string, string>>;
        if (sql.includes("information_schema.tables")) return rows.filter((r) => r.table_name !== "content_entities");
        if (sql.includes("information_schema.columns")) return rows.filter((r) => !(r.table_name === "image_assets" && r.column_name === "subject"));
        return rows.filter((r) => !(r.typname === "content_kind" && r.enumlabel === "COMPARISON"));
      }) as unknown as typeof db.$queryRaw,
    };
    const r = await checkSchema(fake);
    expect(r.ok).toBe(false);
    expect(r.missingTables).toEqual(["content_entities"]);
    expect(r.missingColumns).toEqual(["image_assets.subject"]);
    expect(r.missingEnumValues).toEqual(["content_kind.COMPARISON"]);
  });
});
