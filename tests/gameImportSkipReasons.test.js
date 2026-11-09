/**
 * The closed lists the games import's SQL and core both keep (PR 5, F11 plan "What PR 5 ... must do or avoid", item 3).
 *
 * - **Skip reasons.** A game the file names that the apply does not write carries a reason from a closed list that can
 *   grow by one later (`skipped-scored`, F11-2). The list is ONE constant in core with words for each reason; this test
 *   fails when a reason has no words, and holds the SQL's literal to the constant in both directions, so adding
 *   `skipped-scored` in the migration without the constant (or the constant without words) is red.
 * - **Row refusals.** The SQL's `c_row_refusals` (the reasons a staged row may carry from the file check, and the ones
 *   the apply adds) equals core's `SCHEDULE_IMPORT_ROW_REFUSALS`.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  SCHEDULE_IMPORT_ROW_REFUSALS,
  SCHEDULE_IMPORT_SKIP_REASONS,
  describeScheduleImportSkip,
} from '../packages/core/src/scheduleImport/index.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATION = readdirSync(path.join(REPO, 'supabase/migrations')).find((f) =>
  f.endsWith('_game_import.sql')
);
const SQL = MIGRATION
  ? readFileSync(path.join(REPO, 'supabase/migrations', MIGRATION), 'utf8')
  : '';
/** The text of the apply function only. */
const APPLY = SQL.slice(SQL.indexOf('CREATE FUNCTION public.apply_game_import_job'));

describe('the skip reasons are one constant with words, held to the SQL', () => {
  it('every reason in the list has words an admin can read', () => {
    expect(SCHEDULE_IMPORT_SKIP_REASONS.length).toBeGreaterThan(0);
    for (const reason of SCHEDULE_IMPORT_SKIP_REASONS) {
      const words = describeScheduleImportSkip(reason);
      expect(words.length, reason).toBeGreaterThan(20);
      expect(words, reason).not.toBe(reason);
    }
  });

  it('a reason with no words fails (the check can fail)', () => {
    expect(() => describeScheduleImportSkip('skipped-scored')).toThrow(
      /not a skip reason with words/
    );
    expect(() => describeScheduleImportSkip('')).toThrow();
    // The list a planted reason would join: it has no entry in the words, so it is caught.
    const planted = [...SCHEDULE_IMPORT_SKIP_REASONS, 'skipped-scored'];
    expect(
      planted.filter((reason) => {
        try {
          describeScheduleImportSkip(reason);
          return false;
        } catch {
          return true;
        }
      })
    ).toEqual(['skipped-scored']);
  });

  it('the SQL emits exactly the reasons of the list, and no other skipped-* literal', () => {
    expect(APPLY.length).toBeGreaterThan(1000);
    const literals = [
      ...new Set([...APPLY.matchAll(/'(skipped-[a-z-]+)'/g)].map((m) => m[1])),
    ].sort();
    expect(literals).toEqual([...SCHEDULE_IMPORT_SKIP_REASONS].sort());
  });

  it('CONTROL: a planted literal in the SQL would be found', () => {
    const planted = `${APPLY} SELECT 'skipped-scored';`;
    const literals = [
      ...new Set([...planted.matchAll(/'(skipped-[a-z-]+)'/g)].map((m) => m[1])),
    ].sort();
    expect(literals).not.toEqual([...SCHEDULE_IMPORT_SKIP_REASONS].sort());
  });
});

describe("the row refusals of the SQL equal core's", () => {
  it('c_row_refusals is SCHEDULE_IMPORT_ROW_REFUSALS', () => {
    const m = /c_row_refusals constant text\[\] := ARRAY\[([\s\S]*?)\];/.exec(APPLY);
    expect(m).not.toBeNull();
    const sqlList = [...(m?.[1] ?? '').matchAll(/'([a-z-]+)'/g)].map((x) => x[1]);
    // The reasons the apply raises on its own are in core's list too (it is the one closed list); the file check's
    // `missing-week` stands on both lists.
    expect([...new Set(sqlList)].sort()).toEqual([...new Set(SCHEDULE_IMPORT_ROW_REFUSALS)].sort());
  });

  it('every refusal the apply raises while resolving is one of them', () => {
    const raised = [...new Set([...APPLY.matchAll(/'refused:([a-z-]+)'/g)].map((m) => m[1]))];
    expect(raised.length).toBeGreaterThanOrEqual(6);
    for (const reason of raised) expect(SCHEDULE_IMPORT_ROW_REFUSALS, reason).toContain(reason);
  });
});
