import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "Contact", alternates: { canonical: "/contact" } };

/** Shows the configured contact address (NEXT_PUBLIC_CONTACT_EMAIL); never invents one. */
export default function Contact() {
  const email = process.env.NEXT_PUBLIC_CONTACT_EMAIL;
  return (
    <main className="section">
      <div className="container" style={{ maxWidth: 800 }}>
        <h1>Contact</h1>
        {email ? (
          <p className="lede">
            Email us at <a href={`mailto:${email}`}>{email}</a>. For corrections to a review, include the review’s address.
          </p>
        ) : (
          <div className="empty" role="status">
            <h2 style={{ fontSize: 22 }}>A contact address hasn’t been published yet.</h2>
            <p>Until it is, see how our reviews and offers work on the about page.</p>
            <div className="btnrow">
              <Link className="btn" href="/about">
                About &amp; methodology
              </Link>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
