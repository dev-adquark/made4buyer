/**
 * Visual identity per category. Gradients are decorative; `ink` is the text/icon colour that
 * keeps ≥ 4.5:1 contrast on white and on the category's `soft` tint.
 */
export type CategoryTheme = { from: string; to: string; ink: string; soft: string; glow: string };

export const THEMES: Record<string, CategoryTheme> = {
  laptops: { from: "#00C2E0", to: "#2B59FF", ink: "#0B47A8", soft: "#E3F4FF", glow: "rgba(43, 89, 255, 0.35)" },
  phones: { from: "#A78BFA", to: "#6D28D9", ink: "#5B21B6", soft: "#F1EBFF", glow: "rgba(109, 40, 217, 0.35)" },
  "ai-tools": { from: "#FF4FB3", to: "#B421D6", ink: "#9B1572", soft: "#FFE8F5", glow: "rgba(226, 51, 181, 0.35)" },
  "developer-software": { from: "#34D399", to: "#059669", ink: "#046C4E", soft: "#E2F8EE", glow: "rgba(5, 150, 105, 0.32)" },
  accessories: { from: "#FFB020", to: "#FF5A5F", ink: "#A33A09", soft: "#FFF0E3", glow: "rgba(255, 106, 51, 0.34)" },
  tablets: { from: "#22D3EE", to: "#6366F1", ink: "#3730A3", soft: "#E8ECFF", glow: "rgba(99, 102, 241, 0.32)" },
  audio: { from: "#FF7A90", to: "#E11D48", ink: "#B0123A", soft: "#FFE9EE", glow: "rgba(225, 29, 72, 0.3)" },
  wearables: { from: "#B8F03A", to: "#10B981", ink: "#3D6212", soft: "#EFF9DC", glow: "rgba(16, 185, 129, 0.3)" },
  networking: { from: "#FFD23F", to: "#F97316", ink: "#8A3B06", soft: "#FFF6D9", glow: "rgba(249, 115, 22, 0.3)" },
  general: { from: "#2B59FF", to: "#E6339E", ink: "#2B3FC8", soft: "#ECEFFF", glow: "rgba(43, 89, 255, 0.3)" },
};

export function themeFor(slug: string | null | undefined): CategoryTheme {
  return (slug && THEMES[slug]) || THEMES.general;
}

/** Inline CSS custom properties for a themed element. */
export function themeStyle(slug: string | null | undefined): Record<string, string> {
  const t = themeFor(slug);
  return { "--cat-from": t.from, "--cat-to": t.to, "--cat-ink": t.ink, "--cat-soft": t.soft, "--cat-glow": t.glow };
}
