// @vitest-environment node
/**
 * Phase D C1 (plans `docs/changes/2026-10-26-coach-preference-rules.md`, "Revised 2026-10-27", and
 * `docs/changes/2026-10-27-phase-d-scheduling.md`, section C and task C1): preference rules are
 * judged PER PRACTICE.
 *
 * A team with two practices a week, whose coach asked for "Tuesday or Thursday" as a must, lands on
 * Tuesday and Thursday; a must that no slot meets gives TIME TBD, one entry per missing practice,
 * naming the rule; keep-current keeps what the team's saved practices hold. These run the REAL loader
 * (over in-memory tables shaped as the store's rows) into the REAL solver, so a rule's path from a row
 * to a placement is the one the Edge Function takes.
 *
 * Every subject set is enumerated from the roster and the fixture's slots, never from the solver's
 * output.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { runPracticeOptimizer } from '../supabase/functions/_shared/engines/auto-scheduler-solver.js';
import { loadCoachPreferenceContext } from '../supabase/functions/_shared/engines/coach-preference-load.js';
import { prepareTeam } from '../supabase/functions/_shared/engines/practice-coaches.js';
import { toDaylightSlot } from '../supabase/functions/_shared/engines/practice-daylight.js';
import { seasonLongDating } from './fixtures/solverDatedCases.js';
import { fakeClient } from './helpers/fakeSupabaseReader.js';

const LOC_A = '00000000-0000-4000-8000-00000000000a';
const LOC_B = '00000000-0000-4000-8000-00000000000b';
const RUN_DATE = '2026-10-01';
const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri'];
const CONFIG = { timeBudgetMs: 20000, maxIterations: 200, seed: 7 };

/** A weekly slot on `day` (0 = Monday 2026-09-07) at `hour`:00, one hour, at venue `loc`. */
function slotRow(id, day, hour, loc = LOC_A) {
  return {
    row: { id, day_of_week: DAYS[day], start_time: `${String(hour).padStart(2, '0')}:00:00`, fields: { location_id: loc } },
    slot: {
      id,
      day: DAYS[day],
      start: new Date(Date.UTC(2026, 8, 7 + day, hour, 0, 0)),
      end: new Date(Date.UTC(2026, 8, 7 + day, hour + 1, 0, 0)),
      capacity: 1,
    },
  };
}

const rule = (id, coachId, teamId, over) => ({
  id,
  coach_id: coachId,
  team_id: teamId,
  level: 'prefer',
  weekdays: null,
  start_minutes: null,
  venue_ids: null,
  keep_weekday: false,
  keep_start: false,
  keep_venue: false,
  coach_priority: null,
  effective_from: null,
  effective_to: null,
  ...over,
});
const assignment = (teamId, coachId) => ({
  id: `tca-${teamId}-${coachId}`,
  team_id: teamId,
  coach_id: coachId,
  effective_from: '2026-08-01',
  effective_to: null,
});

/**
 * Load the rules over `tables` and run the solver for the teams, `perWeek` practices each.
 * @returns {Promise<{ context: any, result: any, slots: any[] }>}
 */
async function scenario({ slots: slotDefs, teams, rules, assignments, perWeek = 2, held = [] }) {
  const slots = slotDefs.map((s) => s.slot);
  const tables = {
    team_coach_assignments: assignments,
    coach_practice_preferences: rules,
    practice_slots: slotDefs.map((s) => s.row),
  };
  const placeable = teams.map((t) => t.id);
  const context = await loadCoachPreferenceContext(fakeClient(tables), fakeClient(tables), {
    organizationId: 'org',
    runDate: RUN_DATE,
    placeableTeamIds: placeable,
    slotIds: slots.map((s) => s.id),
    heldRows: held,
  });
  if (!context.ok) throw new Error(`the fixture's load refused: ${context.message}`);
  const result = await runPracticeOptimizer({
    teams: teams.map((t) => ({ ...prepareTeam(t), practicesPerWeek: perWeek })),
    slots,
    // A saved practice is a locked row on its slot.
    locked: held
      .filter((row) => row.slotId !== null)
      .map((row, i) => ({ assignmentId: `held-${i}`, teamId: row.teamId, slotId: row.slotId })),
    placeableTeamIds: placeable,
    unitsNeeded: Object.fromEntries(
      placeable.map((id) => [id, perWeek - held.filter((row) => row.teamId === id).length])
    ),
    preferenceGate: context.gate,
    dating: seasonLongDating(slots, toDaylightSlot, { timeZone: 'UTC', until: '2026-11-30', liveFrom: '2026-09-01' }),
    config: CONFIG,
  });
  return { context, result, slots };
}

