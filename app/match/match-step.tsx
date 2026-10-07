"use client";

import { useEffect, useState } from "react";

// False on the server and during the first hydration, true after it (same rule as app/template.tsx).
let hydrated = false;

/**
 * One step of the match flow. Each answered step (a client-side navigation) rises in; the
 * server-rendered first load is never animated, because an `opacity: 0` start state hid the
 * question (the page's LCP text) until the animation ran.
 */
export default function MatchStep({ children }: { children: React.ReactNode }) {
  const [enter] = useState(() => hydrated);
  useEffect(() => {
    hydrated = true;
  }, []);
  return <div className={enter ? "match-enter" : undefined}>{children}</div>;
}
