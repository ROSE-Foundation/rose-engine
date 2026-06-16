import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanForRegimeViolations } from './check-regime-boundary.mjs';

let root;

function write(relPath, contents) {
  const full = join(root, relPath);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, contents, 'utf8');
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'regime-guard-'));
  mkdirSync(join(root, 'prod', 'packages', 'a'), { recursive: true });
  mkdirSync(join(root, 'throwaway', 'simulator'), { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('scanForRegimeViolations', () => {
  it('flags a /prod static import that climbs into /throwaway', () => {
    write('prod/packages/a/bad.ts', `import { sim } from '../../../throwaway/simulator/run.js';\n`);
    const violations = scanForRegimeViolations({ rootDir: root });
    expect(violations).toHaveLength(1);
    expect(violations[0].file).toContain('prod/packages/a/bad.ts');
    expect(violations[0].specifier).toBe('../../../throwaway/simulator/run.js');
  });

  it('flags a non-relative specifier containing a throwaway segment', () => {
    write('prod/packages/a/bad.ts', `import x from 'throwaway/simulator';\n`);
    const violations = scanForRegimeViolations({ rootDir: root });
    expect(violations).toHaveLength(1);
    expect(violations[0].specifier).toBe('throwaway/simulator');
  });

  it('flags dynamic import() into /throwaway', () => {
    write(
      'prod/packages/a/bad.ts',
      `const m = await import('../../../throwaway/simulator/run.js');\n`,
    );
    const violations = scanForRegimeViolations({ rootDir: root });
    expect(violations).toHaveLength(1);
  });

  it('flags require() into /throwaway', () => {
    write('prod/packages/a/bad.cjs', `const m = require('../../../throwaway/simulator/run.js');\n`);
    const violations = scanForRegimeViolations({ rootDir: root });
    expect(violations).toHaveLength(1);
  });

  it('flags export ... from a throwaway path', () => {
    write('prod/packages/a/bad.ts', `export { sim } from '../../../throwaway/simulator/run.js';\n`);
    const violations = scanForRegimeViolations({ rootDir: root });
    expect(violations).toHaveLength(1);
  });

  it('tolerates a /prod file importing another /prod module', () => {
    write(
      'prod/packages/a/good.ts',
      `import { other } from '../b/other.js';\nimport y from '@rose/shared';\n`,
    );
    const violations = scanForRegimeViolations({ rootDir: root });
    expect(violations).toHaveLength(0);
  });

  it('tolerates a /throwaway file importing from /prod (reverse direction)', () => {
    write(
      'throwaway/simulator/uses-prod.ts',
      `import { x } from '../../prod/packages/a/good.js';\n`,
    );
    const violations = scanForRegimeViolations({ rootDir: root });
    expect(violations).toHaveLength(0);
  });

  it('returns no violations for a clean prod tree', () => {
    write('prod/packages/a/clean.ts', `export const value = 1;\n`);
    const violations = scanForRegimeViolations({ rootDir: root });
    expect(violations).toHaveLength(0);
  });

  it('still scans hand-written source under a src/lib directory (lib is NOT pruned)', () => {
    write(
      'prod/packages/a/src/lib/leak.ts',
      `import { s } from '../../../../../throwaway/simulator/run.js';\n`,
    );
    const violations = scanForRegimeViolations({ rootDir: root });
    expect(violations).toHaveLength(1);
    expect(violations[0].file).toContain('src/lib/leak.ts');
  });

  it('does NOT flag a commented-out throwaway import (line comment)', () => {
    write(
      'prod/packages/a/c.ts',
      `// import { s } from '../../../throwaway/simulator/old.js';\nexport const value = 1;\n`,
    );
    const violations = scanForRegimeViolations({ rootDir: root });
    expect(violations).toHaveLength(0);
  });

  it('does NOT flag a throwaway import inside a block comment', () => {
    write(
      'prod/packages/a/c.ts',
      `/*\n import { s } from '../../../throwaway/simulator/old.js';\n*/\nexport const value = 1;\n`,
    );
    const violations = scanForRegimeViolations({ rootDir: root });
    expect(violations).toHaveLength(0);
  });

  it('does NOT flag an import-like string literal', () => {
    write(
      'prod/packages/a/c.ts',
      `export const doc = "see import x from 'throwaway/simulator'";\n`,
    );
    const violations = scanForRegimeViolations({ rootDir: root });
    expect(violations).toHaveLength(0);
  });

  it('flags a backtick (template-literal) dynamic import into /throwaway', () => {
    write(
      'prod/packages/a/c.ts',
      'const m = await import(`../../../throwaway/simulator/run.js`);\n',
    );
    const violations = scanForRegimeViolations({ rootDir: root });
    expect(violations).toHaveLength(1);
  });

  it('does not scan vendored deps under prod/contracts/lib', () => {
    write(
      'prod/contracts/lib/some-dep/index.js',
      `import x from '../../../../throwaway/simulator/run.js';\n`,
    );
    const violations = scanForRegimeViolations({ rootDir: root });
    expect(violations).toHaveLength(0);
  });
});
