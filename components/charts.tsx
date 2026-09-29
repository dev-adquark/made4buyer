/**
 * Small, dependency-free charts for admin metrics. Every value is also rendered as text
 * (labels + numbers), so nothing relies on colour alone, and each bar has a hover title.
 */

export type BarDatum = { label: string; value: number; tone?: "ok" | "warn" | "error" | "neutral" };

const TONES = { ok: "#0b7f4f", warn: "#c27400", error: "#c21e3f", neutral: "#7f89ad" } as const;

export function BarList({ data, color = "#2b4ff0", unit = "", label }: { data: BarDatum[]; color?: string; unit?: string; label: string }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  const total = data.reduce((n, d) => n + d.value, 0);
  if (!total) return <p className="small muted">Not enough data yet.</p>;
  return (
    <ul className="bar-list" aria-label={label}>
      {data.map((d) => (
        <li key={d.label} className="bar-row" title={`${d.label}: ${d.value}${unit} (${((d.value / total) * 100).toFixed(1)}%)`}>
          <span>{d.label}</span>
          <span className="bar-track" aria-hidden="true">
            <span className="bar-fill" style={{ width: `${(d.value / max) * 100}%`, ["--bar" as string]: d.tone ? TONES[d.tone] : color }} />
          </span>
          <span className="bar-value">
            {d.value}
            {unit}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function Meter({ value, label, note }: { value: number | null; label: string; note: string }) {
  return (
    <div>
      <div className="stat-label">{label}</div>
      <span className="stat-value">{value === null ? "Not enough data yet" : `${(value * 100).toFixed(1)}%`}</span>
      {value !== null && (
        <div className="meter" role="img" aria-label={`${label}: ${(value * 100).toFixed(1)}%`}>
          <span style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }} />
        </div>
      )}
      <div className="stat-note">{note}</div>
    </div>
  );
}
