/**
 * The one-time ledger normalisation SQL in
 * docs/operations/migration-ledger-normalisation.md must record exactly the
 * repo files up to and including 20260924000000 -- no more (a genuinely
 * pending migration recorded as applied would never run), no fewer (a missing
 * one would be replayed on production).
 *
 * The expected set is read from the migrations directory, the actual set from
 * the document: two independent sources.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const DOC = 'docs/operations/migration-ledger-normalisation.md';
const CUTOFF = '20260924000000';

function sqlBlock() {
  const doc = readFileSync(DOC, 'utf8');
  const m =
    /<!-- ledger-normalisation-sql:begin -->([\s\S]*?)<!-- ledger-normalisation-sql:end -->/.exec(
      doc
    );
  if (!m) throw new Error(`${DOC}: normalisation SQL markers not found`);
  return m[1];
}

function insertedRows() {
  return [...sqlBlock().matchAll(/^\s*\('([0-9]{14})', '([^']+)'\)/gm)].map(
    ([, version, name]) => `${version}_${name}.sql`
  );
}

describe('ledger normalisation SQL', () => {
  const expected = readdirSync('supabase/migrations')
    .filter((f) => f.split('_')[0] <= CUTOFF)
    .sort();

  it('examined a real directory (meta-assertion)', () => {
    expect(expected).toHaveLength(117);
  });

  it('inserts exactly the repo files up to the cutoff', () => {
    expect(insertedRows()).toEqual(expected);
  });

  it('records the superseded files as applied, so they never run', () => {
    const rows = insertedRows();
    for (const stem of ['20251208000001_seed_data', '20260331000000_definitive_schema']) {
      expect(rows).toContain(`${stem}.sql`);
    }
  });

  it('leaves the genuinely pending migrations out', () => {
    expect(insertedRows().some((f) => f > `${CUTOFF}_zzz`)).toBe(false);
  });

  it('keeps its row-count assertions in step with the insert list', () => {
    const sql = sqlBlock();
    expect(sql).toMatch(new RegExp(`n <> ${expected.length} OR hi <> '${CUTOFF}'`));
    expect(sql).toMatch(/IF n <> 141 THEN/);
  });
});
