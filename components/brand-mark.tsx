import Link from "next/link";

/** The wordmark: the "4" set in a solid block, like a page number on a tear-sheet. */
export function Wordmark() {
  return (
    <>
      Made<span className="four">4</span>Buyers
    </>
  );
}

export function Logo() {
  return (
    <Link className="brand" href="/" aria-label="Made4Buyers home">
      <span aria-hidden="true">
        <Wordmark />
      </span>
    </Link>
  );
}
