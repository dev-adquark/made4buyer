"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { detectTier, type Tier } from "./tier";

const HeroScene = dynamic(() => import("./hero-scene"), { ssr: false, loading: () => null });

const BEAMS = ["#00b8f0", "#3d5afe", "#7c4dff", "#e6339e", "#ff6a3d", "#ffc23d"];

/** Static prism artwork: shown before 3D loads, and instead of it on tier 0. */
function StaticPrism() {
  return (
    <svg className="prism-2d" viewBox="0 0 400 300" aria-hidden="true" focusable="false">
      <defs>
        {BEAMS.map((c, i) => (
          <linearGradient key={c} id={`sb${i}`} x1="0" x2="1">
            <stop offset="0" stopColor={c} stopOpacity="1" />
            <stop offset="1" stopColor={c} stopOpacity="0" />
          </linearGradient>
        ))}
        <linearGradient id="sbin" x1="0" x2="1">
          <stop offset="0" stopColor="#fff" stopOpacity="0" />
          <stop offset="1" stopColor="#fff" stopOpacity="1" />
        </linearGradient>
      </defs>
      <path d="M0 162 L150 154" stroke="url(#sbin)" strokeWidth="5" strokeLinecap="round" />
      {BEAMS.map((c, i) => (
        <path key={c} d={`M205 150 L400 ${60 + i * 36}`} stroke={`url(#sb${i})`} strokeWidth="9" strokeLinecap="round" opacity="0.9" />
      ))}
      <path d="M178 88 L232 190 L124 190 Z" fill="rgba(232,236,255,0.14)" stroke="#fff" strokeWidth="2.5" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * Chooses the 3D quality tier on the client, lazy-loads three.js only when tier ≥ 1, and
 * otherwise keeps the static prism. Purely decorative (aria-hidden).
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
        <StaticPrism />
      </div>
      {tier !== null && tier > 0 && <HeroScene tier={tier} />}
    </>
  );
}
