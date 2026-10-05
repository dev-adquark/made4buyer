import http from "node:http";
import { readFileSync } from "node:fs";
import { ALL_TOPIC_QUERIES } from "../../lib/pipeline/image-topics";
import path from "node:path";

/**
 * LOCAL/TEST stub for the Content API, Sovrn and merchant endpoints, serving the SAMPLE
 * fixtures in /fixtures. It exists so the full pipeline can run on a laptop and in CI
 * without credentials. It is never used by the production code path.
 *
 *   GET /content                    → fixtures/sample-content.json (Bearer auth optional)
 *   GET /sovrn?search-keywords=…    → sample offers (requires "Authorization: secret <key>")
 *   GET|HEAD /aff/:id               → 302 → /merchant/:id   (affiliate redirect)
 *   GET|HEAD /merchant/:id          → 200 (sv-ank-1 → 404 to exercise UNAVAILABLE)
 *   GET|HEAD /image/:name           → 1×1 PNG
 */

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=", "base64");

export type StubOptions = { port?: number; sovrnKey?: string; contentKey?: string; contentOverride?: () => unknown; apifyToken?: string };

export async function startStubServer(opts: StubOptions = {}) {
  const root = path.resolve(process.cwd(), "fixtures");
  const content = JSON.parse(readFileSync(path.join(root, "sample-content.json"), "utf8")) as { items: unknown[] };
  const sovrn = JSON.parse(readFileSync(path.join(root, "sample-sovrn-offers.json"), "utf8")) as { responses: Record<string, unknown[]> };
  const apifyItems = JSON.parse(readFileSync(path.join(root, "sample-apify-items.json"), "utf8")) as { items: unknown[] };
  const apifyRuns = new Map<string, { input: unknown; polls: number }>();
  const requests: Array<{ method: string; path: string }> = [];
  let base = "";
  const pexels = { broken: false, rateLimited: false };
  // Keyword-to-Blog stub controls: `unavailable` = number of next requests to fail with the
  // provider's "temporarily unavailable" error; `handsOn` = article claims hands-on testing.
  const ktb = { unavailable: 0, handsOn: false, delayMs: 0, requests: 0, quotaReached: false, rejectPrimary: false, keysUsed: [] as string[], tinyPost: false, fixedTitle: "" };
  const fill = (v: unknown) => JSON.parse(JSON.stringify(v).split("{BASE}").join(base));

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://stub");
    requests.push({ method: req.method ?? "GET", path: url.pathname + url.search });
    const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      const payload = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(req.method === "HEAD" ? undefined : payload);
    };
    if (url.pathname === "/content") {
      if (opts.contentKey && req.headers.authorization !== `Bearer ${opts.contentKey}`) return send(401, { error: "unauthorized" });
      return send(200, fill(opts.contentOverride?.() ?? { items: content.items }));
    }
    if (url.pathname === "/sovrn") {
      if (req.headers.authorization !== `secret ${opts.sovrnKey ?? "test-sovrn-key"}`) return send(401, { error: "unauthorized" });
      const q = (url.searchParams.get("search-keywords") ?? "").toLowerCase();
      if (q.includes("ratelimit")) return send(429, { error: "Too many requests" });
      const key = Object.keys(sovrn.responses).find((k) => k.toLowerCase() === q) ?? Object.keys(sovrn.responses).find((k) => q.includes(k.toLowerCase()) || k.toLowerCase().includes(q));
      return send(200, fill({ offers: key ? sovrn.responses[key] : [] }));
    }
    // Apify API (v2) — just enough of it for the scrape/collect jobs: runs, run status, dataset items.
    if (url.pathname.startsWith("/apify/v2/")) {
      if (req.headers.authorization !== `Bearer ${opts.apifyToken ?? "test-apify-token"}`) return send(401, { error: { type: "user-or-token-not-found", message: "Authentication token was not valid" } });
      const p = url.pathname.slice("/apify/v2".length);
      if (p === "/users/me") return send(200, { data: { username: "stub-user", plan: { id: "FREE" } } });
      if (/^\/acts\/[^/]+\/builds\/default$/.test(p)) {
        const properties = Object.fromEntries(["startUrls", "linkSelector", "globs", "maxCrawlingDepth", "maxPagesPerCrawl", "maxConcurrency", "respectRobotsTxtFile", "injectJQuery", "proxyConfiguration", "pageFunction", "customData"].map((k) => [k, {}]));
        return send(200, { data: { inputSchema: JSON.stringify({ properties }) } });
      }
      if (/^\/acts\/[^/]+\/runs$/.test(p) && req.method === "POST" && url.searchParams.get("memory") === "999") {
        return send(403, { error: { type: "full-permission-actor-not-approved", message: "This Actor requires full access to your account.", data: { approvalUrl: "https://console.apify.com/actors/stub?approvePermissions=true" } } });
      }
      if (/^\/acts\/[^/]+\/runs$/.test(p) && req.method === "POST") {
        let raw = "";
        req.on("data", (c) => (raw += c));
        req.on("end", () => {
          const id = `run-${apifyRuns.size + 1}`;
          apifyRuns.set(id, { input: JSON.parse(raw || "{}"), polls: 0 });
          send(201, { data: { id, status: "RUNNING", defaultDatasetId: `ds-${id}` } });
        });
        return;
      }
      const run = p.match(/^\/actor-runs\/([^/]+)$/);
      if (run) {
        const r = apifyRuns.get(run[1]);
        if (!r) return send(404, { error: { type: "record-not-found" } });
        r.polls++;
        return send(200, { data: { id: run[1], status: "SUCCEEDED", defaultDatasetId: `ds-${run[1]}`, finishedAt: new Date().toISOString() } });
      }
      if (/^\/datasets\/[^/]+\/items$/.test(p)) return send(200, apifyItems.items);
      return send(404, { error: { type: "page-not-found" } });
    }
    if (url.pathname === "/ktb/v1/generate" && req.method === "POST") {
      const auth = req.headers.authorization ?? "";
      if (auth !== "Bearer test-ktb-key" && auth !== "Bearer test-ktb-key-2") return send(401, { error: { code: "unauthorized", message: "Invalid API key" } });
      ktb.keysUsed.push(auth === "Bearer test-ktb-key" ? "primary" : "secondary");
      if (ktb.rejectPrimary && auth === "Bearer test-ktb-key") return send(429, { error: { code: "RATE_LIMITED", message: "Daily API request limit reached." } });
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const body = JSON.parse(raw || "{}") as { keywords?: string[]; topic?: string; tone?: string; factualityMode?: string; constraints?: { maxWords?: number } };
        // Mirror the real API's validation of enums and plan caps.
        ktb.requests++;
        if (ktb.quotaReached) return send(429, { error: { code: "RATE_LIMITED", message: "Daily API request limit reached." } });
        if (ktb.unavailable > 0) {
          ktb.unavailable--;
          return send(503, { error: { code: "SERVICE_UNAVAILABLE", message: "Content generation is temporarily unavailable. Please try again shortly." } });
        }
        if (!["professional", "friendly", "bold"].includes(body.tone ?? "") || (body.factualityMode && !["standard", "verified"].includes(body.factualityMode)) || (body.constraints?.maxWords ?? 0) > 1500 || !req.headers["idempotency-key"]) {
          return send(400, { error: { code: "VALIDATION_ERROR", message: "Invalid request body." } });
        }
        if (ktb.tinyPost)
          return send(200, { requestId: `req_tiny_${ktb.requests}`, post: { title: "Tiny", sections: [{ type: "body", heading: "", contentMarkdown: "One short sentence." }] }, quality: { status: "fail", score: 12 } });
        // Daily-article topics ("How to choose …") get a full-length SAMPLE article.
        if (/^(How to choose|What to know before buying) /.test(body.topic ?? "")) {
          const article = /^What to know/.test(body.topic ?? "");
          const subject = (body.topic ?? "").replace(/^(How to choose|What to know before buying) /, "").replace(/:.*$/, "");
          const para = (angle: string) =>
            `When you compare ${subject}, ${angle} matters more than the headline features. Think about how often you will use it, where it will live, and who else in the household will rely on it. ` +
            `Read the manufacturer's specifications carefully, check what is included in the box, and look at how easy replacement parts are to find. A model that suits a small apartment can be the wrong choice for a large family home, and the reverse is also true. ` +
            `Write down the two or three things you cannot compromise on before you look at any shortlist, and judge every option against that list rather than against marketing claims.`;
          const sections = ["Size and space", "Everyday use", "Maintenance and running costs", "Build quality and warranty", "Who should choose what"].map((h, i) => ({ type: "body", heading: h, contentMarkdown: `${para(h.toLowerCase())}${ktb.handsOn && i === 1 ? " We tested each model for three weeks in our lab." : ""}` }));
          const send200 = () =>
            send(200, {
              requestId: `req_daily_${subject.replace(/\W+/g, "_")}_${ktb.requests}`,
              post: {
                title: ktb.fixedTitle || (article ? `What to know before buying ${subject}` : `How to choose ${subject}: a practical buying guide`),
                meta: { description: `What actually matters when choosing ${subject}: size, everyday use, upkeep and warranty, explained without hype.` },
                sections: [{ type: "introduction", contentMarkdown: para("the way you plan to use it") }, ...sections, { type: "conclusion", contentMarkdown: para("a short list of priorities") }],
                faqs: [{ question: `What should I check first when choosing ${subject}?`, answer: "Start with the space you have and how often you will use it, then compare the options that fit." }],
              },
              debug: { generationModel: "stub-model" },
              quality: { status: "pass", score: 90 },
            });
          if (ktb.delayMs) setTimeout(send200, ktb.delayMs);
          else send200();
          return;
        }
        send(200, {
          requestId: `req_stub_${(body.keywords ?? []).join("_").replace(/\W+/g, "").slice(0, 20)}`,
          post: {
            title: `Buying guide: ${body.topic ?? "gear"}`,
            meta: { description: "A practical, sample buying guide generated by the local stub for tests only." },
            sections: [
              { type: "introduction", contentMarkdown: "This **sample** guide explains what to look for before you buy, written by the local test stub." },
              { type: "body", heading: "Who it suits", contentMarkdown: "Students and travellers who want a light laptop with long battery life and a quiet design for everyday work." },
              { type: "body", heading: "What to check", contentMarkdown: "- Battery life\n- Port selection\n- Display brightness for working outdoors and in bright offices." },
              { type: "faq", heading: "Frequently asked questions", contentMarkdown: "" },
              { type: "conclusion", contentMarkdown: "Decide on the features you need first, then compare verified offers." },
            ],
            faqs: [{ question: "Is it good for students?", answer: "It suits most coursework and note taking." }],
          },
          debug: { generationModel: "stub-model" },
          quality: { status: "pass", score: 88 },
        });
      });
      return;
    }
    const aff = url.pathname.match(/^\/aff\/([\w-]+)$/);
    if (aff) return send(302, "", { location: `${base}/merchant/${aff[1]}`, "content-type": "text/plain" });
    const merchant = url.pathname.match(/^\/merchant\/([\w-]+)$/);
    if (merchant) return merchant[1] === "sv-ank-1" ? send(404, "not found", { "content-type": "text/html" }) : send(200, "<html><body>merchant</body></html>", { "content-type": "text/html" });
    if (url.pathname.startsWith("/image/")) return send(200, PNG, { "content-type": "image/png", "content-length": String(PNG.length) });
    // Pexels API stub (SAMPLE data). Product queries return generic desk photos (no product
    // named), except "sony", so tests exercise both the PRODUCT and ILLUSTRATIVE paths.
    if (url.pathname === "/pexels/v1/search") {
      if (req.headers.authorization !== "test-pexels-key") return send(401, { error: "Unauthorized" });
      const q = (url.searchParams.get("query") ?? "").toLowerCase();
      const rl = { "x-ratelimit-limit": "200", "x-ratelimit-remaining": "150", "x-ratelimit-reset": "1900000000" };
      if (q.includes("ratelimit") || pexels.rateLimited) return send(429, { error: "Too many requests" }, { ...rl, "x-ratelimit-remaining": "0" });
      if (q.includes("malformed")) return send(200, { unexpected: true }, rl);
      if (q.includes("nothing")) return send(200, { photos: [] }, rl);
      let seed = 0;
      for (const c of q) seed = (seed * 31 + c.charCodeAt(0)) % 100000;
      const photo = (i: number, alt: string, extra: Record<string, unknown> = {}) => ({
        id: seed * 10 + i,
        url: `https://www.pexels.com/photo/stub-${seed * 10 + i}/`,
        alt,
        photographer: `Stub Photographer ${i}`,
        photographer_url: `https://www.pexels.com/@stub-${i}`,
        width: 4000,
        height: 2667,
        src: { large: `${base}/pexels-img/${seed * 10 + i}.jpeg`, large2x: `${base}/pexels-img/${seed * 10 + i}.jpeg`, landscape: `${base}/pexels-img/${q.includes("broken") || pexels.broken ? "broken" : seed * 10 + i}.jpeg` },
        ...extra,
      });
      const topical = ALL_TOPIC_QUERIES.includes(q);
      const photos = q.includes("sony")
        ? [photo(1, "Sony WH-1000XM6 headphones on a wooden table")]
        : [
            photo(1, "A person working at a desk with a coffee"),
            photo(2, `Stock photo: ${q}`, { src: { large: "http://evil.example/x.jpg", large2x: "http://evil.example/x.jpg", landscape: "http://evil.example/x.jpg" } }),
            photo(3, `Stock photo: ${q}`, { width: 640, height: 427 }),
            ...(topical ? [photo(4, `Stock photo: ${q}`), photo(5, `Another stock photo: ${q}`)] : [photo(4, "Hands on a laptop keyboard")]),
          ];
      return send(200, { page: 1, per_page: photos.length, photos }, rl);
    }
    if (url.pathname.startsWith("/pexels-img/")) {
      if (url.pathname.includes("broken")) return send(404, "<html>gone</html>", { "content-type": "text/html" });
      return send(200, PNG, { "content-type": "image/jpeg", "content-length": String(PNG.length) });
    }
    return send(404, { error: "not found" });
  });

  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  base = `http://127.0.0.1:${address.port}`;
  return { base, requests, pexels, ktb, close: () => new Promise<void>((r) => server.close(() => r())) };
}
