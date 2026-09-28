// 8.6 PR 3b PR 6 (writer v3, lock-by-default): the JS halves.
//
// The lock, the unlock gate, the audit, exceptions, the cancel and the
// fingerprint are witnessed in the database by docs/sql/20260929000000_smoke.sql
// (run by scripts/dbharness/run.sh, each claim planted in prove.sh). This file
// covers what the database cannot see:
//   * the practice_exceptions tbd_reason CHECK against the core enum it mirrors;
//   * buildPracticeAssignmentRows' per-assignment effectiveFrom/effectiveUntil;
//   * the Edge passthrough of the repair arguments (a source pin: vitest cannot
//     load the Deno function);
//   * persistPracticeRepair() posting them.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, it, vi } from 'vitest';
import { PRACTICE_TBD_REASON } from '../packages/core/src/practice/index.js';
import { buildPracticeAssignmentRows } from '../packages/core/src/practiceSupabase.js';

vi.mock('../frontend/src/lib/supabaseClient.js', () => ({
  supabase: {
    auth: {
      getSession: async () => ({ data: { session: { access_token: 'token-v3' } } }),
    },
  },
}));

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATION_DIR = path.join(REPO_ROOT, 'supabase/migrations');

/** The migration that creates practice_exceptions LAST, and its text. */
function exceptionsMigration() {
  const defining = readdirSync(MIGRATION_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .filter((name) =>
      readFileSync(path.join(MIGRATION_DIR, name), 'utf8').includes(
        'CREATE TABLE IF NOT EXISTS public.practice_exceptions'
      )
    );
  assert.ok(defining.length > 0, 'no migration creates practice_exceptions');
  return readFileSync(path.join(MIGRATION_DIR, defining[defining.length - 1]), 'utf8');
}

describe('practice_exceptions.tbd_reason CHECK', () => {
  it('admits every PRACTICE_TBD_REASON value, plus exactly the two the plan adds', () => {
    const sql = exceptionsMigration();
    const block = sql.match(/tbd_reason IS NULL OR tbd_reason IN \(([^)]*)\)/);
    assert.ok(block, 'the tbd_reason CHECK was not found; this test is stale');
    const allowed = new Set([...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]));
    const core = /** @type {string[]} */ (Object.values(PRACTICE_TBD_REASON));
    // Meta-assertion: the enum and the parse both matched something.
    assert.ok(core.length >= 4 && allowed.size >= 4, 'the enum or the CHECK parsed empty');
    for (const reason of core) {
      assert.ok(allowed.has(reason), `the CHECK refuses the core reason "${reason}"`);
    }
    const extra = [...allowed].filter((r) => !core.includes(r)).sort();
    // plan §2 adds `declined`, §4 adds `coach-preference`; nothing else.
    for (const r of extra) {
      assert.ok(['coach-preference', 'declined'].includes(r), `unexpected CHECK value "${r}"`);
    }
  });
});

describe('buildPracticeAssignmentRows per-assignment ranges', () => {
  const slots = [{ id: 'slot-a', effectiveFrom: '2026-09-01', effectiveUntil: '2026-11-30' }];

  it('keeps the slot window when an assignment names no range, with the key set unchanged', () => {
    const [row] = buildPracticeAssignmentRows({
      assignments: [{ teamId: 't1', slotId: 'slot-a' }],
      slots,
    });
    assert.equal(row.effective_date_range, '[2026-09-01,2026-11-30]');
    assert.deepEqual(Object.keys(row).sort(), [
      'effective_date_range',
      'practice_slot_id',
      'run_id',
      'source',
      'team_id',
    ]);
  });

  it('narrows one row to its own window inside the slot, defaulting the missing bound', () => {
    const rows = buildPracticeAssignmentRows({
      assignments: [
        { teamId: 't1', slotId: 'slot-a', effectiveFrom: '2026-10-15' },
        { teamId: 't2', slotId: 'slot-a', effectiveUntil: '2026-10-14' },
        {
          teamId: 't3',
          slotId: 'slot-a',
          effectiveFrom: '2026-10-01',
          effectiveUntil: '2026-10-31',
        },
      ],
      slots,
    });
    assert.deepEqual(
      rows.map((r) => r.effective_date_range),
      ['[2026-10-15,2026-11-30]', '[2026-09-01,2026-10-14]', '[2026-10-01,2026-10-31]']
    );
    for (const row of rows) {
      assert.equal(Object.keys(row).length, 5, 'a per-row range must not add a key');
    }
  });

  it('refuses a range outside the slot window, inverted, or not an ISO date', () => {
    const bad = [
      { effectiveFrom: '2026-08-31' },
      { effectiveUntil: '2026-12-01' },
      { effectiveFrom: '2026-10-10', effectiveUntil: '2026-10-09' },
      { effectiveFrom: '10/15/2026' },
    ];
    for (const window of bad) {
      assert.throws(
        () =>
          buildPracticeAssignmentRows({
            assignments: [{ teamId: 't1', slotId: 'slot-a', ...window }],
            slots,
          }),
        /inside slot|ISO date/,
        JSON.stringify(window)
      );
    }
  });
});

