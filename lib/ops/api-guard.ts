import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";
import { db } from "@/lib/db";
import { acquireLock } from "@/lib/jobs/lock";
import { log } from "@/lib/log";
import { checkSchema } from "./schema-check";

/**
 * Guard for every call to a PAID / QUOTA API (Apify, Feedico, Pexels, the image enrichment service,
 * Keyword-to-Blog, the Content API). Rule: one call per unit of work per trigger — no duplicate, no
 * retry, no parallel call — and every call is validated before it is made and after it returns.
 *
 * guardedApiCall() runs, in order, and skips the call (logging the exact reason) at the first failure:
 *   1. configuration and authentication checks (caller-supplied: key/URL present, switch on, …)
 *   2. request parameters (caller-supplied validator)
 *   3. database reachable and its schema matching this build (cached 10 min per process)
 *   4. budget / quota checks (caller-supplied)
 *   5. idempotency: an atomic database marker for (api, unit) — a second trigger for the same unit
 *      finds it and does not call. Writing the marker is also the write-readiness check: when the
 *      database cannot be written, nothing is called (a result could not be saved).
 * then makes exactly ONE call (no retry), and validates the response before the caller saves it.
 *
 * Inside one job invocation (withApiInvocation, wrapped around every scheduled job by runJob),
 * onceInInvocation() returns the first result for a key to every later caller (status polls,
 * dataset downloads, search queries), so downstream steps reuse a result instead of calling again.
 * serial() makes calls to one API one at a time (no parallel calls) within the process.
 */

export type PaidApi = "apify" | "feedico" | "pexels" | "image-service" | "keyword-to-blog" | "content-api";
export type GuardFailure = { code: string; reason: string };
export type PreflightCheck = () => GuardFailure | null | Promise<GuardFailure | null>;

export type GuardResult<T> =
  | { status: "OK"; value: T }
  | { status: "SKIPPED"; code: string; reason: string }
  | { status: "INVALID_RESPONSE"; code: string; reason: string; value: T };

export type GuardedCall<T> = {
  api: PaidApi;
  /** The unit of work, e.g. "start:brand:<id>" — one call per unit. */
  unit: string;
  /**
   * Idempotency basis: what makes this call the NEXT legitimate one for the unit (e.g. the id of the
   * unit's previous run, or the time of its last fetch). Two triggers that see the same basis are
   * duplicates: only the first calls. Omit to skip the database marker (cheap reads).
   */
  idempotencyBasis?: string;
  /** How long the marker is kept (it only needs to outlive concurrent duplicates). Default 7 days. */
  markerTtlMs?: number;
  trigger: string;
  config?: PreflightCheck[];
  params?: PreflightCheck;
  budget?: PreflightCheck[];
  /** Skip the database/schema check (callers already inside a DB transaction of their own). */
  skipDbCheck?: boolean;
  call: () => Promise<T>;
  validate?: (value: T) => GuardFailure | null;
};

const SCHEMA_TTL_MS = 10 * 60_000;
let schemaCache: { at: number; failure: GuardFailure | null } | null = null;

/** Test hook: forget the cached schema verdict. */
export function resetApiGuardCache(): void {
  schemaCache = null;
}

async function databaseReady(): Promise<GuardFailure | null> {
  if (schemaCache && Date.now() - schemaCache.at < SCHEMA_TTL_MS) return schemaCache.failure;
  let failure: GuardFailure | null = null;
  try {
    const report = await checkSchema(db);
    if (!report.ok) failure = { code: "SCHEMA_MISMATCH", reason: `database schema does not match this build (missing: ${[...report.missingTables, ...report.missingColumns, ...report.missingEnumValues].slice(0, 5).join(", ")})` };
  } catch (error) {
    failure = { code: "DATABASE_UNAVAILABLE", reason: `database not reachable: ${String(error).slice(0, 160)}` };
  }
  schemaCache = { at: Date.now(), failure };
  return failure;
}

