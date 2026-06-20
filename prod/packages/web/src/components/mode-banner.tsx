// The always-visible engine-mode banner (Story 9.6, FR-33, UX-DR4). Rendered GLOBALLY in the Shell so
// every surface carries it: a visitor is never in doubt about what is real vs simulated, and that NO
// real capital moves. It reads `GET /mode` (`useEngineMode`) and renders the honest per-mode text:
//   - faithful  ⇒ "Production-faithful demo — testnet/paper, NO real capital. Mocked: …"
//   - paper     ⇒ its own honest "paper simulation" note (+ what is mocked)
//   - read-only ⇒ its read-only note
// It DEGRADES GRACEFULLY: while loading, and if the endpoint is unreachable, it still renders a safe,
// honest fallback bar (never a blank/ambiguous state) — the banner is ALWAYS present. NO new design
// system: it reuses the existing token classes, is label-bearing (not colour-only, UX-DR8), and is
// unobtrusive (a thin bar) but always visible.
import { cn } from '../lib/cn.js';
import type { EngineMode } from '../lib/contract-types.js';
import { useEngineMode } from '../lib/queries.js';

/** A short label + a longer line per mode (the mocked list is appended from the live report). */
const MODE_PRESENTATION: Record<EngineMode, { label: string; lead: string; accent: string }> = {
  faithful: {
    label: 'Production-faithful demo',
    lead: 'testnet/paper, NO real capital',
    accent: 'text-gold',
  },
  paper: {
    label: 'Paper simulation',
    lead: 'in-process, no testnet, no real funds, no secrets',
    accent: 'text-blue',
  },
  'read-only': {
    label: 'Read-only deployment',
    lead: 'read surfaces only — write flows are not enabled, no capital moves',
    accent: 'text-muted-foreground',
  },
};

/** The shared bar chrome — a thin, unobtrusive strip that is always present across surfaces. */
function Bar({
  accent,
  children,
}: {
  accent: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div
      role="status"
      aria-label="Engine mode"
      className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border bg-muted px-6 py-1.5 text-xs text-muted-foreground"
    >
      <span aria-hidden className={cn('font-numeric', accent)}>
        ●
      </span>
      {children}
    </div>
  );
}

export function ModeBanner(): React.JSX.Element {
  const { data, isError } = useEngineMode();

  // Degrade gracefully: an unreachable endpoint still renders an honest, always-present fallback bar
  // (testnet/paper, no real capital) — never a blank or ambiguous state (UX-DR4).
  if (isError || data === undefined) {
    return (
      <Bar accent="text-muted-foreground">
        <span>
          <span className="font-semibold text-foreground">Demo environment</span> — testnet/paper,
          NO real capital{isError ? ' (engine mode unavailable)' : '…'}
        </span>
      </Bar>
    );
  }

  const p = MODE_PRESENTATION[data.engineMode];
  const mocked = data.mocked.length > 0 ? data.mocked.join('; ') : null;
  return (
    <Bar accent={p.accent}>
      <span>
        <span className={cn('font-semibold', p.accent)}>{p.label}</span> — {p.lead}.
        {mocked ? <span className="text-dim"> Mocked: {mocked}.</span> : null}
      </span>
    </Bar>
  );
}
