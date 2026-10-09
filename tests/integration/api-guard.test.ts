import { beforeEach, describe, expect, it, vi } from "vitest";
import { log } from "@/lib/log";
import { guardedApiCall, onceInInvocation, serial, withApiInvocation } from "@/lib/ops/api-guard";
import { resetDb } from "../support/db";

// Mock calls only: no real API is called and no token is used.
beforeEach(() => resetDb());

const base = { api: "apify" as const, unit: "start:brand:b1", trigger: "test" };

describe("guardedApiCall: preflight before the call", () => {
  it("skips the call at the first failing check and logs the exact reason", async () => {
    const warn = vi.spyOn(log, "warn");
    const call = vi.fn(async () => "x");
    const r1 = await guardedApiCall({ ...base, config: [() => ({ code: "APIFY_NOT_CONFIGURED", reason: "APIFY_API_TOKEN not configured" })], call });
    expect(r1).toEqual({ status: "SKIPPED", code: "APIFY_NOT_CONFIGURED", reason: "APIFY_API_TOKEN not configured" });
    const r2 = await guardedApiCall({ ...base, params: () => ({ code: "INVALID_PARAMS", reason: "a start URL is not http(s)" }), call });
    expect(r2).toMatchObject({ status: "SKIPPED", code: "INVALID_PARAMS" });
    const r3 = await guardedApiCall({ ...base, budget: [async () => ({ code: "BUDGET_EXHAUSTED", reason: "monthly Apify budget would be exceeded" })], call });
    expect(r3).toMatchObject({ status: "SKIPPED", code: "BUDGET_EXHAUSTED" });
    expect(call).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith("api call skipped", expect.objectContaining({ api: "apify", unit: "start:brand:b1", code: "BUDGET_EXHAUSTED", reason: "monthly Apify budget would be exceeded" }));
    warn.mockRestore();
  });

  it("checks configuration, then parameters, then the database, then the budget", async () => {
    const order: string[] = [];
    await guardedApiCall({
      ...base,
      config: [() => (order.push("config"), null)],
      params: () => (order.push("params"), null),
      budget: [() => (order.push("budget"), null)],
      call: async () => order.push("call"),
    });
    expect(order).toEqual(["config", "params", "budget", "call"]);
  });
});

describe("guardedApiCall: one call per unit (idempotency)", () => {
  it("a duplicate trigger with the same basis does not call; the next legitimate basis does", async () => {
    const call = vi.fn(async () => ({ data: { id: "run-1" } }));
    expect((await guardedApiCall({ ...base, idempotencyBasis: "prev-run-0", call })).status).toBe("OK");
    expect(await guardedApiCall({ ...base, idempotencyBasis: "prev-run-0", call })).toMatchObject({ status: "SKIPPED", code: "DUPLICATE_CALL" });
    expect(call).toHaveBeenCalledTimes(1);
    expect((await guardedApiCall({ ...base, idempotencyBasis: "prev-run-1", call })).status).toBe("OK");
    expect(call).toHaveBeenCalledTimes(2);
  });

  it("five concurrent triggers for one unit make exactly one call", async () => {
    const call = vi.fn(async () => "ok");
    const results = await Promise.all(Array.from({ length: 5 }, () => guardedApiCall({ ...base, idempotencyBasis: "same", call })));
    expect(call).toHaveBeenCalledTimes(1);
    expect(results.filter((r) => r.status === "OK")).toHaveLength(1);
    expect(results.filter((r) => r.status === "SKIPPED" && r.code === "DUPLICATE_CALL")).toHaveLength(4);
  });

  it("a failed call is not retried: the error reaches the caller and the unit stays called for this basis", async () => {
    const call = vi.fn(async () => {
      throw new Error("HTTP 500");
    });
    await expect(guardedApiCall({ ...base, idempotencyBasis: "b", call })).rejects.toThrow("HTTP 500");
    expect(call).toHaveBeenCalledTimes(1);
    expect(await guardedApiCall({ ...base, idempotencyBasis: "b", call })).toMatchObject({ status: "SKIPPED", code: "DUPLICATE_CALL" });
    expect(call).toHaveBeenCalledTimes(1);
  });
});

describe("guardedApiCall: response validation before saving", () => {
  it("returns INVALID_RESPONSE (with the value, nothing saved by the caller) when the response fails validation", async () => {
    const r = await guardedApiCall({ ...base, call: async () => ({ data: {} as { id?: string } }), validate: (v) => (v.data.id ? null : { code: "APIFY_RESPONSE_INVALID", reason: "Apify did not return a run id" }) });
    expect(r).toMatchObject({ status: "INVALID_RESPONSE", code: "APIFY_RESPONSE_INVALID", value: { data: {} } });
  });
});

describe("one result per invocation, no parallel calls", () => {
  it("inside an invocation the first result is reused by every later caller; outside, each call is made", async () => {
    const fetch = vi.fn(async () => ({ status: "SUCCEEDED" }));
    await withApiInvocation(async () => {
      const a = await onceInInvocation("apify:status:r1", fetch);
      const b = await onceInInvocation("apify:status:r1", fetch);
      expect(b).toBe(a);
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    await withApiInvocation(() => onceInInvocation("apify:status:r1", fetch)); // a new invocation: called again
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("serial() never lets two calls to one API overlap", async () => {
    let inFlight = 0;
    let max = 0;
    const call = () =>
      serial("pexels", async () => {
        inFlight++;
        max = Math.max(max, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
      });
    await Promise.all([call(), call(), call(), call()]);
    expect(max).toBe(1);
  });
});
