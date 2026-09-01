/** Shimmering placeholder while a dashboard panel loads its data. */
export function PanelSkeleton({ lines = 6 }: { lines?: number }) {
  return (
    <div className="panel">
      {[...Array(lines)].map((_, i) => (
        <div key={i} className="skeleton skeleton-line" />
      ))}
    </div>
  );
}

/** Shimmering placeholder for the hero stat strip: same grid as the tiles,
 * so the section holds its place instead of popping in when the data lands. */
export function StripSkeleton({ tiles = 18 }: { tiles?: number }) {
  return (
    <div className="hero-strip">
      {[...Array(tiles)].map((_, i) => (
        <div key={i} className="strip-tile">
          <div className="skeleton skeleton-line skeleton-strip-label" />
          <div className="skeleton skeleton-line skeleton-strip-value" />
        </div>
      ))}
    </div>
  );
}