function skipped<T>(api: PaidApi, unit: string, trigger: string, f: GuardFailure): GuardResult<T> {
  log.warn("api call skipped", { stage: "API_GUARD", api, unit, trigger, code: f.code, reason: f.reason });
  return { status: "SKIPPED", code: f.code, reason: f.reason };
}

/** The idempotency marker key for (api, unit, basis): stable, bounded length. */
export function apiMarkerKey(api: PaidApi, unit: string, basis: string): string {
  return `api:${api}:${crypto.createHash("sha256").update(`${unit}\u0000${basis}`).digest("hex").slice(0, 40)}`;
}

/** Preflight → one call → response validation. Errors thrown by `call` propagate (no retry). */
export async function guardedApiCall<T>(o: GuardedCall<T>): Promise<GuardResult<T>> {
  for (const check of o.config ?? []) {
    const f = await check();
    if (f) return skipped(o.api, o.unit, o.trigger, f);
  }
  if (o.params) {
    const f = await o.params();
    if (f) return skipped(o.api, o.unit, o.trigger, { code: f.code || "INVALID_PARAMS", reason: f.reason });
  }
  if (!o.skipDbCheck) {
    const f = await databaseReady();
    if (f) return skipped(o.api, o.unit, o.trigger, f);
  }
  for (const check of o.budget ?? []) {
    const f = await check();
    if (f) return skipped(o.api, o.unit, o.trigger, f);
  }
  if (o.idempotencyBasis !== undefined) {
    let owner: string | null;
    try {
      owner = await acquireLock(apiMarkerKey(o.api, o.unit, o.idempotencyBasis), o.markerTtlMs ?? 7 * 86_400_000);
    } catch (error) {
      return skipped(o.api, o.unit, o.trigger, { code: "DATABASE_NOT_WRITABLE", reason: `cannot record the call before making it: ${String(error).slice(0, 160)}` });
    }
    if (!owner) return skipped(o.api, o.unit, o.trigger, { code: "DUPLICATE_CALL", reason: `${o.unit} was already called for this trigger (basis ${o.idempotencyBasis})` });
  }
  log.info("api call", { stage: "API_GUARD", api: o.api, unit: o.unit, trigger: o.trigger });
  const value = await o.call();
  const bad = o.validate?.(value) ?? null;
  if (bad) {
    log.warn("api response rejected", { stage: "API_GUARD", api: o.api, unit: o.unit, trigger: o.trigger, code: bad.code, reason: bad.reason });
    return { status: "INVALID_RESPONSE", code: bad.code, reason: bad.reason, value };
  }
  return { status: "OK", value };
}

// ── One result per key within a job invocation ───────────────────────────

type Invocation = { id: string; results: Map<string, Promise<unknown>> };
const invocation = new AsyncLocalStorage<Invocation>();

/** Runs `fn` as one job invocation: onceInInvocation() results are shared inside it. */
export function withApiInvocation<T>(fn: () => Promise<T>): Promise<T> {
  return invocation.run({ id: crypto.randomUUID(), results: new Map() }, fn);
}

/**
 * The first call for `key` in this invocation is made; every later call for the same key gets the
 * same result (or the same error). Outside an invocation (tests, scripts) it simply calls.
 */
export function onceInInvocation<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const inv = invocation.getStore();
  if (!inv) return fn();
  const hit = inv.results.get(key) as Promise<T> | undefined;
  if (hit) {
    log.debug("api result reused", { stage: "API_GUARD", key });
    return hit;
  }
  const p = fn();
  inv.results.set(key, p);
  return p;
}

// ── No parallel calls to one API ─────────────────────────────────────────

const tails = new Map<PaidApi, Promise<unknown>>();

/** Queues `fn` behind every earlier call to the same API in this process (one in flight at a time). */
export function serial<T>(api: PaidApi, fn: () => Promise<T>): Promise<T> {
  const prev = tails.get(api) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  tails.set(
    api,
    run.catch(() => undefined),
  );
  return run;
}
