/**
 * Generates /public/placeholders/<category>.svg for every category (plus general.svg).
 * Placeholders are typographic tear-sheet panels: they name the category and say plainly that
 * no photo is shown, so they can never be mistaken for a product photograph.
 * Run: npx tsx scripts/generate-placeholders.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CATEGORIES } from "../lib/taxonomy/definitions";
import { themeFor } from "../lib/taxonomy/themes";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function lines(name: string, max = 16): string[] {
  const out: string[] = [];
  for (const w of name.split(" ")) {
    const last = out[out.length - 1];
    if (last && `${last} ${w}`.length <= max) out[out.length - 1] = `${last} ${w}`;
    else out.push(w);
  }
  return out.slice(0, 3);
}

export function placeholderSvg(name: string, slug: string | null, issue: number | null): string {
  const t = themeFor(slug);
  const ls = lines(name);
  const size = ls.length > 2 ? 92 : 112;
  const top = 380 - ((ls.length - 1) * size) / 2;
  const mark = (x: number, y: number, dx: number, dy: number) => `<path d="M${x} ${y + dy * 28}V${y}H${x + dx * 28}" fill="none" stroke="${t.ink}" stroke-width="3"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="675" viewBox="0 0 1200 675" role="img" aria-label="${esc(name)}: illustration, not a product photo">
<rect width="1200" height="675" fill="${t.soft}"/>
<rect x="72" y="72" width="18" height="531" fill="${t.from}"/>
${mark(40, 40, 1, 1)}${mark(1160, 40, -1, 1)}${mark(40, 635, 1, -1)}${mark(1160, 635, -1, -1)}
<text x="130" y="140" font-family="ui-monospace, Menlo, Consolas, monospace" font-size="26" letter-spacing="2" fill="${t.ink}">MADE4BUYERS${issue ? ` · ISSUE ${String(issue).padStart(2, "0")}` : ""}</text>
${ls.map((l, i) => `<text x="126" y="${top + i * size}" font-family="'Arial Black', 'Helvetica Neue', Arial, sans-serif" font-weight="900" font-size="${size}" letter-spacing="-3" fill="${t.ink}">${esc(l)}</text>`).join("\n")}
<text x="130" y="580" font-family="Georgia, 'Times New Roman', serif" font-style="italic" font-size="30" fill="${t.ink}">No photo of this product is shown.</text>
</svg>
`;
}

const dir = path.join(process.cwd(), "public", "placeholders");
mkdirSync(dir, { recursive: true });
CATEGORIES.forEach((c, i) => writeFileSync(path.join(dir, `${c.slug}.svg`), placeholderSvg(c.name, c.slug, i + 1)));
writeFileSync(path.join(dir, "general.svg"), placeholderSvg("Made4Buyers", null, null));
console.log(`wrote ${CATEGORIES.length + 1} placeholders to ${dir}`);
