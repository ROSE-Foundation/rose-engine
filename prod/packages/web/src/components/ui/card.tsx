import type { HTMLAttributes } from 'react';
import { cn } from '../../lib/cn.js';

/** A bordered card with a subtle hover lift (12px radius; a restrained translate + stronger hairline
 *  border on hover — hierarchy from borders + spacing, not heavy shadows, per DESIGN.md; cf. the
 *  mocks' card hover). Motion is suppressed under `prefers-reduced-motion`. */
export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return (
    <div
      className={cn(
        'rounded-lg border border-border bg-card text-card-foreground transition-[border-color,transform] hover:-translate-y-0.5 hover:border-border-strong motion-reduce:transition-none motion-reduce:hover:translate-y-0',
        className,
      )}
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
