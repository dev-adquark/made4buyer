/**
 * Production admin verification (Playwright, headless Chromium).
 *
 *   ADMIN_EMAIL=... ADMIN_PASSWORD=... npx tsx scripts/verify-admin.ts [--base-url https://made4buyers.vercel.app]
 *
 * Credentials are read from the LOCAL environment only (shell or .env.local) and never printed.
 * Signs in through the real form, opens every admin page, asserts HTTP 200, no error boundary,
 * the page heading and its key content, checks the session cookie flags (HttpOnly, Secure,
 * SameSite=Strict, Path=/, __Host- prefix on https), signs out and confirms the session is gone.
 * Prints a pass/fail table only. Read-only: no admin action is submitted (except sign in/out).
 * Exit 0 = every check passed.
 */
import "./support/load-env";
import { chromium, type Page } from "@playwright/test";

export type AdminCheck = { check: string; ok: boolean; detail: string };

/** Admin pages and the heading each must show. */
export const ADMIN_PAGES: Array<{ path: string; heading: RegExp; widget?: string }> = [
  { path: "/admin", heading: /^Overview$/ },
  { path: "/admin/commerce", heading: /^Commerce engine$/ },
  { path: "/admin/commerce/sources", heading: /^Commerce sources$/ },
  { path: "/admin/commerce/products", heading: /^Commerce products$/ },
  { path: "/admin/commerce/deals", heading: /^Commerce deals$/ },
  { path: "/admin/commerce/coupons", heading: /^Commerce coupons$/ },
  { path: "/admin/commerce/runs", heading: /^Commerce runs$/ },
  { path: "/admin/sources", heading: /^Review sources$/ },
  { path: "/admin/products", heading: /^Product data$/ },
  { path: "/admin/deals", heading: /^Deals$/ },
  { path: "/admin/schedules", heading: /^Schedules$/ },
  { path: "/admin/data-audit", heading: /^Data audit$/ },
  { path: "/admin/images", heading: /^Images$/ },
  { path: "/admin/keywords", heading: /^Keywords$/ },
  { path: "/admin/jobs", heading: /^Jobs & runs$/ },
  { path: "/admin/go-live", heading: /^Go-live checks$/, widget: 'form[action="/api/admin/live-check"]' },
  { path: "/admin/integrations", heading: /^Integrations$/, widget: '[data-testid="integrations-table"] tbody tr' },
];

const CONTENT = "main.admin-main :is(table, .stats, form, .notice, .card, .table-wrap, ul, ol, p)";

async function checkPage(page: Page, base: string, spec: (typeof ADMIN_PAGES)[number]): Promise<AdminCheck> {
  const res = await page.goto(new URL(spec.path, base).toString(), { waitUntil: "load", timeout: 45_000 });
  const status = res?.status() ?? 0;
  const problems: string[] = [];
  if (status !== 200) problems.push(`HTTP ${status}`);
  if (!new URL(page.url()).pathname.startsWith(spec.path)) problems.push(`redirected to ${new URL(page.url()).pathname}`);
  if ((await page.locator(".error-panel, #__next-error, [data-nextjs-dialog]").count()) > 0 || (await page.getByText(/Application error|This page couldn’t load/).count()) > 0) problems.push("error boundary shown");
  const h1 = ((await page.locator("main h1").first().textContent({ timeout: 5_000 }).catch(() => null)) ?? "").trim();
  if (!spec.heading.test(h1)) problems.push(`heading "${h1.slice(0, 40)}"`);
  if ((await page.locator("nav.admin-nav").count()) === 0) problems.push("admin nav missing");
  if ((await page.locator(CONTENT).count()) === 0) problems.push("no page content");
  if (spec.widget && (await page.locator(spec.widget).count()) === 0) problems.push(`missing ${spec.widget}`);
  return { check: `page ${spec.path}`, ok: problems.length === 0, detail: problems.join("; ") || `200, "${h1}"` };
}

