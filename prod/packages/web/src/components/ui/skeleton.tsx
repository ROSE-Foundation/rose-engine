import type { HTMLAttributes } from 'react';
import { cn } from '../../lib/cn.js';

/** A cold-load placeholder (DESIGN.md State Patterns — Skeleton rows/cards matching the layout). */
export function Skeleton({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return (
    <div
      className={cn('animate-pulse rounded-md bg-muted', className)}
      aria-hidden="true"
      {...props}
    />
  );
}
