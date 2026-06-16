import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

/** The two first-class color modes (DESIGN.md — both light and dark are first-class). */
export type ThemeMode = 'light' | 'dark';

const STORAGE_KEY = 'rose-theme';

interface ThemeContextValue {
  readonly mode: ThemeMode;
  toggle: () => void;
  setMode: (mode: ThemeMode) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

/** Resolve the initial mode: a persisted choice wins, else the OS `prefers-color-scheme`. */
function resolveInitialMode(): ThemeMode {
  if (typeof window === 'undefined') return 'light';
  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (stored === 'light' || stored === 'dark') return stored;
  if (typeof window.matchMedia === 'function') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return 'light';
}

/** Persists the operator's light/dark choice and reflects it as a `dark` class on <html>. */
export function ThemeProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [mode, setModeState] = useState<ThemeMode>(resolveInitialMode);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('dark', mode === 'dark');
    window.localStorage.setItem(STORAGE_KEY, mode);
  }, [mode]);

  const value = useMemo<ThemeContextValue>(
    () => ({
      mode,
      setMode: setModeState,
      toggle: () => setModeState((m) => (m === 'dark' ? 'light' : 'dark')),
    }),
    [mode],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/** Access the current theme mode + toggle. Must be used inside a `ThemeProvider`. */
export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within a ThemeProvider');
  return ctx;
}
