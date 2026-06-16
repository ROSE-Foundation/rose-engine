import { cn } from '../../lib/cn.js';
import type { EntityCode } from '../../lib/contract-types.js';

/** The console scope: one of the four entities, or the consolidated group. */
export type Scope = EntityCode | 'consolidated';

const ALL_ENTITIES: EntityCode[] = ['VCC', 'HOLDING', 'TRADING_CO', 'COIN_ISSUER'];

/**
 * Scopes the operator surfaces to one entity or the consolidated group (DESIGN.md Entity switcher).
 * The active scope uses the rosé brand token (active nav is a permitted brand use). Keyboard-operable.
 */
export function EntitySwitcher({
  value,
  onChange,
}: {
  value: Scope;
  onChange: (scope: Scope) => void;
}): React.JSX.Element {
  const scopes: Scope[] = ['consolidated', ...ALL_ENTITIES];
  return (
    <div role="group" aria-label="Entity scope" className="inline-flex flex-wrap gap-1">
      {scopes.map((scope) => {
        const active = scope === value;
        return (
          <button
            key={scope}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(scope)}
            className={cn(
              'rounded-md px-3 py-1.5 text-sm focus-visible:outline-2 focus-visible:outline-ring',
              active
                ? 'bg-primary text-primary-foreground'
                : 'border border-border text-foreground hover:bg-muted',
            )}
          >
            {scope === 'consolidated' ? 'Consolidated' : scope}
          </button>
        );
      })}
    </div>
  );
}
