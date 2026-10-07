import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { checkPageSchema, declaredSchemaVersion, fetchContentBatch, probeContentApi } from "@/lib/pipeline/content-source";
import { PipelineError } from "@/lib/errors";
import { main as verifyContentApi } from "../../scripts/verify-content-api";
import { withEnv } from "../support/env";
import { miniStub, type StubReply, type StubRequest } from "../support/mini-stub";

const BODY = "This is a long enough review body that explains the product in detail. ".repeat(4);
const item = (id: string, extra: Record<string, unknown> = {}) => ({ id, title: `Example product ${id} review`, body: BODY, publishedAt: "2026-10-01T09:00:00Z", productName: `Example ${id}`, ...extra });

let route: (r: StubRequest) => StubReply = () => ({ body: { items: [] } });
let stub: Awaited<ReturnType<typeof miniStub>>;
let restore: () => void;

beforeAll(async () => {
  stub = await miniStub((r) => route(r));
  restore = withEnv({ UNSAFE_ALLOW_LOOPBACK_FOR_TESTS: "true", CONTENT_API_URL: `${stub.base}/v1/reviews`, CONTENT_API_KEY: "contract-test-key", CONTENT_API_AUTH_HEADER: "X-API-Key", CONTENT_API_MAX_RETRIES: "0", CONTENT_API_SCHEMA_VERSION: undefined });
});
afterAll(async () => {
  restore();
  await stub.close();
});
afterEach(() => {
  stub.requests.length = 0;
});

async function failure(): Promise<PipelineError> {
  try {
    await fetchContentBatch();
  } catch (e) {
    return e as PipelineError;
  }
  throw new Error("expected fetchContentBatch to fail");
}

describe("Content API contract v1 (stub server)", () => {
  it("sends the configured auth header and follows same-origin pagination", async () => {
    route = (r) => (r.query.get("page") === "2" ? { body: { items: [item("b1")] } } : { body: { schemaVersion: "1.2", items: [item("a1"), item("a2")], next: "/v1/reviews?page=2" } });
    const batch = await fetchContentBatch();
    expect(batch.items).toHaveLength(3);
    expect(batch.pages).toBe(2);
    expect(stub.requests[0].headers["x-api-key"]).toBe("contract-test-key");
    expect(stub.requests[0].headers.authorization).toBeUndefined();
  });

  it("sends Authorization: <scheme> <key> by default", async () => {
    const r2 = withEnv({ CONTENT_API_AUTH_HEADER: undefined, CONTENT_API_AUTH_SCHEME: "Token" });
    route = () => ({ body: [item("x1")] });
    await fetchContentBatch();
    r2();
    expect(stub.requests[0].headers.authorization).toBe("Token contract-test-key");
  });

  it("rejects a feed that declares an unsupported major schema version (body or header)", async () => {
    route = () => ({ body: { schemaVersion: "2.0", items: [item("a1")] } });
    let e = await failure();
    expect(e.code).toBe("CONTENT_API_SCHEMA_MISMATCH");
    expect(e.message).toMatch(/declares schema version 2\.0.*supports version 1/);

    route = () => ({ body: { items: [item("a1")] }, headers: { "X-Schema-Version": "v3" } });
    e = await failure();
    expect(e.code).toBe("CONTENT_API_SCHEMA_MISMATCH");
  });

  it("accepts the version the owner pins with CONTENT_API_SCHEMA_VERSION", async () => {
    const r2 = withEnv({ CONTENT_API_SCHEMA_VERSION: "2" });
    route = () => ({ body: { schemaVersion: 2, items: [item("a1")] } });
    await expect(fetchContentBatch()).resolves.toMatchObject({ items: [expect.anything()] });
    r2();
  });

  it("rejects a page where no item has the required fields, naming the fields received (never values)", async () => {
    route = () => ({ body: { items: [{ uid: 1, heading: "Secret title text", text: BODY }, { uid: 2, heading: "Another", text: BODY }] } });
    const e = await failure();
    expect(e.code).toBe("CONTENT_API_SCHEMA_MISMATCH");
    expect(e.message).toContain("fields received: uid, heading, text");
    expect(e.message).not.toContain("Secret title text");
    expect(e.retryable).toBe(false);
  });

  it("isolates individual bad items instead of failing the page", async () => {
    route = () => ({ body: { items: [item("ok1"), { title: "no id here at all" }] } });
    const batch = await fetchContentBatch();
    expect(batch.items).toHaveLength(2);
  });

  it("rejects a response without an item array, listing the top-level keys", async () => {
    route = () => ({ body: { posts: [item("a1")] } });
    const e = await failure();
    expect(e.code).toBe("CONTENT_API_RESPONSE_INVALID");
    expect(e.message).toContain("top-level keys received: posts");
  });

  it("reports HTTP errors with the status and never retries a 401", async () => {
    route = () => ({ status: 401, body: { error: "nope" } });
    const e = await failure();
    expect(e.code).toBe("CONTENT_API_HTTP_ERROR");
    expect(stub.requests).toHaveLength(1);
  });

  it("probe returns counts only", async () => {
    route = () => ({ body: { schemaVersion: "1", items: [item("p1"), item("p2", { publishedAt: "not a date" })], next: "/v1/reviews?page=2" } });
    const r = await probeContentApi();
    expect(r).toMatchObject({ status: "OK", items: 2, valid: 1, invalid: 1, declaredVersion: "1", expectedVersion: "1", hasNextPage: true });
  });

  it("verify-content-api prints counts and no item content or key", async () => {
    route = () => ({ body: { items: [item("v1", { title: "UNIQUE-TITLE-MARKER review text" })] } });
    const out: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(a.join(" ")));
    const code = await verifyContentApi();
    spy.mockRestore();
    expect(code).toBe(0);
    const text = out.join("\n");
    expect(text).toMatch(/items on page 1\s+1/);
    expect(text).not.toContain("UNIQUE-TITLE-MARKER");
    expect(text).not.toContain("contract-test-key");
  });

  it("probe and verify script report BLOCKED_BY_ENVIRONMENT without CONTENT_API_URL", async () => {
    const r2 = withEnv({ CONTENT_API_URL: undefined });
    expect(await probeContentApi()).toEqual({ status: "BLOCKED_BY_ENVIRONMENT", missing: ["CONTENT_API_URL"] });
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(await verifyContentApi()).toBe(2);
    spy.mockRestore();
    r2();
  });
});

describe("schema helpers", () => {
  it("reads the declared version from body, meta or headers", () => {
    expect(declaredSchemaVersion({ schema_version: "v1.4" })).toBe("1.4");
    expect(declaredSchemaVersion({ meta: { schemaVersion: 1 } })).toBe("1");
    expect(declaredSchemaVersion([], { "Api-Version": "1" })).toBe("1");
    expect(declaredSchemaVersion({ items: [] })).toBeUndefined();
  });

  it("an empty page is not a mismatch", () => {
    expect(checkPageSchema({ items: [] }, [])).toMatchObject({ ok: true, valid: 0, invalid: 0 });
  });
});
