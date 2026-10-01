/** Section header: mono label, display title, optional dek and one action. */
export default function SectionHeader({ id, label, title, children, action, level = 2 }: { id: string; label: string; title: React.ReactNode; children?: React.ReactNode; action?: React.ReactNode; level?: 2 | 3 }) {
  const H = level === 2 ? "h2" : "h3";
  return (
    <div className="sec-head">
      <span className="label muted">{label}</span>
      <H id={id} className="mask-reveal">
        {title}
      </H>
      {action}
      {children && <p>{children}</p>}
    </div>
  );
}
