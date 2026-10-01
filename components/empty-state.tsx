import type { ReactNode } from "react";

/** Designed empty state: says what's missing and what happens next. Never filled with fake items. */
export default function EmptyState({ title, children, action, headingLevel = 2, label, compact = false }: { title: string; children?: ReactNode; action?: ReactNode; headingLevel?: 2 | 3; label?: string; compact?: boolean }) {
  const H = headingLevel === 2 ? "h2" : "h3";
  return (
    <div className={`empty${compact ? " compact" : ""}`} role="status">
      {label && <span className="label muted">{label}</span>}
      <H>{title}</H>
      {children && <p>{children}</p>}
      {action && <div className="btnrow">{action}</div>}
    </div>
  );
}
