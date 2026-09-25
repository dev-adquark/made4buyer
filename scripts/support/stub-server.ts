import http from "node:http";
import { readFileSync } from "node:fs";
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

export type StubOptions = { port?: number; sovrnKey?: string; contentKey?: string; contentOverride?: () => unknown };

export async function startStubServer(opts: StubOptions = {}) {
  const root = path.resolve(process.cwd(), "fixtures");
  const content = JSON.parse(readFileSync(path.join(root, "sample-content.json"), "utf8")) as { items: unknown[] };
  const sovrn = JSON.parse(readFileSync(path.join(root, "sample-sovrn-offers.json"), "utf8")) as { responses: Record<string, unknown[]> };
  const requests: Array<{ method: string; path: string }> = [];
  let base = "";
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
      const key = Object.keys(sovrn.responses).find((k) => k.toLowerCase() === q) ?? Object.keys(sovrn.responses).find((k) => q.includes(k.toLowerCase()) || k.toLowerCase().includes(q));
      return send(200, fill({ offers: key ? sovrn.responses[key] : [] }));
    }
    const aff = url.pathname.match(/^\/aff\/([\w-]+)$/);
    if (aff) return send(302, "", { location: `${base}/merchant/${aff[1]}`, "content-type": "text/plain" });
    const merchant = url.pathname.match(/^\/merchant\/([\w-]+)$/);
    if (merchant) return merchant[1] === "sv-ank-1" ? send(404, "not found", { "content-type": "text/html" }) : send(200, "<html><body>merchant</body></html>", { "content-type": "text/html" });
    if (url.pathname.startsWith("/image/")) return send(200, PNG, { "content-type": "image/png", "content-length": String(PNG.length) });
    return send(404, { error: "not found" });
  });

  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  base = `http://127.0.0.1:${address.port}`;
  return { base, requests, close: () => new Promise<void>((r) => server.close(() => r())) };
}
