import http from "node:http";
import type { AddressInfo } from "node:net";

export type StubRequest = { method: string; path: string; query: URLSearchParams; headers: http.IncomingHttpHeaders; body: string };
export type StubReply = { status?: number; body?: unknown; headers?: Record<string, string> };

/** A throwaway loopback HTTP server for contract tests: every request is recorded and answered by `handler`. */
export async function miniStub(handler: (req: StubRequest) => StubReply | Promise<StubReply>) {
  const requests: StubRequest[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      const url = new URL(req.url ?? "/", "http://stub");
      const r: StubRequest = { method: req.method ?? "GET", path: url.pathname, query: url.searchParams, headers: req.headers, body };
      requests.push(r);
      const reply = await handler(r);
      const payload = reply.body === undefined ? "" : typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body);
      res.writeHead(reply.status ?? 200, { "content-type": "application/json", ...(reply.headers ?? {}) });
      res.end(payload);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, requests, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}
