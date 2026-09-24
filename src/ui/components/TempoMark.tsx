interface TempoMarkProps {
  size?: number
  title?: string
}

/** Ritmo's tempo-bars product mark. */
export function TempoMark({size = 20, title}: TempoMarkProps) {
  return (
    <svg
      aria-hidden={title ? undefined : true}
      aria-label={title}
      className="tempo-mark"
      fill="none"
      height={size}
      viewBox="0 0 24 24"
      width={size}
    >
      {title && <title>{title}</title>}
      <rect fill="var(--ritmo-signal)" height="6" rx="1.2" width="4" x="2" y="9" />
      <rect fill="var(--ritmo-signal)" height="18" rx="1.2" width="4" x="9" y="3" />
      <rect fill="var(--ritmo-terracotta)" height="12" rx="1.2" width="4" x="16" y="6" />
    </svg>
  )
}
