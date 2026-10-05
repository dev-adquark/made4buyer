import { Prisma, type PrismaClient } from "@prisma/client";

/**
 * Compares the database with what this build's Prisma schema needs: every table, column and
 * enum value. Derived from the generated client (DMMF), so it can never drift from the code.
 * Read-only. Used before a production build goes live and by the health endpoint.
 */
export type SchemaReport = {
  ok: boolean;
  missingTables: string[];
  missingColumns: string[];
  missingEnumValues: string[];
};

export async function checkSchema(
  client: Pick<PrismaClient, "$queryRaw">,
): Promise<SchemaReport> {
  const models = Prisma.dmmf.datamodel.models;
  const enums = Prisma.dmmf.datamodel.enums;
  const [tables, columns, enumRows] = await Promise.all([
    client.$queryRaw<
      Array<{ table_name: string }>
    >`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
    client.$queryRaw<
      Array<{ table_name: string; column_name: string }>
    >`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'`,
    client.$queryRaw<
      Array<{ typname: string; enumlabel: string }>
    >`SELECT t.typname, e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public'`,
  ]);
  const haveTables = new Set(tables.map((t) => t.table_name));
  const haveColumns = new Set(
    columns.map((c) => `${c.table_name}.${c.column_name}`),
  );
  const haveEnum = new Set(enumRows.map((e) => `${e.typname}.${e.enumlabel}`));
  const missingTables: string[] = [];
  const missingColumns: string[] = [];
  for (const m of models) {
    const table = m.dbName ?? m.name;
    if (!haveTables.has(table)) {
      missingTables.push(table);
      continue;
    }
    for (const f of m.fields) {
      if (f.kind === "object") continue;
      const col = f.dbName ?? f.name;
      if (!haveColumns.has(`${table}.${col}`))
        missingColumns.push(`${table}.${col}`);
    }
  }
  const missingEnumValues: string[] = [];
  for (const e of enums) {
    const type = e.dbName ?? e.name;
    for (const v of e.values)
      if (!haveEnum.has(`${type}.${v.dbName ?? v.name}`))
        missingEnumValues.push(`${type}.${v.dbName ?? v.name}`);
  }
  return {
    ok:
      !missingTables.length &&
      !missingColumns.length &&
      !missingEnumValues.length,
    missingTables,
    missingColumns,
    missingEnumValues,
  };
}
