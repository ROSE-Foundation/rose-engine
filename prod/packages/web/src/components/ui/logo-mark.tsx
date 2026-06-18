import { cn } from '../../lib/cn.js';

/** The ROSE identity mark — a conic long→short→gold gradient chip (DESIGN.md, in lieu of a brand
 *  color). Purely decorative; size + radius come from `className`. */
export function LogoMark({ className }: { className?: string }): React.JSX.Element {
  return (
    <span
      aria-hidden
      className={cn(
        'inline-block rounded-md bg-[conic-gradient(from_200deg,var(--long),var(--short),var(--gold),var(--long))]',
        className,
      )}
    />
  );
}
