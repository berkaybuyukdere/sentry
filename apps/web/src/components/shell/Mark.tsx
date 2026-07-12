/** SENTRY mark — a watchpost: framed field, center element, cardinal ticks. */
export function Mark({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className}>
      <rect x="2.75" y="2.75" width="10.5" height="10.5" stroke="var(--sv-dim, #8A9096)" strokeWidth="1.1" />
      <rect x="6.6" y="6.6" width="2.8" height="2.8" fill="var(--sv-accent, #3B7CFF)" />
      <path d="M8 0.5 V2.75 M8 13.25 V15.5 M0.5 8 H2.75 M13.25 8 H15.5" stroke="var(--sv-faint, #565C61)" strokeWidth="1.1" />
    </svg>
  );
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={className} style={{ letterSpacing: "0.24em", fontWeight: 600, fontSize: 12 }}>
      SENTRY
    </span>
  );
}