const FIVE_DAYS = () => DAYS.map((_, d) => slotRow(`s-${DAYS[d]}`, d, 17));
const weekdaysOf = (slots, result, teamId) =>
  result.placements
    .filter((p) => p.teamId === teamId)
    .map((p) => slots.find((s) => s.id === p.slotId).day)
    .sort();

describe('rules are judged per practice', () => {
  const teams = [{ id: 't1', division: 'U10', coachId: 'k1' }];
  const assignments = [assignment('t1', 'k1')];

  it('control: with no rule the team takes the first two days it can', async () => {
    const { result, slots } = await scenario({ slots: FIVE_DAYS(), teams, rules: [], assignments });
    assert.deepEqual(weekdaysOf(slots, result, 't1'), ['mon', 'tue']);
  });

  it('{Tue, Thu} as a must with two practices a week lands on Tuesday and Thursday', async () => {
    const { context, result, slots } = await scenario({
      slots: FIVE_DAYS(),
      teams,
      assignments,
      rules: [rule('r-tue-thu', 'k1', 't1', { level: 'must', weekdays: ['TUE', 'THU'] })],
    });
    assert.equal(context.findings.length, 0);
    assert.deepEqual(weekdaysOf(slots, result, 't1'), ['thu', 'tue']);
    assert.deepEqual(result.unassigned, []);
  });

  it('the same must for a team that wants three practices places two and reports the third, naming the rule', async () => {
    const { result, slots } = await scenario({
      slots: FIVE_DAYS(),
      teams,
      assignments,
      perWeek: 3,
      rules: [rule('r-tue-thu', 'k1', 't1', { level: 'must', weekdays: ['TUE', 'THU'] })],
    });
    assert.deepEqual(weekdaysOf(slots, result, 't1'), ['thu', 'tue']);
    assert.equal(result.unassigned.length, 1);
    assert.equal(result.unassigned[0].teamId, 't1');
  });

  it('a must that no slot meets is TIME TBD for every practice, naming the rule, never dropped', async () => {
    const { result } = await scenario({
      slots: FIVE_DAYS(),
      teams,
      assignments,
      rules: [rule('r-sat', 'k1', 't1', { level: 'must', weekdays: ['SAT'] })],
    });
    assert.deepEqual(result.placements, []);
    // One entry per missing practice (the subject set is the team's two practices).
    assert.equal(result.unassigned.length, 2);
    for (const entry of result.unassigned) {
      assert.equal(entry.teamId, 't1');
      assert.equal(entry.reason, 'coach-preference');
      assert.deepEqual(entry.rules, ['r-sat']);
      assert.deepEqual(entry.dimensions, ['weekday']);
    }
  });

  it('two coaches\' musts with nothing in common leave no slot, and both rules are named', async () => {
    const { context, result } = await scenario({
      slots: FIVE_DAYS(),
      teams: [{ id: 't1', division: 'U10', coachId: 'k1' }],
      assignments: [assignment('t1', 'k1'), assignment('t1', 'k2')],
      rules: [
        rule('r-a', 'k1', 't1', { level: 'must', weekdays: ['TUE'] }),
        rule('r-b', 'k2', 't1', { level: 'must', weekdays: ['THU'] }),
      ],
    });
    assert.deepEqual(context.findings.map((f) => [f.code, f.details.ruleIds]), [
      ['PRACTICE_COACH_PREFERENCE_CONFLICT', ['r-a', 'r-b']],
    ]);
    assert.deepEqual(result.placements, []);
    assert.deepEqual(result.unassigned.map((u) => u.rules), [['r-a', 'r-b'], ['r-a', 'r-b']]);
  });

  it('prefer rules steer without refusing: the team takes the days and hours it prefers, no breach left', async () => {
    const slotDefs = [];
    for (let d = 0; d < 5; d += 1) {
      slotDefs.push(slotRow(`s-${DAYS[d]}-17`, d, 17), slotRow(`s-${DAYS[d]}-18`, d, 18));
    }
    const { result, slots } = await scenario({
      slots: slotDefs,
      teams,
      assignments,
      rules: [
        rule('r-days', 'k1', 't1', { level: 'prefer', weekdays: ['WED', 'FRI'] }),
        rule('r-hour', 'k1', 't1', { level: 'prefer', start_minutes: [1080] }),
      ],
    });
    assert.deepEqual(weekdaysOf(slots, result, 't1'), ['fri', 'wed']);
    assert.ok(result.placements.every((p) => p.slotId.endsWith('-18')));
    assert.equal(result.preferKeepBreaches, 0);
  });

  it('a rule for another team, or out of its window on the run date, steers nothing', async () => {
    const { context, result, slots } = await scenario({
      slots: FIVE_DAYS(),
      teams,
      assignments,
      rules: [
        rule('r-other', 'k1', 'some-other-team', { level: 'must', weekdays: ['FRI'] }),
        rule('r-ended', 'k1', 't1', { level: 'must', weekdays: ['FRI'], effective_to: '2026-09-30' }),
        rule('r-later', 'k1', 't1', { level: 'must', weekdays: ['FRI'], effective_from: '2026-10-02' }),
      ],
    });
    assert.equal(context.gate.verdicts.size, 0);
    assert.deepEqual(weekdaysOf(slots, result, 't1'), ['mon', 'tue']);
  });

  it('a rule whose window holds the run date applies', async () => {
    const { result, slots } = await scenario({
      slots: FIVE_DAYS(),
      teams,
      assignments,
      rules: [rule('r-now', 'k1', 't1', { level: 'must', weekdays: ['FRI', 'WED'], effective_from: '2026-10-01', effective_to: '2026-10-01' })],
    });
    assert.deepEqual(weekdaysOf(slots, result, 't1'), ['fri', 'wed']);
  });
});

