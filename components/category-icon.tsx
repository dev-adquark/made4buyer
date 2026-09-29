/** Simple stroked category pictograms (decorative; always paired with a text label). */
const PATHS: Record<string, string> = {
  laptops: "M5 6h14v9H5z M3 18h18",
  phones: "M8 3h8a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z M11 18h2",
  "ai-tools": "M12 3l1.8 4.6L18.5 9l-4.7 1.5L12 15l-1.8-4.5L5.5 9l4.7-1.4z M18 15l.8 2 2 .8-2 .7-.8 2-.8-2-2-.7 2-.8z",
  "developer-software": "M9 8l-4 4 4 4 M15 8l4 4-4 4 M13 6l-2 12",
  accessories: "M4 9h16v7H4z M7 12h1 M10 12h1 M13 12h1 M16 12h1",
  tablets: "M6 3h12a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z M11 18h2",
  audio: "M5 14v-2a7 7 0 0 1 14 0v2 M4 14h3v5H4z M17 14h3v5h-3z",
  wearables: "M9 3h6v3H9z M9 18h6v3H9z M8 6h8a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1z",
  networking: "M5 16h14v3H5z M8 16l-2-6 M16 16l2-6 M12 16V9 M9 7a4 4 0 0 1 6 0",
  general: "M5 5h14v10H5z M9 19h6 M12 15v4",
};

export default function CategoryIcon({ slug, size = 22 }: { slug: string | null | undefined; size?: number }) {
  const d = (slug && PATHS[slug]) || PATHS.general;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d={d} />
    </svg>
  );
}
