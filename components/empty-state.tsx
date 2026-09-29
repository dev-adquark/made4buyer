import type { ReactNode } from "react";

export default function EmptyState({ title, children, action, headingLevel = 2 }: { title: string; children?: ReactNode; action?: ReactNode; headingLevel?: 2 | 3 }) {
  const H = headingLevel === 2 ? "h2" : "h3";
  return (
    <div className="empty" role="status">
      <H style={{ fontSize: 22 }}>{title}</H>
      {children && <p>{children}</p>}
      {action && <div className="btnrow">{action}</div>}
    </div>
  );
}
