import { useState } from 'react';
import { cn } from '../../lib/cn.js';

/** Shorten a tx hash for display while keeping it copyable in full (UX-DR7). */
function shorten(hash: string): string {
  return hash.length <= 14 ? hash : `${hash.slice(0, 8)}…${hash.slice(-4)}`;
}

/**
 * The copy-tx-hash affordance (UX-DR7). Renders an on-chain tx hash in mono with a copy button;
 * when no hash is present (e.g. ledger-only data) it shows an explicit muted state rather than a
 * blank. Copy writes the FULL hash to the clipboard.
 */
export function CopyTxHash({
  hash,
  className,
}: {
  hash?: string | null;
  className?: string;
}): React.JSX.Element {
  const [copied, setCopied] = useState(false);

  if (!hash) {
    return <span className={cn('text-xs text-muted-foreground', className)}>No on-chain tx</span>;
  }

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(hash as string);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <span className={cn('inline-flex items-center gap-2 font-numeric text-xs', className)}>
      <span title={hash}>{shorten(hash)}</span>
      <button
        type="button"
        onClick={() => void copy()}
        aria-label={`Copy transaction hash ${hash}`}
        className="rounded-sm border border-border px-1.5 py-0.5 hover:bg-muted"
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </span>
  );
}
