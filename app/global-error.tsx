"use client";

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", padding: 32, color: "#11163a" }}>
        <h1>Made4Buyers is temporarily unavailable</h1>
        <p>The site could not load. Try again in a moment.</p>
        {error.digest && <p>Reference: {error.digest}</p>}
        <button type="button" onClick={() => reset()} style={{ padding: "10px 16px", borderRadius: 10, border: "1px solid #c3cbe2", background: "#fff", cursor: "pointer" }}>
          Try again
        </button>
      </body>
    </html>
  );
}
