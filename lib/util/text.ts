import crypto from "node:crypto";

export function slugify(value: string, max = 120): string {
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
}

export function cleanText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };

/** Converts untrusted HTML/text into plain text paragraphs. Output is rendered as text, never HTML. */
export function htmlToPlainText(input: string): string {
  return input
    .replace(/<(script|style|iframe|object|noscript)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|section|article|blockquote|tr)>/gi, "\n\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#?[a-z0-9]+);/gi, (m, e: string) => {
      const key = e.toLowerCase();
      if (ENTITIES[key]) return ENTITIES[key];
      if (key.startsWith("#x")) return safeCodePoint(parseInt(key.slice(2), 16)) ?? m;
      if (key.startsWith("#")) return safeCodePoint(parseInt(key.slice(1), 10)) ?? m;
      return m;
    })
    .split(/\n{2,}/)
    .map((p) => p.replace(/[ \t\f\v]+/g, " ").replace(/\s*\n\s*/g, "\n").trim())
    .filter(Boolean)
    .join("\n\n");
}

function safeCodePoint(code: number): string | undefined {
  if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return undefined;
  return String.fromCodePoint(code);
}

export function paragraphs(body: string): string[] {
  return body.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
}

export function truncateWords(value: string, max: number): string {
  const clean = cleanText(value);
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max + 1);
  const idx = cut.lastIndexOf(" ");
  return (idx > max * 0.6 ? cut.slice(0, idx) : clean.slice(0, max)).replace(/[\s,;:–—-]+$/, "") + "…";
}

export function firstSentences(value: string, maxChars: number): string {
  const clean = cleanText(value);
  const sentences = clean.match(/[^.!?]+[.!?]+/g) ?? [clean];
  let out = "";
  for (const s of sentences) {
    if ((out + s).length > maxChars) break;
    out += s;
  }
  return (out || truncateWords(clean, maxChars)).trim();
}

export function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/** Deterministic JSON serialisation (sorted keys) used for hashing payloads. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return "{" + entries.map(([k, v]) => JSON.stringify(k) + ":" + stableStringify(v)).join(",") + "}";
}

export function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9.+#]+/g, " ")
    .split(" ")
    .map((t) => t.replace(/^\.+|\.+$/g, ""))
    .filter((t) => t.length > 0);
}

export function titleCase(value: string): string {
  return value.replace(/\b([a-z])([a-z]*)/g, (_, a: string, b: string) => a.toUpperCase() + b);
}