describe('keep-current keeps what the team\'s saved practices hold', () => {
  const assignments = [assignment('t1', 'k1')];
  const teams = [{ id: 't1', division: 'U10', coachId: 'k1' }];

  it('with a saved Thursday practice at venue A, a keep-venue must puts the second practice at venue A too', async () => {
    const slotDefs = [
      slotRow('s-thu-a', 3, 17, LOC_A), // the saved practice's slot
      slotRow('s-mon-b', 0, 17, LOC_B),
      slotRow('s-tue-a', 1, 17, LOC_A),
    ];
    const { result, slots } = await scenario({
      slots: slotDefs,
      teams,
      assignments,
      perWeek: 2,
      held: [{ teamId: 't1', slotId: 's-thu-a', effectiveDateRange: null }],
      rules: [rule('r-keep', 'k1', 't1', { level: 'must', keep_venue: true })],
    });
    // Venue B would be the first free slot; keeping venue A takes the Tuesday slot there.
    assert.deepEqual(result.placements.map((p) => p.slotId), ['s-tue-a']);
    assert.equal(slots.length, 3);
  });

  it('with nothing saved it does nothing, and says so', async () => {
    const { context, result } = await scenario({
      slots: [slotRow('s-mon-b', 0, 17, LOC_B), slotRow('s-tue-a', 1, 17, LOC_A)],
      teams,
      assignments,
      perWeek: 1,
      rules: [rule('r-keep', 'k1', 't1', { level: 'must', keep_venue: true })],
    });
    assert.deepEqual(result.placements.map((p) => p.slotId), ['s-mon-b']);
    assert.deepEqual(context.findings.map((f) => [f.code, f.details.ruleId, f.details.dimension]), [
      ['PRACTICE_COACH_PREFERENCE_NO_REFERENCE', 'r-keep', 'venue'],
    ]);
  });

  it('a saved practice whose range ended before the run date holds nothing to keep', async () => {
    const { context } = await scenario({
      slots: [slotRow('s-thu-a', 3, 17, LOC_A), slotRow('s-mon-b', 0, 17, LOC_B)],
      teams,
      assignments,
      perWeek: 2,
      held: [{ teamId: 't1', slotId: 's-thu-a', effectiveDateRange: '[2026-09-01,2026-09-30]' }],
      rules: [rule('r-keep', 'k1', 't1', { level: 'must', keep_venue: true })],
    });
    assert.deepEqual(context.findings.map((f) => f.code), ['PRACTICE_COACH_PREFERENCE_NO_REFERENCE']);
  });

  it('a saved practice on a slot the store cannot describe refuses the run', async () => {
    const tables = {
      team_coach_assignments: assignments,
      coach_practice_preferences: [rule('r-keep', 'k1', 't1', { level: 'must', keep_venue: true })],
      practice_slots: [slotRow('s-mon-b', 0, 17, LOC_B).row],
    };
    const context = await loadCoachPreferenceContext(fakeClient(tables), fakeClient(tables), {
      organizationId: 'org',
      runDate: RUN_DATE,
      placeableTeamIds: ['t1'],
      slotIds: ['s-mon-b'],
      heldRows: [{ teamId: 't1', slotId: 's-ghost', effectiveDateRange: null }],
    });
    assert.equal(context.ok, false);
    assert.equal(context.code, 'COACH_PREFERENCES_UNREADABLE');
  });
});
