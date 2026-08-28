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
