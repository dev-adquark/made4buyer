"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Copies a promo code. Uses the async Clipboard API; where that is unavailable or refused (older
 * browsers, insecure contexts) it selects the code's text (`targetId`) so the reader can copy it,
 * and tries the legacy copy command. A polite live region announces "Copied".
 */
export default function CopyCodeButton({ code, targetId, className = "btn small dc-copy" }: { code: string; targetId: string; className?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "selected">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  function selectCode(): boolean {
    const el = document.getElementById(targetId);
    const sel = window.getSelection();
    if (!el || !sel) return false;
    const range = document.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(range);
    try {
      return document.execCommand("copy");
    } catch {
      return false;
    }
  }

  async function copy() {
    let ok = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(code);
        ok = true;
      }
    } catch {
      ok = false;
    }
    if (!ok) ok = selectCode();
    setState(ok ? "copied" : "selected");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), 2500);
  }

  return (
    <>
      <button type="button" className={className} onClick={copy} aria-describedby={targetId} data-state={state}>
        {state === "copied" ? "Copied" : "Copy code"}
      </button>
      <span className="visually-hidden" role="status" aria-live="polite">
        {state === "copied" ? "Copied" : state === "selected" ? "Code selected: press Ctrl+C or Command+C to copy" : ""}
      </span>
    </>
  );
}
