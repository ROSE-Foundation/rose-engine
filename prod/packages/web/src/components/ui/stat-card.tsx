import type { ReactNode } from 'react';
import { cn } from '../../lib/cn.js';
import { Card, CardContent } from './card.js';

/** A KPI card: label + `display` figure + optional delta (the Group-NAV hero on the console). */
export function StatCard({
  label,
  figure,
  delta,
  className,
}: {
  label: string;
  figure: ReactNode;
  delta?: ReactNode;
  className?: string;
}): React.JSX.Element {
  return (
    <Card className={className}>
      <CardContent className="flex flex-col gap-2">
        <span className="text-sm text-muted-foreground">{label}</span>
        <span
          className={cn(
            'font-numeric text-[28px] font-semibold leading-tight tracking-tight tabular-nums',
          )}
        >
          {figure}
        </span>
        {delta && <span>{delta}</span>}
      </CardContent>
    </Card>
  );
}
