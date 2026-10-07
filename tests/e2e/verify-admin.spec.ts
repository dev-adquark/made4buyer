import { expect, test } from "@playwright/test";
import { ADMIN_PAGES, formatTable, verifyAdmin } from "../../scripts/verify-admin";

/**
 * Exercises scripts/verify-admin.ts (the production admin check) against the local E2E server
 * with the E2E-only admin credentials from tests/e2e/launch.ts.
 */
test("verify-admin passes every check against the E2E server", async ({ baseURL }) => {
  test.setTimeout(240_000);
  const rows = await verifyAdmin({ baseUrl: baseURL!, email: "admin@e2e.test", password: "e2e-password-123456" });
  const table = formatTable(rows);
  expect(rows.filter((r) => !r.ok), table).toEqual([]);
  // sign in + cookie + every page + sign out
  expect(rows).toHaveLength(ADMIN_PAGES.length + 3);
  expect(table).not.toContain("e2e-password-123456");
});

test("verify-admin reports a rejected sign-in without leaking the password", async ({ baseURL }) => {
  const rows = await verifyAdmin({ baseUrl: baseURL!, email: "admin@e2e.test", password: "definitely-wrong-password" });
  expect(rows).toEqual([{ check: "sign in", ok: false, detail: expect.stringMatching(/^rejected/) }]);
  expect(formatTable(rows)).not.toContain("definitely-wrong-password");
});
