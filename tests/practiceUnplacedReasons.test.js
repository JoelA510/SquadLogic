// @vitest-environment node
/**
 * Phase D PR B: one list of reasons, three spellings, pinned (plan B4).
 *
 * `packages/core/src/practiceUnplacedReasons.js` names why a practice goes unplaced and which rule
 * the practice writer's gate broke. The Edge solver spells the unplaced reasons itself (it cannot
 * import core) and `practice_new_auto_row_refusals` spells the rules in SQL. Each side is compared
 * to core's list in both directions, so a reason added in one place fails here until the others
 * have it. The writer's refusal message and the page's words for it are read from the same lists.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'vitest';

import {
  NOT_ENOUGH_DAYS_REASON,
  NO_LIVE_DATE_REASON,
  PRACTICE_LENGTH_REASON,
} from '../supabase/functions/_shared/engines/auto-scheduler-solver.js';
import { COACH_PREFERENCE_TBD_REASON } from '../supabase/functions/_shared/engines/coach-preferences.js';
import {
  PRACTICE_UNPLACED_REASON,
  PRACTICE_WRITER_GATE_RULE,
} from '../packages/core/src/practiceUnplacedReasons.js';

const read = (file) => readFileSync(path.join(process.cwd(), file), 'utf8');
const MIGRATION = read('supabase/migrations/20261105010000_practices_per_division.sql');
const SOLVER = read('supabase/functions/_shared/engines/auto-scheduler-solver.ts');

describe('the unplaced reasons: core and the Edge solver say the same things', () => {
  it('every Edge constant is a core reason', () => {
    const edge = [
      NOT_ENOUGH_DAYS_REASON,
      NO_LIVE_DATE_REASON,
      PRACTICE_LENGTH_REASON,
      COACH_PREFERENCE_TBD_REASON,
    ];
    for (const reason of edge) {
      assert.ok(
        /** @type {string[]} */ (Object.values(PRACTICE_UNPLACED_REASON)).includes(reason),
        `${reason} is not in core`
      );
    }
  });

  it('every core reason is one the solver can give (its source spells it)', () => {
    for (const reason of Object.values(PRACTICE_UNPLACED_REASON)) {
      assert.ok(
        SOLVER.includes(`'${reason}'`) || reason === COACH_PREFERENCE_TBD_REASON,
        `the solver never spells ${reason}`
      );
    }
    assert.equal(COACH_PREFERENCE_TBD_REASON, PRACTICE_UNPLACED_REASON.COACH_PREFERENCE);
  });
});

describe('the writer gate’s rules: core and the SQL say the same things', () => {
  const helper = MIGRATION.slice(
    MIGRATION.indexOf('CREATE FUNCTION public.practice_new_auto_row_refusals'),
    MIGRATION.indexOf('REVOKE ALL ON FUNCTION public.practice_new_auto_row_refusals')
  );
  const sqlRules = [...helper.matchAll(/'([a-z]+)'::text/g)].map((m) => m[1]);

  it('the helper names exactly the rules core lists, each once', () => {
    assert.ok(helper.length > 500, 'the helper was not found in the migration');
    assert.deepEqual([...sqlRules].sort(), Object.values(PRACTICE_WRITER_GATE_RULE).sort());
  });

  it('the smoke and the pgTAP file each exercise every rule by name', () => {
    const smoke = read('docs/sql/20261105010000_smoke.sql');
    const pgtap = read('supabase/tests/practice_writer_v3.sql');
    for (const rule of Object.values(PRACTICE_WRITER_GATE_RULE)) {
      assert.ok(smoke.includes(`'${rule}'`), `the smoke never names ${rule}`);
      assert.ok(pgtap.includes(`'%${rule}%'`), `the pgTAP file never names ${rule}`);
    }
  });

  it('the writer raises one refusal, P0001, naming each row and its rule', () => {
    assert.match(
      MIGRATION,
      /refusing % new auto practice row\(s\) that break a rule the auto-scheduler keeps: %/
    );
    assert.match(MIGRATION, /USING ERRCODE = 'P0001'/);
  });
});