describe('practice-persistence Edge passthrough (source pin)', () => {
  const source = readFileSync(
    path.join(REPO_ROOT, 'supabase/functions/practice-persistence/index.ts'),
    'utf8'
  );

  it('validates `repair` with Zod and hands every argument to the RPC', () => {
    assert.match(source, /repair:\s*PracticeRepairSchema\.optional\(\)/);
    const rpc = source.slice(source.indexOf(".rpc('persist_practice_schedule'"));
    for (const arg of [
      'unlock: repair.unlock',
      'closes: repair.closes',
      'exceptions: repair.exceptions',
      'withdraw_exceptions: repair.withdrawExceptions',
      'base_fingerprint: repair.baseFingerprint',
    ]) {
      assert.ok(rpc.includes(arg), `the RPC call does not pass ${arg}`);
    }
    assert.match(source, /new Date\(\),\s*body\.repair\s*\)/, 'the handler drops body.repair');
    assert.match(source, /teamsTimeTbd:\s*report\.teams_time_tbd/);
  });

  it('sends exactly the v2 argument set when there is no repair body', () => {
    // The Edge deploy can reach production before 20260929000000 does, and a
    // v2 database has only persist_practice_schedule(run_data, assignments,
    // allow_empty): PostgREST refuses a call naming any other argument.
    const start = source.indexOf(".rpc('persist_practice_schedule', {");
    assert.ok(start >= 0, 'the RPC call was not found; this pin is stale');
    const open = source.indexOf('{', start);
    let depth = 0;
    let end = open;
    for (; end < source.length; end += 1) {
      if (source[end] === '{') depth += 1;
      if (source[end] === '}') depth -= 1;
      if (depth === 0) break;
    }
    const argsObject = source.slice(open + 1, end);
    const guarded = argsObject.match(/\.\.\.\(repair\s*\?\s*\{[\s\S]*?\}\s*:\s*\{\}\)/);
    assert.ok(guarded, 'the v3 arguments are not behind a repair-only spread');
    const unconditional = argsObject.replace(guarded[0], '');
    const keys = [...unconditional.matchAll(/^\s*(\w+)\s*:/gm)].map((m) => m[1]).sort();
    assert.deepEqual(keys, ['allow_empty', 'assignments', 'run_data']);
    for (const v3 of [
      'unlock',
      'closes',
      'exceptions',
      'withdraw_exceptions',
      'base_fingerprint',
    ]) {
      assert.ok(guarded[0].includes(`${v3}:`), `${v3} is not sent only with a repair`);
    }
  });
});

describe('persistPracticeRepair', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('posts the snapshot with the repair arguments, and an ordinary save posts none', async () => {
    const bodies = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init) => {
        bodies.push(JSON.parse(init.body));
        return { ok: true, json: async () => ({ status: 'success' }) };
      })
    );
    const { persistPracticeRepair, persistPracticeScheduleReview } =
      await import('../frontend/src/utils/practicePersistenceClient.js');
    const common = {
      assignments: [{ teamId: 't1', slotId: 'slot-a' }],
      slots: [{ id: 'slot-a', effectiveFrom: '2026-09-01', effectiveUntil: '2026-11-30' }],
      runId: undefined,
      runMetadata: { seasonSettingsId: 'season-1' },
    };
    await persistPracticeRepair({
      ...common,
      unlock: [{ assignment_id: 'a1', reason: 'retired' }],
      closes: [{ assignment_id: 'a1', last_day: '2026-10-14' }],
      baseFingerprint: '0123456789abcdef0123456789abcdef',
    });
    await persistPracticeScheduleReview(common);
    assert.equal(bodies.length, 2);
    assert.deepEqual(bodies[0].repair, {
      unlock: [{ assignment_id: 'a1', reason: 'retired' }],
      closes: [{ assignment_id: 'a1', last_day: '2026-10-14' }],
      exceptions: [],
      withdrawExceptions: [],
      baseFingerprint: '0123456789abcdef0123456789abcdef',
    });
    assert.equal(bodies[1].repair, undefined);
    assert.deepEqual(bodies[0].snapshot, bodies[1].snapshot);
  });
});
