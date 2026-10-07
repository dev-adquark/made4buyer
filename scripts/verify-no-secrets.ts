/**
 * Secret scan. Looks for known secret shapes in
 *   1. the working tree (excluding node_modules, .git, .next, .tmp, test output and local .env files),
 *   2. the `.next` build output (client bundles in .next/static and server output in .next/server),
 *   3. the production HTML and every same-origin /_next/static JS file it references.
 * Prints ONLY locations and the pattern name: never the matched value or any part of it.
 *
 *   npx tsx scripts/verify-no-secrets.ts                       # all three
 *   npx tsx scripts/verify-no-secrets.ts --skip-prod           # local only
 *   npx tsx scripts/verify-no-secrets.ts --prod-url https://made4buyers.vercel.app --pages /,/deals
 *
 * Exit 0 = nothing found, 1 = findings (or the production fetch failed).
 * Git history is NOT scanned here (see docs/OWNER_ACTIONS.md → "Purge git history").
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export type Finding = { location: string; line?: number; pattern: string };

/** Known secret shapes. Sovrn keys are matched by their known prefixes only (e9f9…/c668…). */
export const PATTERNS: Array<{ name: string; re: RegExp; ignore?: (match: string) => boolean }> = [
  { name: "Apify API token (apify_api_…)", re: /apify_api_[A-Za-z0-9]{20,}/g },
  { name: "Sovrn key (prefix e9f9)", re: /(?<![0-9a-fA-F])e9f9[0-9a-fA-F]{20,}(?![0-9a-fA-F])/g },
  { name: "Sovrn key (prefix c668)", re: /(?<![0-9a-fA-F])c668[0-9a-fA-F]{20,}(?![0-9a-fA-F])/g },
  { name: "Vercel token (vcp_…)", re: /(?<![A-Za-z0-9_])vcp_[A-Za-z0-9]{20,}/g },
  { name: "API secret key (sk-…)", re: /(?<![A-Za-z0-9_-])sk-(?:ant-|proj-|live_|test_)?[A-Za-z0-9_-]{24,}/g },
  { name: "JWT", re: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  {
    name: "Postgres URL with password",
    re: /postgres(?:ql)?:\/\/[^\s:@/'"`]+:[^\s@/'"`]+@[^\s/'"`:]+/g,
    // Local/test databases (embedded Postgres, CI services) are not secrets.
    // Placeholders (PASSWORD, [YOUR-PASSWORD], ${PGPASSWORD}) and very short test strings are not secrets either.
    ignore: (m) => {
      if (/@(localhost|127\.0\.0\.1|\[::1\]|postgres|db)$/i.test(m)) return true;
      const pw = /^postgres(?:ql)?:\/\/[^:]+:([^@]+)@/.exec(m)?.[1] ?? "";
      return pw.length < 8 || /^[A-Z0-9_\[\]<>{}$-]+$/.test(pw) || /PASSWORD/i.test(pw);
    },
  },
  { name: "Private key block", re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----\s*[A-Za-z0-9+/=]{40,}/g },
];

const SKIP_DIRS = new Set(["node_modules", ".git", ".next", ".tmp", "test-results", "playwright-report", ".vercel", "coverage"]);
const MAX_BYTES = 8_000_000;

export function scanText(text: string, location: string): Finding[] {
  const out: Finding[] = [];
  for (const p of PATTERNS) {
    p.re.lastIndex = 0;
    for (const m of text.matchAll(p.re)) {
      if (p.ignore?.(m[0])) continue;
      const line = text.slice(0, m.index ?? 0).split("\n").length;
      out.push({ location, line, pattern: p.name });
    }
  }
  return out;
}

function readable(file: string): string | undefined {
  const st = statSync(file);
  if (!st.isFile() || st.size > MAX_BYTES) return undefined;
  const buf = readFileSync(file);
  if (buf.subarray(0, 8000).includes(0)) return undefined; // binary
  return buf.toString("utf8");
}

function walk(dir: string, skip: (rel: string, name: string, isDir: boolean) => boolean, root = dir, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(root, full);
    if (entry.isSymbolicLink()) continue;
    if (skip(rel, entry.name, entry.isDirectory())) continue;
    if (entry.isDirectory()) walk(full, skip, root, out);
    else out.push(full);
  }
  return out;
}

/** Working tree: every text file except dependencies, build output and local (git-ignored) env files. */
export function scanWorkingTree(root = process.cwd()): Finding[] {
  const files = walk(root, (_rel, name, isDir) => (isDir ? SKIP_DIRS.has(name) : /^\.env(\..+)?$/.test(name) && name !== ".env.example") || /\.(png|jpe?g|gif|webp|avif|ico|woff2?|ttf|pdf|zip|gz|tsbuildinfo)$/i.test(name));
  return files.flatMap((f) => {
    const text = readable(f);
    return text ? scanText(text, path.relative(root, f)) : [];
  });
}

/** Build output: client bundles (.next/static) and server output (.next/server). */
export function scanBuildOutput(root = process.cwd()): Finding[] | undefined {
  const next = path.join(root, ".next");
  if (!existsSync(next)) return undefined;
  const dirs = ["static", "server"].map((d) => path.join(next, d)).filter((d) => existsSync(d));
  return dirs.flatMap((d) =>
    walk(d, (_rel, name, isDir) => isDir && name === "cache").flatMap((f) => {
      if (!/\.(js|mjs|cjs|html|rsc|json|txt|body|meta|map)$/i.test(f)) return [];
      const text = readable(f);
      return text ? scanText(text, path.relative(root, f)) : [];
    }),
  );
}

/** Production: the given pages' HTML plus every same-origin /_next/static JS chunk they reference. */
export async function scanProduction(base: string, pages: string[] = ["/"]): Promise<{ findings: Finding[]; fetched: number; errors: string[] }> {
  const origin = new URL(base).origin;
  const findings: Finding[] = [];
  const errors: string[] = [];
  const scripts = new Set<string>();
  let fetched = 0;
  const get = async (url: string) => {
    const res = await fetch(url, { signal: AbortSignal.timeout(20000), headers: { "User-Agent": "made4buyers-secret-scan" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    fetched++;
    return res.text();
  };
  for (const p of pages) {
    const url = new URL(p, origin).toString();
    try {
      const html = await get(url);
      findings.push(...scanText(html, url));
      for (const m of html.matchAll(/(?:src|href)="([^"]+\.js(?:\?[^"]*)?)"/g)) {
        const u = new URL(m[1].replace(/&amp;/g, "&"), origin);
        if (u.origin === origin && u.pathname.startsWith("/_next/static/")) scripts.add(u.toString());
      }
    } catch (e) {
      errors.push(`${url}: ${(e as Error).message}`);
    }
  }
  for (const s of scripts) {
    try {
      findings.push(...scanText(await get(s), s));
    } catch (e) {
      errors.push(`${s}: ${(e as Error).message}`);
    }
  }
  return { findings, fetched, errors };
}

const arg = (argv: string[], name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const print = (label: string, list: Finding[]) => {
    console.log(`${label.padEnd(16)} ${list.length ? `${list.length} finding(s)` : "clean"}`);
    for (const f of list) console.log(`  ${f.location}${f.line ? `:${f.line}` : ""}  ${f.pattern}`);
  };
  let bad = false;
  const tree = scanWorkingTree();
  print("working tree", tree);
  bad ||= tree.length > 0;
  const build = scanBuildOutput();
  if (build) {
    print(".next output", build);
    bad ||= build.length > 0;
  } else console.log(".next output     not built (run npm run build to include it)");
  if (!argv.includes("--skip-prod")) {
    const base = arg(argv, "prod-url") ?? process.env.NEXT_PUBLIC_SITE_URL ?? "https://made4buyers.vercel.app";
    const pages = (arg(argv, "pages") ?? "/,/deals,/reviews").split(",").filter(Boolean);
    const prod = await scanProduction(base, pages);
    print("production", prod.findings);
    console.log(`  (${prod.fetched} file(s) fetched from ${new URL(base).origin})`);
    for (const e of prod.errors) console.log(`  fetch error: ${e}`);
    bad ||= prod.findings.length > 0 || prod.fetched === 0;
  }
  return bad ? 1 : 0;
}

if (process.argv[1]?.endsWith("verify-no-secrets.ts")) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error("verify-no-secrets failed:", (error as Error).message);
      process.exit(1);
    });
}
