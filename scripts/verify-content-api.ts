/**
 * Content API contract check: fetches ONE page with the configured credentials, validates it
 * against docs/CONTENT_API_CONTRACT.md and prints counts only (no item content, no key).
 *
 *   CONTENT_API_URL=... CONTENT_API_KEY=... npx tsx scripts/verify-content-api.ts
 *
 * Env: CONTENT_API_URL (required), CONTENT_API_KEY, CONTENT_API_AUTH_HEADER (default
 * Authorization), CONTENT_API_AUTH_SCHEME (default Bearer), CONTENT_API_SCHEMA_VERSION (default 1).
 * Exit 0 = OK/EMPTY, 2 = not configured, 1 = any failure.
 */
import "./support/load-env";
import { probeContentApi } from "@/lib/pipeline/content-source";

export async function main(): Promise<number> {
  const r = await probeContentApi();
  const line = (k: string, v: unknown) => console.log(`${k.padEnd(22)} ${v}`);
  line("status", r.status);
  if (r.status === "BLOCKED_BY_ENVIRONMENT") {
    line("missing env", r.missing.join(", "));
    return 2;
  }
  if (r.status === "OK" || r.status === "EMPTY") {
    line("http status", r.httpStatus);
    line("items on page 1", r.items);
    line("valid", r.valid);
    line("invalid", r.invalid);
    for (const [code, n] of Object.entries(r.invalidByCode)) line(`  ${code}`, n);
    line("declared version", r.declaredVersion ?? "(none declared)");
    line("supported version", r.expectedVersion);
    line("next page link", r.hasNextPage ? "yes (same origin)" : "no");
    return 0;
  }
  if ("reason" in r) {
    if (r.httpStatus) line("http status", r.httpStatus);
    line("reason", r.reason);
  }
  return 1;
}

if (process.argv[1]?.endsWith("verify-content-api.ts")) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error("verify-content-api failed:", (error as Error).message);
      process.exit(1);
    });
}
