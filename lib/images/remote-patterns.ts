/**
 * Which remote images go through the Next.js image optimizer (/_next/image), and its settings.
 *
 * Dependency-free on purpose: next.config.ts imports IMAGES_CONFIG from this file (relative path,
 * no "@/" alias), and the client-side <SafeImg> imports the same lists to decide whether a URL
 * may be optimized. Serving through the optimizer means the browser never contacts
 * upload.wikimedia.org / images.pexels.com / a brand site directly (no third-party cookies), gets
 * AVIF/WebP, and gets widths sized to its slot.
 *
 * - Editorial hosts: Wikimedia Commons uploads and Pexels photos (the image pipeline's sources).
 * - Official brand domains: the registrable domains of the commerce brand seed
 *   (data/commerce/brands.seed.json), so a deal card can show the brand's own product photo from
 *   its own site. tests/unit/image-delivery.test.ts fails when a seed brand is missing here.
 *   A brand an admin adds later that is not listed simply gets the neutral placeholder (dealImage
 *   returns null for hosts the optimizer can't fetch): never a direct hotlink.
 *
 * The optimizer is switched on by next.config.ts (`images: IMAGES_CONFIG` + `env: { IMAGE_OPTIMIZER: "on" }`).
 * Until then <SafeImg> keeps the source-CDN srcset (lib/util/image-url.ts) for editorial images.
 */

export type ImageRemotePattern = { protocol: "https"; hostname: string; pathname?: string };

export const EDITORIAL_IMAGE_PATTERNS: readonly ImageRemotePattern[] = [
  { protocol: "https", hostname: "upload.wikimedia.org", pathname: "/wikipedia/**" },
  { protocol: "https", hostname: "images.pexels.com", pathname: "/photos/**" },
];

/** Registrable domains of the commerce brands' official sites (kept in sync with the brand seed by a unit test). */
export const OFFICIAL_IMAGE_DOMAINS: readonly string[] = [
  "1password.com", "adobe.com", "anker.com", "anthropic.com", "apple.com", "asus.com", "atlassian.com", "audio-technica.com", "awaytravel.com",
  "beatsbydre.com", "belkin.com", "benq.com", "bose.com", "breville.com", "brother-usa.com", "canva.com", "casper.com", "corsair.com", "dell.com",
  "dewalt.com", "dji.com", "dropbox.com", "dyson.com", "ecobee.com", "ecoflow.com", "eero.com", "elgato.com", "epson.com", "eufy.com", "fujifilm.com",
  "furbo.com", "garmin.com", "geappliances.com", "github.com", "google.com", "hermanmiller.com", "hisense-usa.com", "hp.com", "hyperx.com",
  "insta360.com", "intel.com", "irobot.com", "jackery.com", "jbl.com", "jetbrains.com", "keychron.com", "kingston.com", "kobo.com", "lg.com",
  "linksys.com", "logitech.com", "meta.com", "microsoft.com", "motorola.com", "netgear.com", "nikonusa.com", "nintendo.com", "nordvpn.com",
  "notion.com", "nvidia.com", "onepeloton.com", "oneplus.com", "openai.com", "ouraring.com", "owletcare.com", "philips-hue.com", "philips.com",
  "playstation.com", "purple.com", "razer.com", "ring.com", "roku.com", "ryobitools.com", "samsonite.com", "samsung.com", "sandisk.com",
  "seagate.com", "sennheiser-hearing.com", "sharkninja.com", "shopify.com", "shure.com", "slack.com", "sonos.com", "squarespace.com",
  "steelseries.com", "synology.com", "tcl.com", "therabody.com", "tp-link.com", "traeger.com", "ui.com", "vercel.com", "vitamix.com", "vizio.com",
  "weber.com", "westerndigital.com", "wix.com", "wyze.com", "xbox.com", "zoom.com",
];

export const IMAGE_REMOTE_PATTERNS: ImageRemotePattern[] = [
  ...EDITORIAL_IMAGE_PATTERNS,
  ...OFFICIAL_IMAGE_DOMAINS.flatMap((d): ImageRemotePattern[] => [
    { protocol: "https", hostname: d },
    { protocol: "https", hostname: `**.${d}` },
  ]),
];

/** Rendered widths: device sizes for full-bleed/hero slots, image sizes for cards and thumbnails. */
export const IMAGE_DEVICE_SIZES = [480, 640, 750, 828, 1080, 1200, 1600, 1920];
export const IMAGE_SIZES = [48, 64, 96, 128, 160, 256, 384];
export const IMAGE_QUALITY = 70;

/** Spread into next.config.ts as `images: IMAGES_CONFIG`. */
export const IMAGES_CONFIG = {
  formats: ["image/avif", "image/webp"] as Array<"image/avif" | "image/webp">,
  remotePatterns: IMAGE_REMOTE_PATTERNS,
  deviceSizes: IMAGE_DEVICE_SIZES,
  imageSizes: IMAGE_SIZES,
  qualities: [IMAGE_QUALITY],
  // Sources rarely change a file in place; a month keeps optimizer work (and quota) low.
  minimumCacheTTL: 2_678_400,
  // Our own placeholders are SVG and are served as-is (never through the optimizer).
  dangerouslyAllowSVG: false,
};

/** True when the optimizer is switched on by next.config.ts (inlined at build time). */
export function imageOptimizerEnabled(): boolean {
  return process.env.IMAGE_OPTIMIZER === "on";
}

function globMatch(pattern: string, value: string): boolean {
  // "**" = any number of path segments / host labels; "*" = one segment / label.
  const re = pattern
    .split(/(\*\*|\*)/)
    .map((part) => (part === "**" ? ".*" : part === "*" ? "[^/.]+" : part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")))
    .join("");
  return new RegExp(`^${re}$`).test(value);
}

/** Whether a URL is served by an allowed remote pattern (https only), whether or not the optimizer is on. */
export function matchesImagePattern(src: string): boolean {
  let u: URL;
  try {
    u = new URL(src);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.username || u.password || (u.port && u.port !== "443")) return false;
  const host = u.hostname.toLowerCase();
  return IMAGE_REMOTE_PATTERNS.some((p) => globMatch(p.hostname, host) && (!p.pathname || globMatch(p.pathname, u.pathname)));
}

/** True for an image on a brand's official domain list (the deal-card source). */
export function onOfficialImageDomain(src: string): boolean {
  let host: string;
  try {
    host = new URL(src).hostname.toLowerCase();
  } catch {
    return false;
  }
  return OFFICIAL_IMAGE_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
}
