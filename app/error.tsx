"use client";

import Link from "next/link";

/** Route-level error boundary: plain explanation, a retry, and a reference id (never a stack trace). */
export default function RouteError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="section">
      <div className="container" style={{ maxWidth: 720 }}>
        <div className="error-panel" role="alert">
          <h1 style={{ fontSize: 32, marginTop: 0 }}>This page couldn’t load</h1>
          <p>Something went wrong while loading this page. It may be a temporary problem with our data service. Try again, or go back to the home page.</p>
          {error.digest && <p className="small muted">Reference: {error.digest}</p>}
          <div className="btnrow">
            <button className="btn primary" type="button" onClick={() => reset()}>
              Try again
            </button>
            <Link className="btn" href="/">
              Go to home
            </Link>
          </div>
        </div>
      </div>
    </main>
  );
}
