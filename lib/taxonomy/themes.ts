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
  desktops: { from: "#3A6DF0", to: "#3A6DF0", ink: "#1F47B8", soft: "#E0E5F2", glow: "rgba(58, 109, 240, 0.28)", onSignal: "#ffffff" },
  "pc-components": { from: "#D42A22", to: "#D42A22", ink: "#A61F18", soft: "#F3DCD8", glow: "rgba(212, 42, 34, 0.28)", onSignal: "#ffffff" },
  monitors: { from: "#14B8A6", to: "#14B8A6", ink: "#0B6158", soft: "#D8ECE8", glow: "rgba(20, 184, 166, 0.28)", onSignal: "#06201c" },
  printers: { from: "#8B95A7", to: "#8B95A7", ink: "#3F4757", soft: "#E3E4E6", glow: "rgba(139, 149, 167, 0.3)", onSignal: "#12151c" },
  "smart-home": { from: "#22C55E", to: "#22C55E", ink: "#13652F", soft: "#DCEDDF", glow: "rgba(34, 197, 94, 0.28)", onSignal: "#05200f" },
  cameras: { from: "#F59E0B", to: "#F59E0B", ink: "#7E4A00", soft: "#F3E6CC", glow: "rgba(245, 158, 11, 0.3)", onSignal: "#1f1300" },
  gaming: { from: "#A21CAF", to: "#A21CAF", ink: "#86188F", soft: "#EEDCEE", glow: "rgba(162, 28, 175, 0.28)", onSignal: "#ffffff" },
  "tv-home-entertainment": { from: "#4F46E5", to: "#4F46E5", ink: "#3730A3", soft: "#E2E1F2", glow: "rgba(79, 70, 229, 0.28)", onSignal: "#ffffff" },
  "streaming-devices": { from: "#EC4899", to: "#EC4899", ink: "#A3245F", soft: "#F2DEE6", glow: "rgba(236, 72, 153, 0.28)", onSignal: "#24030f" },
  "productivity-software": { from: "#0EA5E9", to: "#0EA5E9", ink: "#075985", soft: "#DBE9F1", glow: "rgba(14, 165, 233, 0.28)", onSignal: "#03202d" },
  "drones-gadgets": { from: "#84CC16", to: "#84CC16", ink: "#3F6212", soft: "#E6EDD2", glow: "rgba(132, 204, 22, 0.3)", onSignal: "#141f02" },
  "automotive-tech": { from: "#64748B", to: "#64748B", ink: "#334155", soft: "#E1E3E6", glow: "rgba(100, 116, 139, 0.3)", onSignal: "#ffffff" },
  mattresses: { from: "#6C8EBF", to: "#6C8EBF", ink: "#2F4C78", soft: "#E0E4EC", glow: "rgba(108, 142, 191, 0.3)", onSignal: "#0b1626" },
  furniture: { from: "#B07D4F", to: "#B07D4F", ink: "#6E4521", soft: "#EDE3D6", glow: "rgba(176, 125, 79, 0.3)", onSignal: "#1d0f03" },
  "kitchen-appliances": { from: "#EF4444", to: "#EF4444", ink: "#A11D1D", soft: "#F3DBD8", glow: "rgba(239, 68, 68, 0.28)", onSignal: "#200404" },
  "home-appliances": { from: "#06B6D4", to: "#06B6D4", ink: "#0A5E6E", soft: "#D8EBEE", glow: "rgba(6, 182, 212, 0.28)", onSignal: "#03202a" },
  "fitness-equipment": { from: "#F97316", to: "#F97316", ink: "#9A3A08", soft: "#F3E0D2", glow: "rgba(249, 115, 22, 0.3)", onSignal: "#1f0b02" },
  "personal-care": { from: "#D946EF", to: "#D946EF", ink: "#86198F", soft: "#EFDDEF", glow: "rgba(217, 70, 239, 0.28)", onSignal: "#22042a" },
  "outdoor-garden": { from: "#16A34A", to: "#16A34A", ink: "#14602F", soft: "#DAEADC", glow: "rgba(22, 163, 74, 0.28)", onSignal: "#03180a" },
  "tools-diy": { from: "#EAB308", to: "#EAB308", ink: "#6E5205", soft: "#F1E8C9", glow: "rgba(234, 179, 8, 0.3)", onSignal: "#1d1500" },
  "baby-kids": { from: "#F472B6", to: "#F472B6", ink: "#9D2463", soft: "#F2DFE7", glow: "rgba(244, 114, 182, 0.28)", onSignal: "#26061a" },
  "pet-supplies": { from: "#8E5F3A", to: "#8E5F3A", ink: "#663F1F", soft: "#ECE2D7", glow: "rgba(142, 95, 58, 0.3)", onSignal: "#ffffff" },
  "luggage-travel": { from: "#0F766E", to: "#0F766E", ink: "#0F5F59", soft: "#D9E8E5", glow: "rgba(15, 118, 110, 0.28)", onSignal: "#ffffff" },
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
