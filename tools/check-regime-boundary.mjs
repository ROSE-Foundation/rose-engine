#!/usr/bin/env node
// Regime-boundary guard (Story 1.1, Architecture §Enforcement Guidelines).
//
// Asserts the load-bearing two-regime rule: /prod must NEVER import from /throwaway.
// The reverse (/throwaway importing /prod) is explicitly tolerated — throwaway code is
// disposable and may lean on prod, but prod must never take a dependency on disposable
// code. Only /prod source is scanned; /throwaway is never inspected.
//
// Detects static imports, `export ... from`, dynamic `import()`, and `require()` whose
// specifier resolves into /throwaway — either by a literal `throwaway` path segment or by
// a relative path that resolves inside the repo's /throwaway directory. Comments are
// stripped before scanning and static import/export forms must begin a line, so
// commented-out imports and import-like strings do not produce false positives. Backtick
// (template-literal) specifiers are detected. Path-alias resolution is intentionally NOT
// implemented (no tsconfig `paths` aliases exist yet); add it here if/when one is defined.

import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const SCANNED_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.mjs', '.cjs', '.js', '.jsx']);

// Generated / build-output dirs to prune. These contain no UNIQUE hand-written source:
// any real /prod source is also present (and scanned) outside them, so pruning them cannot
// mask a violation. NOTE: `lib` is deliberately NOT pruned by bare name — `src/lib/` is a
// common hand-written layout, and pruning it would let a /prod source file import
// /throwaway undetected. Vendored deps under prod/contracts/lib are pruned by path below.
const SKIP_DIRS = new Set(['node_modules', '.git', '.turbo', 'dist', 'out', 'cache', 'coverage']);

// Vendored third-party trees (Foundry libs), pruned by path relative to rootDir.
const VENDORED_DIRS = ['prod/contracts/lib'];

// Static module forms must begin a line (after optional indentation) — real import/export
// statements always do, which eliminates matches inside string literals.
const STATIC_PATTERNS = [
  /^\s*import\s+[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/gm, // import ... from '...'
  /^\s*export\s+[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/gm, // export ... from '...'
  /^\s*import\s*['"]([^'"]+)['"]/gm, // bare side-effect import '...'
];

// Call forms can appear mid-expression; accept single/double/backtick quotes.
const CALL_PATTERNS = [
  /\bimport\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g, // dynamic import('...') / import(`...`)
  /\brequire\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g, // require('...') / require(`...`)
];

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '') // block comments
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1'); // line comments (but not `://` in URLs)
}

function listSourceFiles(dir, skipAbsDirs) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      if (skipAbsDirs.has(full)) continue;
      out.push(...listSourceFiles(full, skipAbsDirs));
    } else if (entry.isFile()) {
      const dot = entry.name.lastIndexOf('.');
      if (dot !== -1 && SCANNED_EXTENSIONS.has(entry.name.slice(dot))) {
        out.push(full);
      }
    }
  }
  return out;
}

function extractSpecifiers(source) {
  const cleaned = stripComments(source);
  const specifiers = [];
  for (const pattern of [...STATIC_PATTERNS, ...CALL_PATTERNS]) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(cleaned)) !== null) {
      specifiers.push(match[1]);
    }
  }
  return specifiers;
}

function pathSegments(p) {
  return p.split(/[\\/]/).filter(Boolean);
}

/**
 * @param {{ rootDir?: string }} [opts]
 * @returns {Array<{ file: string, specifier: string }>}
 */
export function scanForRegimeViolations({ rootDir = process.cwd() } = {}) {
  const prodDir = resolve(rootDir, 'prod');
  const throwawayDir = resolve(rootDir, 'throwaway');
  const skipAbsDirs = new Set(VENDORED_DIRS.map((p) => resolve(rootDir, p)));
  const violations = [];

  for (const file of listSourceFiles(prodDir, skipAbsDirs)) {
    let source;
    try {
      source = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const fileDir = join(file, '..');
    for (const specifier of extractSpecifiers(source)) {
      const isRelative = specifier.startsWith('.');
      let isViolation;

      if (isRelative) {
        // Resolve the relative specifier and check whether it lands in /throwaway.
        const resolved = resolve(fileDir, specifier);
        const rel = relative(throwawayDir, resolved);
        isViolation = rel === '' || (!rel.startsWith('..') && !rel.startsWith(`..${sep}`));
      } else {
        // Non-relative (bare/workspace): flag any `throwaway` path segment.
        isViolation = pathSegments(specifier).includes('throwaway');
      }

      if (isViolation) {
        violations.push({ file: relative(rootDir, file), specifier });
      }
    }
  }
  return violations;
}

function main() {
  const rootDir = process.cwd();
  const violations = scanForRegimeViolations({ rootDir });
  if (violations.length === 0) {
    console.log('✅ Regime boundary OK: /prod has no imports from /throwaway.');
    process.exit(0);
  }
  console.error('❌ Regime boundary violation: /prod must never import from /throwaway.\n');
  for (const { file, specifier } of violations) {
    console.error(`  ${file} imports '${specifier}'`);
  }
  console.error(`\n${violations.length} violation(s) found.`);
  process.exit(1);
}

// Run as CLI only when invoked directly (not when imported by tests). Use pathToFileURL so
// the comparison is correct on Windows and on paths containing spaces/special characters.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
