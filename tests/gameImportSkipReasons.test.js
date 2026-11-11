/**
 * The closed lists the games import's SQL and core both keep (PR 5, F11 plan "What PR 5 ... must do or avoid", item 3).
 *
 * - **Skip reasons.** A game the file names that the apply does not write carries a reason from a closed list that can
 *   grow (`skipped-scored` joined it with F11-2, 20261122010000). The list is ONE constant in core with words for each reason; this test
 *   fails when a reason has no words, and holds the SQL's literal to the constant in both directions, so adding
 *   a new `skipped-*` literal in the migration without the constant (or the constant without words) is red.
 * - **Row refusals.** The SQL's `c_row_refusals` (the reasons a staged row may carry from the file check, and the ones
 *   the apply adds) equals core's `SCHEDULE_IMPORT_ROW_REFUSALS`.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  SCHEDULE_IMPORT_APPLY_WARNINGS,
  SCHEDULE_IMPORT_FLAGS,
  SCHEDULE_IMPORT_PARSE_WARNINGS,
  SCHEDULE_IMPORT_RETIRED_ROW_REFUSALS,
  SCHEDULE_IMPORT_ROW_REFUSALS,
  SCHEDULE_IMPORT_STAGED_FLAGS,
  SCHEDULE_IMPORT_SKIP_REASONS,
  describeScheduleImportReason,
  describeScheduleImportSkip,
} from '../packages/core/src/scheduleImport/index.js';
import { GAME_IMPORT_SQL } from './helpers/gameImportSql.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SQL = GAME_IMPORT_SQL;
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
    expect(() => describeScheduleImportSkip('skipped-forfeit')).toThrow(
      /not a skip reason with words/
    );
    expect(() => describeScheduleImportSkip('')).toThrow();
    // The list a planted reason would join: it has no entry in the words, so it is caught.
    const planted = [...SCHEDULE_IMPORT_SKIP_REASONS, 'skipped-forfeit'];
    expect(
      planted.filter((reason) => {
        try {
          describeScheduleImportSkip(reason);
          return false;
        } catch {
          return true;
        }
      })
    ).toEqual(['skipped-forfeit']);
  });

  it('the SQL emits exactly the reasons of the list, and no other skipped-* literal', () => {
    expect(APPLY.length).toBeGreaterThan(1000);
    const literals = [
      ...new Set([...APPLY.matchAll(/'(skipped-[a-z-]+)'/g)].map((m) => m[1])),
    ].sort();
    expect(literals).toEqual([...SCHEDULE_IMPORT_SKIP_REASONS].sort());
  });

  it('CONTROL: a planted literal in the SQL would be found', () => {
    const planted = `${APPLY} SELECT 'skipped-forfeit';`;
    const literals = [
      ...new Set([...planted.matchAll(/'(skipped-[a-z-]+)'/g)].map((m) => m[1])),
    ].sort();
    expect(literals).not.toEqual([...SCHEDULE_IMPORT_SKIP_REASONS].sort());
  });
});

describe('the warnings the apply makes of its own plan are one list with words, held to the SQL', () => {
  it('every one has words, and none is also a refusal or a staged flag', () => {
    expect([...SCHEDULE_IMPORT_APPLY_WARNINGS].sort()).toEqual([
      'game-made-time-tbd',
      'games-swapped',
    ]);
    for (const code of SCHEDULE_IMPORT_APPLY_WARNINGS) {
      expect(describeScheduleImportReason(code).length, code).toBeGreaterThan(20);
      expect(SCHEDULE_IMPORT_ROW_REFUSALS, code).not.toContain(code);
      expect(SCHEDULE_IMPORT_FLAGS, code).not.toContain(code);
    }
  });

  it("the SQL's warning types are core's flags, the two checks, and exactly this list", () => {
    // Every `'type', '<x>'` the apply builds a warning with, and the flags it passes through.
    const built = new Set([...APPLY.matchAll(/'type', '([a-z-]+)'/g)].map((m) => m[1]));
    expect([...built].sort()).toEqual(
      ['field-overlap', 'game-made-time-tbd', 'games-swapped', 'team-double-booked'].sort()
    );
    for (const code of ['time-ambiguous', 'week-differs']) {
      expect(APPLY, code).toContain(`'${code}'`);
      expect(SCHEDULE_IMPORT_FLAGS, code).toContain(code);
    }
  });

  it('CONTROL: a warning the SQL adds without core knowing it would be found', () => {
    const planted = `${APPLY} jsonb_build_object('type', 'games-merged')`;
    const built = new Set([...planted.matchAll(/'type', '([a-z-]+)'/g)].map((m) => m[1]));
    expect(built.has('games-merged')).toBe(true);
    expect(SCHEDULE_IMPORT_APPLY_WARNINGS).not.toContain('games-merged');
  });
});

describe("the row refusals of the SQL equal core's", () => {
  it('c_row_refusals is SCHEDULE_IMPORT_ROW_REFUSALS, plus the two the parse stopped refusing in PR 6 (F5)', () => {
    const m = /c_row_refusals constant text\[\] := ARRAY\[([\s\S]*?)\];/.exec(APPLY);
    expect(m).not.toBeNull();
    const sqlList = [...(m?.[1] ?? '').matchAll(/'([a-z-]+)'/g)].map((x) => x[1]);
    // The reasons the apply raises on its own are in core's list too (it is the one closed list); the file check's
    // `missing-week` stands on both lists.
    // PR 6 has no migration: the SQL still takes `bad-time` and `bad-week` as a staged refusal (a job staged before F5
    // may carry one), and core lists them apart as retired. The next replacement of the function drops them.
    expect([...SCHEDULE_IMPORT_RETIRED_ROW_REFUSALS].sort()).toEqual(['bad-time', 'bad-week']);
    for (const code of SCHEDULE_IMPORT_RETIRED_ROW_REFUSALS)
      expect(SCHEDULE_IMPORT_ROW_REFUSALS).not.toContain(code);
    expect([...new Set(sqlList)].sort()).toEqual(
      [
        ...new Set([...SCHEDULE_IMPORT_ROW_REFUSALS, ...SCHEDULE_IMPORT_RETIRED_ROW_REFUSALS]),
      ].sort()
    );
  });

  it('the staged flags the SQL takes are SCHEDULE_IMPORT_STAGED_FLAGS, the parse warnings among them since 20261122010000', () => {
    const m = /AND r\.flags <@ ARRAY\[([^\]]*)\]/.exec(APPLY);
    expect(m).not.toBeNull();
    const sqlFlags = [...(m?.[1] ?? '').matchAll(/'([a-z-]+)'/g)].map((x) => x[1]);
    expect(sqlFlags.sort()).toEqual([...SCHEDULE_IMPORT_STAGED_FLAGS].sort());
    // The parse's two warnings reach the saved result: the SQL takes them, and says each in words of its own.
    for (const code of SCHEDULE_IMPORT_PARSE_WARNINGS) {
      expect(sqlFlags).toContain(code);
      expect(APPLY).toMatch(new RegExp(`WHEN '${code}' THEN '`));
    }
    // CONTROL: a code that is no staged flag is not in the SQL's list.
    expect(sqlFlags).not.toContain('games-swapped');
  });

  it('every refusal the apply raises while resolving is one of them', () => {
    const raised = [...new Set([...APPLY.matchAll(/'refused:([a-z-]+)'/g)].map((m) => m[1]))];
    expect(raised.length).toBeGreaterThanOrEqual(6);
    for (const reason of raised) expect(SCHEDULE_IMPORT_ROW_REFUSALS, reason).toContain(reason);
  });
});
