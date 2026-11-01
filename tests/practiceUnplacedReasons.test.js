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
  VERIFY_REFUSAL_RULE as EDGE_VERIFY_REFUSAL_RULE,
  VERIFY_REFUSED_REASON as EDGE_VERIFY_REFUSED_REASON,
} from '../supabase/functions/_shared/engines/auto-scheduler-solver.js';
import { COACH_PREFERENCE_TBD_REASON } from '../supabase/functions/_shared/engines/coach-preferences.js';
import {
  PRACTICE_UNPLACED_REASON,
  PRACTICE_WRITER_GATE_RULE,
  VERIFY_REFUSAL_RULE,
  VERIFY_REFUSED_REASON,
  describeUnplacedReason,
} from '../packages/core/src/practiceUnplacedReasons.js';
import { SCHEDULE_TBD_PRACTICE_REASONS } from '../packages/core/src/scheduleTbd.js';
import { practiceLines } from '../frontend/src/utils/practiceLines.js';

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

describe('the server’s check of a browser run: core and the Edge solver say the same things', () => {
  it('the refusal rules are the same list in both directions', () => {
    assert.deepEqual(
      Object.values(EDGE_VERIFY_REFUSAL_RULE).sort(),
      Object.values(VERIFY_REFUSAL_RULE).sort()
    );
    assert.equal(EDGE_VERIFY_REFUSED_REASON, VERIFY_REFUSED_REASON);
  });

  it('every rule the search can name is a rule of the writer’s gate or one of verify’s own', () => {
    // The search and the writer say `capacity`, `reservation`, `length` and `weekday` alike; the
    // others (`coach-conflict`, `must-keep`, `no-live-date` and the three malformed shapes) are checks
    // the writer leaves to verify (declared, plan decision 9).
    const verifyRules = /** @type {string[]} */ (Object.values(VERIFY_REFUSAL_RULE));
    const shared = Object.values(PRACTICE_WRITER_GATE_RULE).filter((rule) =>
      verifyRules.includes(rule)
    );
    assert.deepEqual(shared.sort(), ['capacity', 'length', 'reservation', 'weekday']);
  });

  it('verify-refused is not on the TIME TBD list, which the table’s CHECK spells: the writer labels it not-scheduled-yet', () => {
    assert.ok(
      !(
        /** @type {string[]} */ (Object.values(PRACTICE_UNPLACED_REASON)).includes(
          VERIFY_REFUSED_REASON
        )
      )
    );
    assert.ok(!SCHEDULE_TBD_PRACTICE_REASONS.includes(VERIFY_REFUSED_REASON));
    const tbd = read('supabase/migrations/20261108020000_schedule_tbd.sql');
    assert.ok(!tbd.includes(VERIFY_REFUSED_REASON), 'the CHECK was changed without a migration');
  });

  it('each rule has words for an admin, and the code is never the only thing shown', () => {
    for (const rule of Object.values(VERIFY_REFUSAL_RULE)) {
      const text = describeUnplacedReason(VERIFY_REFUSED_REASON, rule);
      assert.match(text, /^the server's check refused the browser's placement: .{8,}/, rule);
      assert.ok(!text.endsWith(`: ${rule}`), `${rule} is shown as its bare code`);
    }
    // A rule this build does not know is shown as written, never hidden; none is a bare reason.
    assert.equal(
      describeUnplacedReason(VERIFY_REFUSED_REASON, 'new-rule'),
      "the server's check refused the browser's placement: new-rule"
    );
    assert.equal(
      describeUnplacedReason(VERIFY_REFUSED_REASON),
      "the server's check refused the browser's placement"
    );
  });

  it('the run’s per-team lines say the rule for a team whose practice the check refused', () => {
    const lines = practiceLines(
      {
        practices: { teams: [{ teamId: 't1', target: 2, held: 0, placed: 1 }] },
        unassigned: [
          { teamId: 't1', unitId: 't1#2', reason: 'verify-refused', rule: 'capacity', target: 2 },
        ],
      },
      { t1: 'Hawks' }
    );
    assert.deepEqual(lines[0].reasons, [
      "the server's check refused the browser's placement: the slot was already full",
    ]);
  });
});
