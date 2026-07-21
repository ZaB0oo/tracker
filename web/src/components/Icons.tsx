/** Small inline SVG icons (replace emojis for a consistent render). */

/** Gold "country #1" medal with ribbon. */
export function MedalIcon({ width = 14, title }: { width?: number; title?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={width}
      height={width}
      className="icon-medal"
      role="img"
      aria-label={title ?? "country #1"}
    >
      {title && <title>{title}</title>}
      <path d="M4.6 0h3.1L6.6 4.6l-3.2-.9z" fill="#ff5d7e" />
      <path d="M11.4 0H8.3l1.1 4.6 3.2-.9z" fill="#7f8cf5" />
      <circle cx="8" cy="9.6" r="5.6" fill="#ffd966" stroke="#c9971f" strokeWidth="1.1" />
      <text
        x="8"
        y="13"
        textAnchor="middle"
        fontSize="9"
        fontWeight="800"
        fill="#7a5a06"
        fontFamily="'Segoe UI', system-ui, sans-serif"
      >
        1
      </text>
    </svg>
  );
}

/** Crosshair ("show the missing maps") icon, follows the text color. */
export function MissingIcon({ width = 15 }: { width?: number }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={width}
      height={width}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="4.6" />
      <line x1="8" y1="0.8" x2="8" y2="3.4" />
      <line x1="8" y1="12.6" x2="8" y2="15.2" />
      <line x1="0.8" y1="8" x2="3.4" y2="8" />
      <line x1="12.6" y1="8" x2="15.2" y2="8" />
    </svg>
  );
}
