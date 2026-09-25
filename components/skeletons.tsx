/** Shimmer skeletons shaped like the real layout, so content doesn't jump when it loads. */
export function CardGridSkeleton({ count = 6 }: { count?: number }) {
  return (
    <ul className="grid" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <li key={i} className="sk-card">
          <div className="skeleton img" />
          <div className="sk-lines">
            <div className="skeleton sk-line w40" />
            <div className="skeleton sk-line w80" />
            <div className="skeleton sk-line" />
            <div className="skeleton sk-line w60" />
          </div>
        </li>
      ))}
    </ul>
  );
}

export function PageSkeleton({ label = "Loading" }: { label?: string }) {
  return (
    <main className="section" aria-busy="true">
      <div className="container">
        <p className="visually-hidden" role="status">
          {label}…
        </p>
        <div className="skeleton sk-line w40" style={{ marginBottom: 14 }} />
        <div className="skeleton sk-title" style={{ marginBottom: 28 }} />
        <CardGridSkeleton />
      </div>
    </main>
  );
}
