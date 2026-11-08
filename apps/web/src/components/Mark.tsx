// Two stops joined by a line: an event leaving for its endpoint.
export function Mark() {
  return (
    <svg width="24" height="24" viewBox="0 0 26 26" aria-hidden="true">
      <circle cx="4" cy="13" r="3.5" fill="var(--stamp)" />
      <path d="M7.5 13h11" stroke="var(--stamp)" strokeWidth="2.5" />
      <circle
        cx="22"
        cy="13"
        r="3.5"
        fill="none"
        stroke="var(--stamp)"
        strokeWidth="2.5"
      />
    </svg>
  );
}
