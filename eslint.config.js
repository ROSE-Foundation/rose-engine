// ESLint 10 flat config. The architecture tree names `.eslintrc.cjs`, but the current
// ESLint major (10.x) uses flat config as the default and deprecates eslintrc; we adopt
// the current format (Story 1.1 permits this variance). Behavior is equivalent: lint TS
// across the workspace and forbid /prod importing /throwaway (the runtime backstop is
// tools/check-regime-boundary.mjs).
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/.turbo/**',
      '**/coverage/**',
      'prod/contracts/**',
      'throwaway/**',
      '_bmad/**',
      '_bmad-output/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Regime boundary (lint-layer): /prod TS must never import from /throwaway.
    files: ['prod/**/*.{ts,tsx,mts,cts}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/throwaway/**', '**/throwaway', 'throwaway/*'],
              message:
                'Regime boundary violation: /prod must never import from /throwaway. See tools/check-regime-boundary.mjs.',
            },
          ],
        },
      ],
    },
  },
  {
    // Node tooling scripts and config files.
    files: ['tools/**/*.mjs', '*.config.{js,mjs,ts}'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
      },
    },
  },
);
