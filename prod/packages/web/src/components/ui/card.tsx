import type { HTMLAttributes } from 'react';
import { cn } from '../../lib/cn.js';

/** A flat, bordered card — hierarchy from borders + spacing, not shadows (DESIGN.md Elevation). */
export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return (
    <div
      className={cn('rounded-md border border-border bg-card text-card-foreground', className)}
      {...props}
    />
  );
}

export function CardHeader({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return <div className={cn('px-4 pt-4', className)} {...props} />;
}

export function CardContent({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return <div className={cn('p-4', className)} {...props} />;
}
