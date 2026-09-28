"use client";

import { useState } from "react";

/** Shows/hides the filter panel on small screens. On desktop the panel is always visible. */
export default function FiltersToggle({ target, activeCount }: { target: string; activeCount: number }) {
  const [open, setOpen] = useState(false);
  return (
    <button
      type="button"
      className="btn filters-toggle"
      aria-expanded={open}
      aria-controls={target}
      onClick={() => {
        setOpen((o) => !o);
        document.getElementById(target)?.classList.toggle("open");
      }}
    >
      {open ? "Hide filters" : activeCount ? `Filters (${activeCount} on)` : "Filters"}
    </button>
  );
}
