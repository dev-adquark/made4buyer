/**
 * Apify token check after rotation. Prints only ok/username/HTTP status, never a token.
 *
 *   npx tsx scripts/verify-apify-token.ts                                  # APIFY_API_TOKEN must work
 *   OLD_APIFY_TOKEN=... npx tsx scripts/verify-apify-token.ts --old-token-env OLD_APIFY_TOKEN
 *                                                                          # and the OLD token must be rejected (401)
 *
 * The token is read from the environment (or .env.local/.env) only; pass the NAME of the variable
 * holding the old token, never the token itself, so it never lands in shell history.
 * APIFY_API_BASE_URL overrides the API base (tests only). Exit 0 = all checks pass.
 */
import "./support/load-env";

const base = () => (process.env.APIFY_API_BASE_URL?.trim() || "https://api.apify.com/v2").replace(/\/+$/, "");

export async function checkToken(token: string): Promise<{ status: number; username?: string }> {
  const res = await fetch(`${base()}/users/me`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    return { status: res.status };
  }
  const data = (await res.json().catch(() => ({}))) as { data?: { username?: unknown } };
  return { status: res.status, username: typeof data.data?.username === "string" ? data.data.username : undefined };
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  let failed = false;
  const token = process.env.APIFY_API_TOKEN?.trim();
  if (!token) {
    console.log("current token          MISSING (set APIFY_API_TOKEN)");
    failed = true;
  } else {
    const r = await checkToken(token);
    if (r.status === 200) console.log(`current token          ok (username ${r.username ?? "unknown"})`);
    else {
      console.log(`current token          FAIL (HTTP ${r.status})`);
      failed = true;
    }
  }
  const i = argv.indexOf("--old-token-env");
  if (i >= 0) {
    const name = argv[i + 1];
    const old = name ? process.env[name]?.trim() : undefined;
    if (!name || !/^[A-Z_][A-Z0-9_]*$/.test(name)) {
      console.log("old token              FAIL (--old-token-env needs an env var NAME, e.g. OLD_APIFY_TOKEN)");
      failed = true;
    } else if (!old) {
      console.log(`old token              FAIL (${name} is not set)`);
      failed = true;
    } else if (old === token) {
      console.log(`old token              FAIL (${name} equals APIFY_API_TOKEN: the token was not rotated)`);
      failed = true;
    } else {
      const r = await checkToken(old);
      if (r.status === 401) console.log("old token              ok (revoked: HTTP 401)");
      else {
        console.log(`old token              FAIL (still accepted or unexpected: HTTP ${r.status}); revoke it in Apify Console → Settings → API & Integrations`);
        failed = true;
      }
    }
  }
  return failed ? 1 : 0;
}

if (process.argv[1]?.endsWith("verify-apify-token.ts")) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error("verify-apify-token failed:", (error as Error).name);
      process.exit(1);
    });
}
