import ConfirmButton from "./confirm-button";

type Tone = "ok" | "warn" | "error" | "info" | "neutral";

const TONES: Record<string, Tone> = {
  PUBLISHED: "ok", QUEUED: "info", NEEDS_REVIEW: "warn", UNPUBLISHED: "neutral", REJECTED: "error",
  MATCHED: "ok", NO_MATCH: "warn", STALE: "warn", FAILED: "error", UNAVAILABLE: "neutral", PENDING: "neutral",
  VERIFIED_OK: "ok", REDIRECT_MISMATCH: "error", FORBIDDEN: "error", BLOCKED: "error", TIMEOUT: "warn", INVALID: "error", PROVIDER_ERROR: "warn",
  ENRICHED: "ok", FALLBACK: "warn", VERIFIED: "ok", PROVIDER_ASSERTED: "info", UNVERIFIED: "warn", OWNED_PLACEHOLDER: "neutral",
  COMPLETED: "ok", COMPLETED_WITH_ERRORS: "warn", RUNNING: "info", SKIPPED: "neutral",
  INGESTED: "neutral", NORMALIZED: "info", DUPLICATE: "neutral",
  APPLIED: "ok", PROCESSING: "info", VALIDATED: "info",
  ACCEPTED: "ok", UNREVIEWED: "neutral", READY: "ok", BLOCKED_BY_ENVIRONMENT: "warn", INSUFFICIENT_DATA: "neutral", MEETS_TARGET: "ok", BELOW_TARGET: "error",
  RETRYABLE_FAILURE: "warn", PERMANENT_FAILURE: "error", SUCCEEDED: "ok",
};

export function Badge({ value, tone }: { value: string | null | undefined; tone?: Tone }) {
  const v = value ?? "—";
  const t = tone ?? TONES[v] ?? "neutral";
  return <span className={`badge ${t === "neutral" ? "" : t}`}>{v}</span>;
}

export function Stat({ label, value, note }: { label: string; value: React.ReactNode; note?: React.ReactNode }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <span className="stat-value">{value}</span>
      {note && <div className="stat-note">{note}</div>}
    </div>
  );
}

export function pct(v: number | null | undefined): string {
  return v === null || v === undefined ? "—" : `${(v * 100).toFixed(1)}%`;
}

export function when(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  return date.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

/** A POST form for a single admin action. Hidden fields carry ids; returnTo brings the admin back. */
export function ActionForm({
  action,
  fields,
  label,
  returnTo,
  confirm,
  className = "btn small",
  disabledReason,
}: {
  action: string;
  fields: Record<string, string>;
  label: string;
  returnTo: string;
  confirm?: string;
  className?: string;
  disabledReason?: string;
}) {
  if (disabledReason) {
    return (
      <button type="button" className={className} disabled aria-disabled="true" title={disabledReason}>
        {label}
        <span className="visually-hidden"> (unavailable: {disabledReason})</span>
      </button>
    );
  }
  return (
    <form className="inline-form" action={action} method="post">
      {Object.entries(fields).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      <input type="hidden" name="returnTo" value={returnTo} />
      {confirm ? (
        <ConfirmButton message={confirm} className={className}>
          {label}
        </ConfirmButton>
      ) : (
        <button type="submit" className={className}>
          {label}
        </button>
      )}
    </form>
  );
}

export function Pager({ page, pages, base }: { page: number; pages: number; base: string }) {
  if (pages <= 1) return null;
  const join = base.includes("?") ? "&" : "?";
  return (
    <nav className="pagination" aria-label="Pagination">
      {page > 1 && (
        <a className="btn small" href={`${base}${join}page=${page - 1}`}>
          Previous
        </a>
      )}
      <span className="muted small">
        Page {page} of {pages}
      </span>
      {page < pages && (
        <a className="btn small" href={`${base}${join}page=${page + 1}`}>
          Next
        </a>
      )}
    </nav>
  );
}
