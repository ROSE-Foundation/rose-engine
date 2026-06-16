import type { HTMLAttributes, TdHTMLAttributes, ThHTMLAttributes } from 'react';
import { cn } from '../../lib/cn.js';

// Square-edged, data-dense tables (DESIGN.md): sticky header via a hairline border, not a shadow.
export function Table({
  className,
  ...props
}: HTMLAttributes<HTMLTableElement>): React.JSX.Element {
  return (
    <div className="w-full overflow-x-auto">
      <table className={cn('w-full border-collapse text-sm', className)} {...props} />
    </div>
  );
}

export function THead({
  className,
  ...props
}: HTMLAttributes<HTMLTableSectionElement>): React.JSX.Element {
  return (
    <thead
      className={cn('sticky top-0 border-b border-border bg-background', className)}
      {...props}
    />
  );
}

export function TBody(props: HTMLAttributes<HTMLTableSectionElement>): React.JSX.Element {
  return <tbody {...props} />;
}

export function TR({
  className,
  ...props
}: HTMLAttributes<HTMLTableRowElement>): React.JSX.Element {
  return <tr className={cn('border-b border-border', className)} {...props} />;
}

export function TH({
  className,
  ...props
}: ThHTMLAttributes<HTMLTableCellElement>): React.JSX.Element {
  return (
    <th
      className={cn(
        'px-[12px] py-[6px] text-left font-medium text-muted-foreground last:text-right',
        className,
      )}
      {...props}
    />
  );
}

export function TD({
  className,
  ...props
}: TdHTMLAttributes<HTMLTableCellElement>): React.JSX.Element {
  return <td className={cn('px-[12px] py-[6px]', className)} {...props} />;
}
