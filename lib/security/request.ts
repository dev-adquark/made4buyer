import { config } from "@/lib/config";

/**
 * CSRF defence for cookie-authenticated mutations: the request must carry an Origin (or,
 * failing that, Sec-Fetch-Site: same-origin / a same-origin Referer) matching this site.
 * Combined with SameSite=Strict session cookies this blocks cross-site form posts.
 */
export function isSameOrigin(req: Request): boolean {
  const allowed = new Set<string>();
  try {
    allowed.add(new URL(req.url).origin);
  } catch {
    /* ignore */
  }
  try {
    allowed.add(new URL(config.siteUrl()).origin);
  } catch {
    /* ignore */
  }
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  const proto = req.headers.get("x-forwarded-proto") ?? (req.url.startsWith("https:") ? "https" : "http");
  if (host) allowed.add(`${proto}://${host}`);

  const origin = req.headers.get("origin");
  if (origin && origin !== "null") return allowed.has(origin);
  const fetchSite = req.headers.get("sec-fetch-site");
  if (fetchSite) return fetchSite === "same-origin";
  const referer = req.headers.get("referer");
  if (referer) {
    try {
      return allowed.has(new URL(referer).origin);
    } catch {
      return false;
    }
  }
  return false;
}

export function clientIp(req: Request): string | null {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim() || null;
  return req.headers.get("x-real-ip");
}

export function cronAuthorized(req: Request): boolean {
  const secret = config.cronSecret();
  if (!secret) return false;
  const header = req.headers.get("authorization") ?? "";
  const expected = `Bearer ${secret}`;
  if (header.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < header.length; i++) diff |= header.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

/** Only allow redirects back to relative admin paths (open-redirect protection). */
export function safeReturnPath(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return fallback;
  return value;
}
