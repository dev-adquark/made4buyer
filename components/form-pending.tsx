"use client";

import { useEffect } from "react";

/**
 * Loading state for every admin mutation form: on submit, the submitting button becomes
 * busy (aria-busy + spinner) and further submits are blocked until the page responds.
 */
export default function FormPending() {
  useEffect(() => {
    const onSubmit = (e: SubmitEvent) => {
      const form = e.target as HTMLFormElement;
      if (e.defaultPrevented || (form.method ?? "").toLowerCase() !== "post") return;
      if (form.dataset.pending === "1") {
        e.preventDefault();
        return;
      }
      form.dataset.pending = "1";
      const btn = (e.submitter as HTMLButtonElement | null) ?? form.querySelector<HTMLButtonElement>("button[type=submit]");
      if (btn) {
        btn.setAttribute("aria-busy", "true");
        btn.dataset.label = btn.textContent ?? "";
      }
      // Downloads/new tabs don't navigate away: release after a while.
      setTimeout(() => {
        delete form.dataset.pending;
        btn?.removeAttribute("aria-busy");
      }, 60_000);
    };
    document.addEventListener("submit", onSubmit);
    const onShow = () => document.querySelectorAll("form[data-pending]").forEach((f) => delete (f as HTMLFormElement).dataset.pending);
    window.addEventListener("pageshow", onShow);
    return () => {
      document.removeEventListener("submit", onSubmit);
      window.removeEventListener("pageshow", onShow);
    };
  }, []);
  return null;
}
