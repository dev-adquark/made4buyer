"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { detectTier, type Tier } from "./tier";

const HeroScene = dynamic(() => import("./hero-scene"), { ssr: false, loading: () => null });

/**
 * Chooses the 3D quality tier on the client, lazy-loads three.js only when tier ≥ 1, and
 * otherwise keeps the static gradient art. Purely decorative (aria-hidden).
 */
export default function HeroVisual() {
  const [tier, setTier] = useState<Tier | null>(null);
  useEffect(() => {
    const detect = () => setTier(detectTier());
    const idle = (window as Window & { requestIdleCallback?: (cb: () => void) => number }).requestIdleCallback;
    if (idle) idle(detect);
    else setTimeout(detect, 150);
  }, []);
  return (
    <>
      <div className="hero-static-art" aria-hidden="true" data-tier={tier ?? "pending"}>
        <div className="orb" />
      </div>
      {tier !== null && tier > 0 && <HeroScene tier={tier} />}
    </>
  );
}
