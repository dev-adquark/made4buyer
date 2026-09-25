"use client";

/** Submit button that asks for confirmation before destructive admin actions. */
export default function ConfirmButton({ message, children, className = "btn small danger" }: { message: string; children: React.ReactNode; className?: string }) {
  return (
    <button
      type="submit"
      className={className}
      onClick={(e) => {
        if (!window.confirm(message)) e.preventDefault();
      }}
    >
      {children}
    </button>
  );
}
