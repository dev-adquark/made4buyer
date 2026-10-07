import { safeFetch } from "@/lib/net/safe-fetch";
import { bareHost, env, onDomain, parseHttpUrl, wellFormedAffiliateUrl, type AffiliateProvider } from "./types";

/**
 * impact.com (partner side) — Tracking Link API:
 *   POST {IMPACT_API_BASE_URL}/Mediapartners/{IMPACT_ACCOUNT_SID}/Programs/{programId}/TrackingLinks?DeepLink=<url>
 *   Basic auth (Account SID : Auth Token), Accept: application/json → { "TrackingURL": "https://…" }
 *
 * Impact links are per program (brand), so a destination is wrapped ONLY when its domain is
 * mapped to a program the partner account was approved for, via IMPACT_PROGRAMS (JSON object
 * `{ "merchant-domain.com": "<programId>" }`). The returned TrackingURL is verified (absolute
 * https, bounded, not the destination itself) before it is stored; anything else → UNAVAILABLE.
 *
 * Env: IMPACT_ACCOUNT_SID, IMPACT_AUTH_TOKEN, IMPACT_PROGRAMS. IMPACT_API_BASE_URL is
 * overridable only so tests can use a local stub (default https://api.impact.com).
 */

const REQUIRED = ["IMPACT_ACCOUNT_SID", "IMPACT_AUTH_TOKEN", "IMPACT_PROGRAMS"] as const;
const base = () => (env("IMPACT_API_BASE_URL") ?? "https://api.impact.com").replace(/\/+$/, "");

/** domain → programId from IMPACT_PROGRAMS, or undefined when the JSON is malformed. */
export function impactPrograms(): Map<string, string> | undefined {
  const raw = env("IMPACT_PROGRAMS");
  if (!raw) return undefined;
  try {
    const obj = JSON.parse(raw) as unknown;
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return undefined;
    const map = new Map<string, string>();
    for (const [domain, id] of Object.entries(obj as Record<string, unknown>)) {
      const pid = typeof id === "number" ? String(id) : id;
      if (typeof pid !== "string" || !/^\d{1,12}$/.test(pid) || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) return undefined;
      map.set(domain.toLowerCase().replace(/^www\./, ""), pid);
    }
    return map.size ? map : undefined;
  } catch {
    return undefined;
  }
}

function missing(): string[] {
  const out: string[] = [];
  if (!env("IMPACT_ACCOUNT_SID") || !/^[A-Za-z0-9]{8,64}$/.test(env("IMPACT_ACCOUNT_SID")!)) out.push("IMPACT_ACCOUNT_SID");
  if (!env("IMPACT_AUTH_TOKEN")) out.push("IMPACT_AUTH_TOKEN");
  if (!impactPrograms()) out.push("IMPACT_PROGRAMS");
  return out;
}

function programFor(raw: string): string | undefined {
  const u = parseHttpUrl(raw);
  const programs = impactPrograms();
  if (!u || !programs) return undefined;
  const host = bareHost(u);
  for (const [domain, id] of programs) if (onDomain(host, domain)) return id;
  return undefined;
}

export const impactProvider: AffiliateProvider = {
  name: "impact",
  requiredEnv: REQUIRED,
  get active() {
    return missing().length === 0;
  },
  missingEnv: missing,
  supports: (url) => Boolean(programFor(url)),
  async wrap(destinationUrl) {
    if (missing().length) return { status: "UNAVAILABLE", reason: `missing or invalid ${missing().join(", ")}` };
    const programId = programFor(destinationUrl);
    if (!programId) return { status: "NOT_AFFILIATABLE", reason: "destination domain is not mapped to an Impact program in IMPACT_PROGRAMS" };
    const sid = env("IMPACT_ACCOUNT_SID")!;
    const auth = Buffer.from(`${sid}:${env("IMPACT_AUTH_TOKEN")}`).toString("base64");
    const url = `${base()}/Mediapartners/${encodeURIComponent(sid)}/Programs/${programId}/TrackingLinks?${new URLSearchParams({ DeepLink: destinationUrl })}`;
    const res = await safeFetch(url, { method: "POST", headers: { Authorization: `Basic ${auth}`, Accept: "application/json" }, timeoutMs: 10_000, maxRedirects: 0, readBody: true, maxBytes: 100_000 });
    if (!res.ok) return { status: "UNAVAILABLE", reason: res.status === 401 || res.status === 403 ? "Impact rejected the credentials or the program is not approved" : `Impact Tracking Link API HTTP ${res.status || res.error?.kind}` };
    let tracking: unknown;
    try {
      tracking = (JSON.parse(res.body ?? "{}") as { TrackingURL?: unknown }).TrackingURL;
    } catch {
      return { status: "UNAVAILABLE", reason: "Impact response is not JSON" };
    }
    const u = wellFormedAffiliateUrl(tracking);
    if (!u || u.toString() === new URL(destinationUrl).toString() || (u.pathname === "/" && !u.search)) return { status: "UNAVAILABLE", reason: "Impact returned no valid TrackingURL" };
    return { status: "AFFILIATED", affiliateUrl: u.toString(), provider: "impact" };
  },
};
