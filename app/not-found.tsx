import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "Page not found" };

export default function NotFound() {
  return (
    <main className="section doc-page">
      <div className="narrow">
        <span className="label muted">Error 404</span>
        <h1>Page not found</h1>
        <p className="muted">This page does not exist or is no longer published.</p>
        <div className="btnrow">
          <Link className="btn primary" href="/">
            Back to home
          </Link>
          <Link className="btn" href="/search">
            Search reviews
          </Link>
        </div>
      </div>
    </main>
  );
}
