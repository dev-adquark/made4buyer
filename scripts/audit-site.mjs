// Opt-in live site audit (CI job runs only when AUDIT_BASE_URL is set).
// Checks: homepage, a category page, a review page, search, admin login, sitemap, robots,
// health endpoint, then every sitemap URL and same-origin links found on crawled HTML pages.
const base = process.env.AUDIT_BASE_URL;
if (!base) {
  console.log("AUDIT_BASE_URL not set — live audit skipped.");
  process.exit(0);
}
const origin = new URL(base);
if (!["http:", "https:"].includes(origin.protocol)) throw new Error("AUDIT_BASE_URL must use http or https");
const timeoutMs = Number(process.env.AUDIT_TIMEOUT_MS || 15000);
const maxUrls = Number(process.env.AUDIT_MAX_URLS || 300);

async function request(url, method = "GET") {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { method, redirect: "manual", signal: controller.signal, headers: { accept: "text/html,application/xml,application/json,text/plain,*/*", "user-agent": "Made4BuyersSiteAudit/1.0" } });
  } finally {
    clearTimeout(timer);
  }
}
function internal(raw) {
  try {
    const u = new URL(raw, origin);
    if (u.origin !== origin.origin) return null;
    u.hash = "";
    return u.href;
  } catch {
    return null;
  }
}
async function check(url, expect = (s) => s >= 200 && s < 400) {
  try {
    const res = await request(url);
    const type = res.headers.get("content-type") || "";
    const body = /text\/html|xml|json|text\/plain/.test(type) ? await res.text() : "";
    return { url, status: res.status, ok: expect(res.status), type, body };
  } catch (e) {
    return { url, status: 0, ok: false, error: String(e?.message || e), type: "", body: "" };
  }
}

const results = new Map();
const record = (r) => results.set(r.url, { url: r.url, status: r.status, ok: r.ok, ...(r.error ? { error: r.error } : {}), ...(r.note ? { note: r.note } : {}) });

// Core routes.
const core = ["/", "/search?q=laptop", "/admin/login", "/robots.txt", "/sitemap.xml"];
const pages = [];
for (const p of core) {
  const r = await check(new URL(p, origin).href);
  record(r);
  pages.push(r);
}
const health = await check(new URL("/api/health", origin).href, (s) => s === 200);
try {
  const h = JSON.parse(health.body || "{}");
  if (h.database !== "ok") health.ok = false;
  health.note = `database: ${h.database}`;
} catch {
  health.ok = false;
}
record(health);
const robots = pages.find((p) => p.url.endsWith("/robots.txt"));
if (robots && !/sitemap:/i.test(robots.body)) record({ ...robots, ok: false, note: "robots.txt has no Sitemap line" });

// Sitemap URLs (must include at least one category and one review page once content is published).
const sitemap = pages.find((p) => p.url.endsWith("/sitemap.xml"));
const locs = [...(sitemap?.body || "").matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)].map((m) => m[1].trim()).slice(0, maxUrls);
const category = locs.find((u) => u.includes("/category/"));
const review = locs.find((u) => u.includes("/review/"));
if (!category) console.warn("warning: sitemap lists no category page (no published content yet?)");
if (!review) console.warn("warning: sitemap lists no review page (no published content yet?)");
for (const loc of locs) {
  const u = internal(loc);
  if (!u) {
    record({ url: loc, status: 0, ok: false, error: "sitemap URL not on audit origin" });
    continue;
  }
  if (!results.has(u)) {
    const r = await check(u, (s) => s === 200);
    record(r);
    pages.push(r);
  }
}

// Same-origin links on crawled HTML pages.
for (const page of pages.filter((p) => /text\/html/.test(p.type)).slice(0, 60)) {
  for (const m of page.body.matchAll(/href\s*=\s*["']([^"'#]+)["']/gi)) {
    const u = internal(m[1]);
    if (!u || results.has(u) || results.size >= maxUrls || u.includes("/go/")) continue;
    record(await check(u));
  }
}

const broken = [...results.values()].filter((r) => !r.ok);
console.log(JSON.stringify({ base: origin.href, checked: results.size, sitemapUrls: locs.length, categoryPage: category ?? null, reviewPage: review ?? null, broken: broken.length, errors: broken }, null, 2));
if (broken.length) process.exit(1);