export async function verifyAdmin(opts: { baseUrl: string; email: string; password: string; pages?: typeof ADMIN_PAGES }): Promise<AdminCheck[]> {
  const base = opts.baseUrl.replace(/\/+$/, "");
  const https = base.startsWith("https://");
  const results: AdminCheck[] = [];
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    // 1. Sign in through the real form.
    await page.goto(`${base}/admin/login`, { waitUntil: "domcontentloaded" });
    await page.locator("#email").fill(opts.email);
    await page.locator("#password").fill(opts.password);
    await Promise.all([page.waitForURL((u) => !u.pathname.startsWith("/admin/login") || u.searchParams.has("error"), { timeout: 30_000 }).catch(() => undefined), page.getByRole("button", { name: "Sign in" }).click()]);
    const after = new URL(page.url());
    const signedIn = !after.pathname.startsWith("/admin/login");
    results.push({ check: "sign in", ok: signedIn, detail: signedIn ? `landed on ${after.pathname}` : `rejected (${after.searchParams.get("error") ?? "no session"})` });
    if (!signedIn) return results;

    // 2. Session cookie flags (value never read out).
    const cookies = await context.cookies(base);
    const session = cookies.find((c) => c.name === "__Host-m4b_admin" || c.name === "m4b_admin");
    if (!session) results.push({ check: "session cookie", ok: false, detail: "no admin session cookie" });
    else {
      const bad: string[] = [];
      if (!session.httpOnly) bad.push("not HttpOnly");
      if (session.sameSite !== "Strict") bad.push(`SameSite=${session.sameSite}`);
      if (session.path !== "/") bad.push(`Path=${session.path}`);
      if (https && !session.secure) bad.push("not Secure");
      if (https && session.name !== "__Host-m4b_admin") bad.push("no __Host- prefix");
      if (session.expires !== -1 && session.expires * 1000 - Date.now() > 73 * 3_600_000) bad.push("expires in more than 72 h");
      results.push({ check: "session cookie", ok: bad.length === 0, detail: bad.join("; ") || `${session.name}: HttpOnly, SameSite=Strict, Path=/${session.secure ? ", Secure" : ""}` });
    }

    // 3. Every admin page.
    for (const spec of opts.pages ?? ADMIN_PAGES) {
      results.push(await checkPage(page, base, spec).catch((e: unknown) => ({ check: `page ${spec.path}`, ok: false, detail: (e as Error).message.split("\n")[0].slice(0, 120) })));
    }

    // 4. Sign out, then the console must send us back to the sign-in page.
    await page.goto(`${base}/admin`, { waitUntil: "domcontentloaded" });
    await Promise.all([page.waitForURL((u) => u.pathname.startsWith("/admin/login") || u.pathname === "/", { timeout: 30_000 }).catch(() => undefined), page.getByRole("button", { name: "Sign out" }).click()]);
    const left = (await context.cookies(base)).some((c) => c.name === "__Host-m4b_admin" || c.name === "m4b_admin");
    await page.goto(`${base}/admin`, { waitUntil: "domcontentloaded" });
    const locked = new URL(page.url()).pathname.startsWith("/admin/login");
    results.push({ check: "sign out", ok: !left && locked, detail: !left && locked ? "cookie cleared, /admin redirects to sign-in" : `${left ? "cookie still set" : ""}${!locked ? " /admin still accessible" : ""}`.trim() });
  } finally {
    await browser.close();
  }
  return results;
}

export function formatTable(rows: AdminCheck[]): string {
  const w = Math.max(...rows.map((r) => r.check.length), 5);
  return [`${"CHECK".padEnd(w)}  RESULT  DETAIL`, ...rows.map((r) => `${r.check.padEnd(w)}  ${r.ok ? "PASS  " : "FAIL  "}  ${r.detail}`)].join("\n");
}

async function main(): Promise<number> {
  const i = process.argv.indexOf("--base-url");
  const baseUrl = (i > 0 ? process.argv[i + 1] : undefined) ?? process.env.VERIFY_ADMIN_BASE_URL ?? "https://made4buyers.vercel.app";
  const email = process.env.ADMIN_EMAIL?.trim();
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) {
    console.log("BLOCKED_BY_ENVIRONMENT: set ADMIN_EMAIL and ADMIN_PASSWORD in your local shell or .env.local (they are never printed).");
    return 2;
  }
  const rows = await verifyAdmin({ baseUrl, email, password });
  console.log(`Admin verification against ${new URL(baseUrl).origin}`);
  console.log(formatTable(rows));
  const failed = rows.filter((r) => !r.ok).length;
  console.log(`\n${rows.length - failed} passed, ${failed} failed`);
  return failed ? 1 : 0;
}

if (process.argv[1]?.endsWith("verify-admin.ts")) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error("verify-admin failed:", (error as Error).message.split("\n")[0]);
      process.exit(1);
    });
}
