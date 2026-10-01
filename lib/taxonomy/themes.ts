/**
 * Category signal colours. Used sparingly, like an editor's highlighter: `from` is the signal
 * (marks, rules, highlights), `ink` is the text-safe shade (≥ 4.5:1 on paper and on `soft`),
 * `soft` is a paper tint. `to`/`glow` are kept for components that blend two tones.
 */
export type CategoryTheme = { from: string; to: string; ink: string; soft: string; glow: string; onSignal: string };

export const THEMES: Record<string, CategoryTheme> = {
  laptops: { from: "#2F4BFF", to: "#2F4BFF", ink: "#2438C9", soft: "#E1E3F2", glow: "rgba(47, 75, 255, 0.28)", onSignal: "#ffffff" },
  phones: { from: "#B6F000", to: "#B6F000", ink: "#3D5600", soft: "#E8EDD0", glow: "rgba(182, 240, 0, 0.35)", onSignal: "#16160f" },
  "ai-tools": { from: "#7A3CFF", to: "#7A3CFF", ink: "#5A22D6", soft: "#E7E0F0", glow: "rgba(122, 60, 255, 0.28)", onSignal: "#ffffff" },
  "developer-software": { from: "#00B8D9", to: "#00B8D9", ink: "#00616F", soft: "#DAEBEB", glow: "rgba(0, 184, 217, 0.3)", onSignal: "#0b1f24" },
  accessories: { from: "#FF6A1A", to: "#FF6A1A", ink: "#A33F00", soft: "#F3E2D4", glow: "rgba(255, 106, 26, 0.3)", onSignal: "#1d0d02" },
  tablets: { from: "#FF5A5F", to: "#FF5A5F", ink: "#B02A31", soft: "#F4DEDA", glow: "rgba(255, 90, 95, 0.3)", onSignal: "#1f0607" },
  audio: { from: "#E5007E", to: "#E5007E", ink: "#A8005C", soft: "#F1DCE4", glow: "rgba(229, 0, 126, 0.26)", onSignal: "#ffffff" },
  wearables: { from: "#00A878", to: "#00A878", ink: "#006247", soft: "#D8EBE1", glow: "rgba(0, 168, 120, 0.28)", onSignal: "#03140e" },
  networking: { from: "#F2B200", to: "#F2B200", ink: "#7A5600", soft: "#F1E7C9", glow: "rgba(242, 178, 0, 0.3)", onSignal: "#1c1500" },
  general: { from: "#18181C", to: "#18181C", ink: "#18181C", soft: "#E3E0D8", glow: "rgba(24, 24, 28, 0.2)", onSignal: "#ffffff" },
};

export function themeFor(slug: string | null | undefined): CategoryTheme {
  return (slug && THEMES[slug]) || THEMES.general;
}

/** Inline CSS custom properties for a themed element. */
export function themeStyle(slug: string | null | undefined): Record<string, string> {
  const t = themeFor(slug);
  return { "--cat": t.from, "--cat-from": t.from, "--cat-to": t.to, "--cat-ink": t.ink, "--cat-soft": t.soft, "--cat-glow": t.glow, "--cat-on": t.onSignal };
}
