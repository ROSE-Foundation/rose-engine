import { useTheme } from './theme-provider.js';

/** A keyboard-operable light/dark toggle (UX-DR8). Labels its action for screen readers. */
export function ThemeToggle(): React.JSX.Element {
  const { mode, toggle } = useTheme();
  const next = mode === 'dark' ? 'light' : 'dark';
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={`Switch to ${next} mode`}
      className="rounded-md border border-border px-3 py-1.5 text-sm text-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
    >
      <span aria-hidden="true">{mode === 'dark' ? '☾' : '☀'}</span>
      <span className="ml-2">{mode === 'dark' ? 'Dark' : 'Light'}</span>
    </button>
  );
}
