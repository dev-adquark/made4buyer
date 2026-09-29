import Link from "next/link";

/** The Made4Buyers mark: a prism that turns one beam of light into the category spectrum. */
export function BrandMark({ size = 30 }: { size?: number }) {
  return (
    <svg className="brand-mark" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="m4b-spectrum" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#00b8f0" />
          <stop offset="0.35" stopColor="#3d5afe" />
          <stop offset="0.6" stopColor="#7c4dff" />
          <stop offset="0.8" stopColor="#e6339e" />
          <stop offset="1" stopColor="#ff6a3d" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="9" fill="#0d0f26" />
      <path d="M3 17.5h8" stroke="#fff" strokeWidth="2" strokeLinecap="round" />
      <path d="M16 6.5l7.5 15h-15z" fill="none" stroke="#fff" strokeWidth="2" strokeLinejoin="round" />
      <path d="M19.5 15.5L29 11M20.5 17.5L29 17.5M19.5 19.5L29 24" stroke="url(#m4b-spectrum)" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}

export function Logo() {
  return (
    <Link className="brand" href="/" aria-label="Made4Buyers home">
      <BrandMark />
      <span aria-hidden="true">Made4Buyers</span>
    </Link>
  );
}
