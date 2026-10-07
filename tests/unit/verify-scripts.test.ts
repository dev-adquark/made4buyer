import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { main as verifyApify } from "../../scripts/verify-apify-token";
import { formatTable } from "../../scripts/verify-admin";
import { scanBuildOutput, scanProduction, scanText, scanWorkingTree } from "../../scripts/verify-no-secrets";
import { withEnv } from "../support/env";
import { miniStub } from "../support/mini-stub";

// Fake secret-shaped strings are assembled at runtime so this file itself never matches the scanner.
const fake = {
  apify: ["apify", "api", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4"].join("_"),
  sovrn: "e9f9" + "0123456789abcdef0123456789abcdef",
  vercel: "vcp" + "_" + "AbCdEfGhIjKlMnOpQrStUvWx",
  sk: "sk" + "-proj-" + "abcdefghijklmnopqrstuvwxyz123456",
  jwt: ["eyJ" + "hbGciOiJIUzI1NiJ9xx", "eyJ" + "zdWIiOiIxMjM0NTY3ODkwIn0", "dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"].join("."),
  pg: "postgres" + "://admin:" + "S3cr3tLongPassw0rd" + "@db.prod.example.com:5432/app",
};

describe("verify-no-secrets", () => {
  it("finds every known secret shape and reports only location + pattern", () => {
    const text = Object.values(fake).join("\nfiller line\n");
    const found = scanText(text, "file.ts");
    expect(found.map((f) => f.pattern).sort()).toEqual(["API secret key (sk-…)", "Apify API token (apify_api_…)", "JWT", "Postgres URL with password", "Sovrn key (prefix e9f9)", "Vercel token (vcp_…)"].sort());
    expect(found[0]).toEqual({ location: "file.ts", line: 1, pattern: "Apify API token (apify_api_…)" });
    for (const f of found) for (const v of Object.values(fake)) expect(JSON.stringify(f)).not.toContain(v.slice(4, 16));
  });

  it("ignores local/test databases, placeholders and lookalikes", () => {
    const ok = ["postgres" + "://postgres:postgres@localhost:5432/x", "postgresql" + "://u:[YOUR-PASSWORD]@host/db", "c668" + "short", "task-list-item-1234567890abcdefghij", "desk-" + "x".repeat(30)].join("\n");
    expect(scanText(ok, "x")).toEqual([]);
  });

  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "m4b-scan-"));
    writeFileSync(path.join(dir, "ok.ts"), "export const a = 1;\n");
    writeFileSync(path.join(dir, "leak.ts"), `// note\nconst t = "${fake.apify}";\n`);
    writeFileSync(path.join(dir, ".env.local"), `APIFY_API_TOKEN=${fake.apify}\n`);
    mkdirSync(path.join(dir, "node_modules"));
    writeFileSync(path.join(dir, "node_modules", "dep.js"), fake.sk);
    mkdirSync(path.join(dir, ".next", "static", "chunks"), { recursive: true });
    writeFileSync(path.join(dir, ".next", "static", "chunks", "main.js"), `var x="${fake.vercel}"`);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("scans the working tree (skipping dependencies, build output and local .env files) and .next output", () => {
    expect(scanWorkingTree(dir)).toEqual([{ location: "leak.ts", line: 2, pattern: "Apify API token (apify_api_…)" }]);
    expect(scanBuildOutput(dir)).toEqual([{ location: path.join(".next", "static", "chunks", "main.js"), line: 1, pattern: "Vercel token (vcp_…)" }]);
  });

  it("scans production HTML and its same-origin /_next/static scripts", async () => {
    const stub = await miniStub((r) =>
      r.path === "/"
        ? { body: '<html><script src="/_next/static/chunks/a.js"></script><script src="https://cdn.other.example/x.js"></script></html>', headers: { "content-type": "text/html" } }
        : r.path === "/_next/static/chunks/a.js"
          ? { body: `console.log("${fake.jwt}")`, headers: { "content-type": "application/javascript" } }
          : { status: 404 },
    );
    const r = await scanProduction(stub.base, ["/"]);
    await stub.close();
    expect(r.fetched).toBe(2);
    expect(r.findings).toEqual([{ location: `${stub.base}/_next/static/chunks/a.js`, line: 1, pattern: "JWT" }]);
  });
});

describe("verify-apify-token", () => {
  it("prints ok/username for the current token and confirms the old one is rejected, never printing tokens", async () => {
    const stub = await miniStub((r) => (r.path === "/v2/users/me" && r.headers.authorization === "Bearer new-token-value" ? { body: { data: { username: "made4buyers" } } } : { status: 401 }));
    const restore = withEnv({ APIFY_API_BASE_URL: `${stub.base}/v2`, APIFY_API_TOKEN: "new-token-value", OLD_APIFY_TOKEN: "old-token-value" });
    const out: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(a.join(" ")));
    const code = await verifyApify(["--old-token-env", "OLD_APIFY_TOKEN"]);
    spy.mockRestore();
    restore();
    await stub.close();
    expect(code).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("ok (username made4buyers)");
    expect(text).toContain("ok (revoked: HTTP 401)");
    expect(text).not.toContain("token-value");
  });

  it("fails when the old token still works or equals the new one", async () => {
    const stub = await miniStub(() => ({ body: { data: { username: "u" } } }));
    const restore = withEnv({ APIFY_API_BASE_URL: `${stub.base}/v2`, APIFY_API_TOKEN: "same", OLD_APIFY_TOKEN: "other" });
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(await verifyApify(["--old-token-env", "OLD_APIFY_TOKEN"])).toBe(1);
    process.env.OLD_APIFY_TOKEN = "same";
    expect(await verifyApify(["--old-token-env", "OLD_APIFY_TOKEN"])).toBe(1);
    spy.mockRestore();
    restore();
    await stub.close();
  });
});

describe("verify-admin output", () => {
  it("is a pass/fail table", () => {
    const t = formatTable([
      { check: "sign in", ok: true, detail: "landed on /admin" },
      { check: "page /admin/jobs", ok: false, detail: "HTTP 500" },
    ]);
    expect(t.split("\n")).toEqual([expect.stringMatching(/^CHECK\s+RESULT\s+DETAIL$/), expect.stringMatching(/^sign in\s+PASS\s+landed on \/admin$/), expect.stringMatching(/^page \/admin\/jobs\s+FAIL\s+HTTP 500$/)]);
  });
});
