/** Simple stroked category pictograms (decorative; always paired with a text label). */
const PATHS: Record<string, string> = {
  "security-software": "M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6z M9 12l2 2 4-4",
  "business-software": "M4 8h16v11H4z M9 8V5h6v3 M4 13h16",
  "website-ecommerce": "M3 5h18v14H3z M3 9h18 M6 7h1 M9 7h1",
  "creative-software": "M4 20l4-1 11-11-3-3L5 16z M14 6l3 3",
  laptops: "M5 6h14v9H5z M3 18h18",
  phones: "M8 3h8a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z M11 18h2",
  "ai-tools": "M12 3l1.8 4.6L18.5 9l-4.7 1.5L12 15l-1.8-4.5L5.5 9l4.7-1.4z M18 15l.8 2 2 .8-2 .7-.8 2-.8-2-2-.7 2-.8z",
  "developer-software": "M9 8l-4 4 4 4 M15 8l4 4-4 4 M13 6l-2 12",
  accessories: "M4 9h16v7H4z M7 12h1 M10 12h1 M13 12h1 M16 12h1",
  tablets: "M6 3h12a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z M11 18h2",
  audio: "M5 14v-2a7 7 0 0 1 14 0v2 M4 14h3v5H4z M17 14h3v5h-3z",
  wearables: "M9 3h6v3H9z M9 18h6v3H9z M8 6h8a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1z",
  networking: "M5 16h14v3H5z M8 16l-2-6 M16 16l2-6 M12 16V9 M9 7a4 4 0 0 1 6 0",
  desktops: "M4 4h16v11H4z M9 20h6 M12 15v5",
  "pc-components": "M6 6h12v12H6z M9 9h6v6H9z M9 2v4 M15 2v4 M9 18v4 M15 18v4 M2 9h4 M2 15h4 M18 9h4 M18 15h4",
  monitors: "M3 5h18v11H3z M8 20h8 M12 16v4",
  printers: "M7 3h10v5H7z M5 8h14v8H5z M7 13h10v8H7z",
  "smart-home": "M3 11l9-7 9 7 M5 10v10h14V10 M10 20v-5h4v5",
  cameras: "M4 7h4l2-3h4l2 3h4v12H4z M12 10a3 3 0 1 0 0 6a3 3 0 1 0 0-6",
  gaming: "M6 9h12a3 3 0 0 1 3 3v2a3 3 0 0 1-5 2l-1-1H9l-1 1a3 3 0 0 1-5-2v-2a3 3 0 0 1 3-3z M8 11v3 M6.5 12.5h3 M15 12h.01 M17 13h.01",
  "tv-home-entertainment": "M3 6h18v11H3z M8 21l4-4 4 4",
  "streaming-devices": "M4 8h16v8H4z M10 10l4 2-4 2z",
  "productivity-software": "M5 4h14v16H5z M8 8h8 M8 12h8 M8 16h5",
  "drones-gadgets": "M9 10h6v4H9z M5 5l4 5 M19 5l-4 5 M5 19l4-5 M19 19l-4-5 M3 5h4 M17 5h4 M3 19h4 M17 19h4",
  "automotive-tech": "M5 13l2-6h10l2 6v5H5z M5 13h14 M8 16h.01 M16 16h.01",
  mattresses: "M3 13h18v5H3z M3 18v2 M21 18v2 M5 13v-3a2 2 0 0 1 2-2h4v5",
  furniture: "M6 10h12v5H6z M7 15v5 M17 15v5 M8 10V5h8v5",
  "kitchen-appliances": "M6 3h12v18H6z M6 9h12 M9 6h.01 M10 13h4",
  "home-appliances": "M5 3h14v18H5z M12 14a4 4 0 1 0 0 0.01 M8 6h.01 M11 6h5",
  "fitness-equipment": "M4 9v6 M7 7v10 M17 7v10 M20 9v6 M7 12h10",
  "personal-care": "M9 3h6v4H9z M8 7h8v14H8z M11 11h2",
  "outdoor-garden": "M12 21V11 M12 11c-4 0-6-3-6-7 4 0 6 3 6 7 M12 11c4 0 6-3 6-7-4 0-6 3-6 7",
  "tools-diy": "M14 6l4 4-9 9H5v-4z M13 7l4 4",
  "baby-kids": "M5 12h14l-2 6H7z M9 18v2 M15 18v2 M12 6a3 3 0 1 0 0 0.01",
  "pet-supplies": "M7 9a2 2 0 1 0 0 0.01 M12 6a2 2 0 1 0 0 0.01 M17 9a2 2 0 1 0 0 0.01 M8 17c0-3 2-5 4-5s4 2 4 5c0 2-8 2-8 0",
  "luggage-travel": "M9 4h6v3H9z M5 7h14v13H5z M9 7v13 M15 7v13",
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
