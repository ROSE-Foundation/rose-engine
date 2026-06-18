/**
 * Honest empty-state for the price chart. ROSE has no price-feed/oracle wired, so the surface NEVER
 * fabricates a price series (CLAUDE.md no-placeholder); it states the dependency instead.
 */
export function ChartPlaceholder(): React.JSX.Element {
  return (
    <div className="flex min-h-[180px] flex-1 items-center justify-center rounded-lg border border-dashed border-border p-6 text-center">
      <div>
        <p className="font-display text-sm text-muted-foreground">Live price chart</p>
        <p className="mt-1 text-xs text-dim">
          Price feed not connected — no market price series available yet.
        </p>
      </div>
    </div>
  );
}
