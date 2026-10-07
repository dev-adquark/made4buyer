"use client";

import { useEffect, useState } from "react";

// Client-only flag: false on the server and during the first hydration, true after it.
let hydrated = false;

/**
 * Re-mounts on every navigation, so each client-side navigation arrives with a short, CSS-only
 * entrance. The server-rendered first load is never animated: an `opacity: 0` start state there
 * would hide the hero text until the animation ran (it was delaying the mobile LCP by ~3 s).
 */
export default function Template({ children }: { children: React.ReactNode }) {
  const [enter] = useState(() => hydrated);
  useEffect(() => {
    hydrated = true;
  }, []);
  return <div className={enter ? "page-enter" : undefined}>{children}</div>;
}
