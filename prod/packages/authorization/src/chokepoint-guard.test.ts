// Story 3.3 / AC-2 — the STATIC (dependency) half of the chokepoint guard.
//
// Proves, by scanning the PROD sources, that no module writes transfer `postings` outside the
// single chokepoint: the ONLY direct `postings`-table writer is the Story-1.6 ledger primitive
// `recordJournalEntry`, and `postTransfer` always routes through it AFTER consulting authorization.
// This is a regression lock (mirrors `tools/check-regime-boundary.mjs`): a future module that adds
// a raw `insert(postings)` bypass fails this test. The runtime half (no-write-on-deny against the
// live DB) lives in `post-transfer.test.ts`.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGES_DIR = join(HERE, '..', '..'); // prod/packages

/** Recursively collect every non-test `.ts` source under the prod packages tree. */
function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      out.push(...collectSourceFiles(full));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

// Strip block comments and full-line `//` comments so an explanatory comment that merely MENTIONS
// the phrase (e.g. "// never do a raw insert(postings)") can't produce a false-positive writer.
// (Trailing `//` after code and `https://` inside strings are intentionally left intact.)
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

/**
 * Match a direct write to the `postings` table. Covers the bare drizzle form `insert(postings)`,
 * the namespace-qualified form `insert(schema.postings)`, an optionally quoted identifier, and raw
 * SQL `INSERT INTO [".]postings`. (A fully aliased import — `insert(p)` — is beyond a static regex;
 * that residual gap is the documented limit of a dependency-scan regression lock, AC-2.)
 */
const DIRECT_POSTINGS_INSERT =
  /\binsert\s*\(\s*(?:[\w$]+\s*\.\s*)?["'`]?postings\b|INSERT\s+INTO\s+["'`]?postings\b/i;

/** Does source TEXT contain a direct postings-table write (comments stripped first)? */
function writesPostingsText(src: string): boolean {
  return DIRECT_POSTINGS_INSERT.test(stripComments(src));
}

/** Does a source FILE contain a direct postings-table write (comments stripped first)? */
function writesPostings(file: string): boolean {
  return writesPostingsText(readFileSync(file, 'utf8'));
}

// The single sanctioned low-level writer of the `postings` table (Story 1.6). Every transfer and
// every issuance posting flows through this one primitive.
const ALLOWED_POSTINGS_WRITER = join('ledger', 'src', 'repositories', 'journal-entries.ts');

describe('chokepoint guard — static / dependency check (AC-2)', () => {
  const sources = collectSourceFiles(PACKAGES_DIR);

  it('scans a non-empty set of PROD sources (guard is not vacuous)', () => {
    expect(sources.length).toBeGreaterThan(10);
  });

  it('the ONLY module performing a direct postings-table insert is the ledger primitive', () => {
    const writers = sources.filter(writesPostings).map((f) => relative(PACKAGES_DIR, f));
    expect(writers).toEqual([ALLOWED_POSTINGS_WRITER]);
  });

  it('@rose/authorization never performs a raw postings insert — it routes through recordJournalEntry', () => {
    const authSources = sources.filter((f) =>
      relative(PACKAGES_DIR, f).startsWith(join('authorization', 'src')),
    );
    for (const f of authSources) {
      expect(writesPostings(f)).toBe(false);
    }
    const postTransfer = readFileSync(
      join(PACKAGES_DIR, 'authorization', 'src', 'post-transfer.ts'),
      'utf8',
    );
    expect(postTransfer).toContain('recordJournalEntry');
  });

  it('the hardened regex catches namespace-qualified and quoted bypass writes (and ignores comments)', () => {
    // Common evasion idioms a future bypass might use — all must be caught.
    expect(DIRECT_POSTINGS_INSERT.test('db.insert(postings)')).toBe(true);
    expect(DIRECT_POSTINGS_INSERT.test('db.insert(schema.postings)')).toBe(true);
    expect(DIRECT_POSTINGS_INSERT.test('tx.execute(sql`INSERT INTO "postings" ...`)')).toBe(true);
    expect(DIRECT_POSTINGS_INSERT.test('INSERT INTO postings (account_id) VALUES ($1)')).toBe(true);
    // A comment that merely mentions the phrase is NOT a writer once comments are stripped.
    expect(writesPostingsText('// danger: never do a raw insert(postings) here')).toBe(false);
    expect(writesPostingsText('/* historical note: used to insert(postings) directly */')).toBe(
      false,
    );
    // ...but real code on the same kind of line still trips it.
    expect(writesPostingsText('await db.insert(postings).values(rows);')).toBe(true);
  });

  it('postTransfer consults authorize() BEFORE the ledger write (source ordering)', () => {
    const src = readFileSync(
      join(PACKAGES_DIR, 'authorization', 'src', 'post-transfer.ts'),
      'utf8',
    );
    const authorizeAt = src.indexOf('.authorize(');
    const writeAt = src.indexOf('recordJournalEntry(');
    expect(authorizeAt).toBeGreaterThan(-1);
    expect(writeAt).toBeGreaterThan(-1);
    expect(authorizeAt).toBeLessThan(writeAt);
  });
});
