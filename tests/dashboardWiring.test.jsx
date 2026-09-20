/**
 * Three live defects on the workflow dashboard, and the twin-arm check for
 * each.
 *
 * ## A -- the `loading` OBJECT read as a boolean
 *
 * `useDashboardData` returns `loading` as `{ team, practice, game }`.
 * `WorkflowPage` read it twice as a scalar. `if (loading && !team)` was
 * permanently false (both operands are unconditional object literals), so the
 * `LoadingScreen` behind it had never been seen; and the page meanwhile
 * asserted "Your season hasn't started yet", `0%` and three
 * Pending/Unscheduled/In Progress rows over a fully scheduled season, on
 * every navigation, for as long as the fetches took.
 *
 * ## B -- the practice skeleton nothing could reach
 *
 * `DashboardWorkflow` received the real `loading` object and passed
 * `dashboardLoading={{ practice: false }}` to `PracticeReadinessPanel`, one
 * step below reading `loading.team` correctly for the teaming step.
 *
 * ## C -- the KPI card no applied run could fill
 *
 * The practice apply path wrote `results = { assignments, unassigned,
 * evaluation, optimization }` with no top-level `summary`, while the mapper,
 * the panel and `seed.sql` all treat `results` as the core `practiceMetrics`
 * report. The card therefore rendered from seeded and mock data and was
 * absent for every run an operator actually applied.
 *
 * **Subject sets are taken from the consumer and the producer separately,
 * never from the payload a break would corrupt.** What the panel needs is
 * enumerated from the panel's own source; what the core engine provides is
 * enumerated by calling the engine. The writer's payload is then checked
 * against both. Enumerating either from `buildPracticeRunResults`' output
 * would compare that function against itself.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { evaluatePracticeSchedule } from '@squadlogic/core/practiceMetrics.js';
import { buildPracticeRunResults } from '@squadlogic/core/utils/practiceRunResults.js';
import { mapSchedulerRunToPracticeSummary } from '@squadlogic/core/utils/practiceSummaryMapper.js';
import { mapSchedulerRunToGameSummary } from '@squadlogic/core/utils/gameSummaryMapper.js';
import { evaluatePracticeSchedule as edgeEvaluatePracticeSchedule } from '../supabase/functions/_shared/engines/scoring-engine.js';
import { makeSchedulerRun } from './factories/index.js';
import PracticeReadinessPanel from '../frontend/src/components/PracticeReadinessPanel.jsx';
import GameReadinessPanel from '../frontend/src/components/GameReadinessPanel.jsx';
import { partitionPracticeSlots } from '../frontend/src/pages/PracticeSchedulingPage.jsx';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

/**
 * Code only. Every file in this chain carries long docblocks naming the very
 * fields these scans look for, so a scan that could not tell prose from a
 * live read would force the explanations to be deleted to stay green.
 */
const codeOf = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

const SEASON_TZ = 'America/New_York';

/* ------------------------------------------------------------------ *
 * A schedule the apply path could really produce.
 * ------------------------------------------------------------------ */

function makeScheduleInputs({ teamCount = 6, assignedCount = 4 } = {}) {
  const teams = Array.from({ length: teamCount }, (_, i) => ({
    id: `t${i + 1}`,
    division: i % 2 === 0 ? 'U8' : 'U10',
    coachId: `c${i + 1}`,
  }));
  const slots = [
    {
      id: 's1',
      capacity: 10,
      start: '2026-03-02T22:00:00Z',
      end: '2026-03-02T23:00:00Z',
      day: 'Monday',
    },
  ];
  const assignments = teams
    .slice(0, assignedCount)
    .map((team) => ({ teamId: team.id, slotId: 's1', source: 'auto' }));
  const unassigned = teams
    .slice(assignedCount)
    .map((team) => ({ teamId: team.id, reason: 'no available slot' }));
  return { teams, slots, assignments, unassigned };
}

/** The payload the apply path wrote BEFORE this change, reproduced exactly. */
function legacyResults({ assignments, unassigned, edgeEvaluation }) {
  return { assignments, unassigned, evaluation: edgeEvaluation, optimization: null };
}

/* ================================================================== *
 * C -- the two arms are distinguishable, so "not merged" is checkable
 * ================================================================== */

describe('the core and Edge practice evaluators are different reports', () => {
  it('their top-level key sets and their summary key sets both differ', () => {
    // Without this, every assertion below of the form "the top level is the
    // core report and NOT the Edge one" could pass over two identical
    // objects and prove nothing at all.
    const { teams, slots, assignments, unassigned } = makeScheduleInputs();
    const core = evaluatePracticeSchedule({
      assignments,
      unassigned,
      teams,
      slots,
      schoolDayEnd: undefined,
      timezone: SEASON_TZ,
    });
    const edge = edgeEvaluatePracticeSchedule({ assignments, unassigned, teams, slots });

    expect(Object.keys(core).length).toBe(13);
    expect(Object.keys(edge).length).toBe(6);
    expect(new Set(Object.keys(core))).not.toEqual(new Set(Object.keys(edge)));

    // Both carry a `summary`, which is exactly why hoisting the wrong one
    // would have looked right: the KPI card would have rendered a number.
    expect(typeof core.summary.unassignedTeams).toBe('number');
    expect(typeof edge.summary.unassignedTeams).toBe('number');
    expect(new Set(Object.keys(core.summary))).not.toEqual(new Set(Object.keys(edge.summary)));
    expect(Object.keys(edge.summary)).toContain('coveragePercent');
    expect(Object.keys(core.summary)).not.toContain('coveragePercent');
  });
});

/* ================================================================== *
 * C -- what the panel needs, enumerated from the panel
 * ================================================================== */

describe('the snapshot fields PracticeReadinessPanel reads', () => {
  const PANEL = 'frontend/src/components/PracticeReadinessPanel.jsx';

  /** Every `practiceReadinessSnapshot.<key>` in the panel's live code. */
  function snapshotReadsOf(source) {
    const code = codeOf(source);
    return new Set([...code.matchAll(/practiceReadinessSnapshot\.(\w+)/g)].map((m) => m[1]));
  }

  it('positive control: the extractor finds reads, and the stripper hides prose only', () => {
    const source = read(PANEL);
    expect(source.length).toBeGreaterThan(2000);
    expect(codeOf(source).length).toBeLessThan(source.length); // really stripped

    const reads = snapshotReadsOf(source);
    // A scan returning zero proves nothing: show it matching first.
    expect(reads.size).toBeGreaterThan(0);
    // ...and show it would notice a read that is not there.
    expect(reads.has('venueSaturation')).toBe(false);
    // ...and that a read buried in comments alone is not counted, while one
    // in code beside a comment is.
    expect(snapshotReadsOf('/** practiceReadinessSnapshot.ghost */').size).toBe(0);
    expect(snapshotReadsOf('const x = practiceReadinessSnapshot.real;').has('real')).toBe(true);
  });

  it('the engine report supplies every field the panel reads', () => {
    // Consumer set from the panel's source; producer set by calling the
    // engine. Neither comes from the writer, which is the thing under test.
    const reads = snapshotReadsOf(read(PANEL));
    const { teams, slots, assignments, unassigned } = makeScheduleInputs();
    const report = evaluatePracticeSchedule({
      assignments,
      unassigned,
      teams,
      slots,
      schoolDayEnd: undefined,
      timezone: SEASON_TZ,
    });
    for (const key of reads) {
      expect(Object.keys(report)).toContain(key);
    }
  });

  it('and the payload the apply path now persists supplies them too', () => {
    const reads = snapshotReadsOf(read(PANEL));
    const { teams, slots, assignments, unassigned } = makeScheduleInputs();
    const results = buildPracticeRunResults({
      assignments,
      unassigned,
      teams,
      slots,
      schoolDayEnd: undefined,
      timezone: SEASON_TZ,
    });
    for (const key of reads) {
      expect(Object.keys(results)).toContain(key);
    }
  });

  it('the break: the payload the apply path used to persist supplied NONE of them', () => {
    // This is the defect, reproduced. It is also the proof that the two
    // assertions above can fail -- they are the same loop over the same
    // consumer set against the old writer.
    const reads = snapshotReadsOf(read(PANEL));
    const { teams, slots, assignments, unassigned } = makeScheduleInputs();
    const edge = edgeEvaluatePracticeSchedule({ assignments, unassigned, teams, slots });
    const old = legacyResults({ assignments, unassigned, edgeEvaluation: edge });

    expect(reads.size).toBeGreaterThan(0);
    for (const key of reads) {
      expect(Object.keys(old)).not.toContain(key);
    }
  });
});

/* ================================================================== *
 * C -- writer -> mapper -> panel, end to end
 * ================================================================== */

describe('an applied practice run renders the KPI card', () => {
  function renderApplied({ teamCount, assignedCount }) {
    const { teams, slots, assignments, unassigned } = makeScheduleInputs({
      teamCount,
      assignedCount,
    });
    const results = buildPracticeRunResults({
      assignments,
      unassigned,
      teams,
      slots,
      schoolDayEnd: undefined,
      timezone: SEASON_TZ,
    });
    const run = makeSchedulerRun({ run_type: 'practice', results });
    const mapped = mapSchedulerRunToPracticeSummary(run);
    render(
      <PracticeReadinessPanel
        practiceReadinessSnapshot={mapped.practiceReadinessSnapshot}
        generatedAt={mapped.generatedAt}
      />
    );
    return mapped;
  }

  it('the card shows the engine’s unassignedTeams for a run the apply path produced', () => {
    const mapped = renderApplied({ teamCount: 6, assignedCount: 4 });
    expect(mapped.practiceSummary.unassignedTeams).toBe(2);
    const card = screen.getByLabelText('Manual Actions');
    expect(card.textContent).toContain('2');
  });

  it('positive control: a different run moves the number, so it is not a constant', () => {
    renderApplied({ teamCount: 9, assignedCount: 5 });
    expect(screen.getByLabelText('Manual Actions').textContent).toContain('4');
  });

  it('the break: the same round trip on the OLD payload renders no card at all', () => {
    const { teams, slots, assignments, unassigned } = makeScheduleInputs();
    const edge = edgeEvaluatePracticeSchedule({ assignments, unassigned, teams, slots });
    const run = makeSchedulerRun({
      run_type: 'practice',
      results: legacyResults({ assignments, unassigned, edgeEvaluation: edge }),
    });
    const mapped = mapSchedulerRunToPracticeSummary(run);
    render(<PracticeReadinessPanel practiceReadinessSnapshot={mapped.practiceReadinessSnapshot} />);
    // Meta-assertion: the panel really rendered, so the missing card is a
    // fact about the payload and not about an empty DOM.
    expect(screen.getByText('Practice Readiness')).toBeTruthy();
    expect(screen.queryByLabelText('Manual Actions')).toBeNull();
  });

  it('the reasons list and the data-quality notes arrive too, not just the card', () => {
    const { teams, slots, assignments, unassigned } = makeScheduleInputs();
    const results = buildPracticeRunResults({
      assignments,
      unassigned,
      teams,
      slots,
      schoolDayEnd: undefined,
      timezone: SEASON_TZ,
    });
    const mapped = mapSchedulerRunToPracticeSummary(
      makeSchedulerRun({ run_type: 'practice', results })
    );
    render(<PracticeReadinessPanel practiceReadinessSnapshot={mapped.practiceReadinessSnapshot} />);
    expect(screen.getByText(/no available slot/)).toBeTruthy();
    expect(screen.queryByText('All teams assigned automatically.')).toBeNull();
  });
});

/* ================================================================== *
 * C -- the arms stay labelled and stay apart
 * ================================================================== */

describe('the persisted payload says which arm measured it', () => {
  const build = () => {
    const { teams, slots, assignments, unassigned } = makeScheduleInputs();
    const edge = edgeEvaluatePracticeSchedule({ assignments, unassigned, teams, slots });
    return {
      edge,
      results: buildPracticeRunResults({
        assignments,
        unassigned,
        teams,
        slots,
        timezone: SEASON_TZ,
        edgeEvaluation: edge,
      }),
    };
  };

  it('the top level is the core report and says so', () => {
    const { results } = build();
    expect(results.metricsArm).toBe('core');
    expect(results.metricsUnavailable).toBeUndefined();
  });

  it('the Edge report is kept verbatim under a key naming its producer', () => {
    const { edge, results } = build();
    expect(results.edgeEvaluation).toEqual(edge);
    // ...and is not spread into the top level, which is the #409 confusion.
    expect(results.summary).not.toEqual(edge.summary);
    expect(results).not.toHaveProperty('status');
    expect(results).not.toHaveProperty('issues');
    expect(results).not.toHaveProperty('manualFollowUpResults');
  });

  it('the top-level summary equals the CORE engine’s, field for field', () => {
    const { teams, slots, assignments, unassigned } = makeScheduleInputs();
    const core = evaluatePracticeSchedule({
      assignments,
      unassigned,
      teams,
      slots,
      schoolDayEnd: undefined,
      timezone: SEASON_TZ,
    });
    const { results } = build();
    expect(results.summary).toEqual(core.summary);
  });

  it('a manual apply with no auto-scheduler run still carries a full core report', () => {
    // `handleStageManualAssignment` needs no auto run, so `evaluation` and
    // `unassigned` are empty on that path. Hoisting would have persisted
    // `null`; recomputing measures what is being applied.
    const { teams, slots, assignments } = makeScheduleInputs();
    const results = buildPracticeRunResults({
      assignments,
      teams,
      slots,
      timezone: SEASON_TZ,
      edgeEvaluation: null,
    });
    expect(results.metricsArm).toBe('core');
    expect(results.edgeEvaluation).toBeNull();
    expect(results.summary.unassignedTeams).toBe(2);
  });
});

/* ================================================================== *
 * C -- the stale unassigned list
 * ================================================================== */

describe('the persisted unassigned list describes the schedule being applied', () => {
  const { teams, slots, assignments, unassigned } = makeScheduleInputs({
    teamCount: 6,
    assignedCount: 4,
  });

  it('a team the operator hand-assigned after the run drops out of the list', () => {
    // t5 was unassigned by the scheduler and assigned by hand before Apply.
    const withManual = [...assignments, { teamId: 't5', slotId: 's1', source: 'manual' }];
    const results = buildPracticeRunResults({
      assignments: withManual,
      unassigned,
      teams,
      slots,
      schoolDayEnd: undefined,
      timezone: SEASON_TZ,
    });
    expect(unassigned.map((u) => u.teamId)).toContain('t5');
    expect(results.unassigned.map((u) => u.teamId)).not.toContain('t5');
    expect(results.summary.unassignedTeams).toBe(1);
    // Card and breakdown reconcile, so the panel raises no discrepancy line.
    const reasonsTotal = results.unassignedByReason.reduce((n, r) => n + r.count, 0);
    expect(reasonsTotal).toBe(results.summary.unassignedTeams);
  });

  it('the break: keeping the stale list manufactures the divergence the panel warns about', () => {
    // The unfiltered list is what the old writer stored. Rendered, it makes
    // the panel contradict itself about a schedule that is perfectly fine.
    const withManual = [...assignments, { teamId: 't5', slotId: 's1', source: 'manual' }];
    const core = evaluatePracticeSchedule({
      assignments: withManual,
      unassigned, // stale: still names t5
      teams,
      slots,
      schoolDayEnd: undefined,
      timezone: SEASON_TZ,
    });
    render(<PracticeReadinessPanel practiceReadinessSnapshot={core} />);
    expect(screen.getByText(/Reasons account for 2 teams, but 1 is unassigned/)).toBeTruthy();
  });

  it('a team still without a slot stays in the list', () => {
    const results = buildPracticeRunResults({
      assignments,
      unassigned,
      teams,
      slots,
      schoolDayEnd: undefined,
      timezone: SEASON_TZ,
    });
    expect(results.unassigned.map((u) => u.teamId).sort()).toEqual(['t5', 't6']);
  });
});

/* ================================================================== *
 * C -- an unmeasurable run says so rather than shipping a partial report
 * ================================================================== */

describe('a run whose metrics cannot be computed is labelled, not faked', () => {
  /**
   * A slot row that `partitionPracticeSlots` accepts and `SlotSchema`
   * refuses: `end_time` equal to `start_time` composes two valid instants,
   * so the page keeps it, but the engine requires `end > start`.
   */
  const BAD_ROW = {
    id: 'slot-degenerate',
    day_of_week: 'Monday',
    start_time: '18:00',
    end_time: '18:00',
    valid_from: '2026-03-02',
    valid_until: '2026-05-30',
    capacity: 2,
  };

  it('meta: the row really survives the page’s partition and really breaks the engine', () => {
    // Both halves matter. If the partition dropped it, the catch below would
    // be unreachable production code pinned by a forged test -- the shape
    // CLAUDE.md calls evidence of a bug rather than coverage.
    const { schedulerSlots, unplaceableSlots } = partitionPracticeSlots([BAD_ROW], {
      seasonSetting: { season_start: '2026-03-01', season_end: '2026-05-30' },
      timezone: SEASON_TZ,
    });
    expect(unplaceableSlots).toEqual([]);
    expect(schedulerSlots).toHaveLength(1);

    expect(() =>
      evaluatePracticeSchedule({
        assignments: [],
        teams: [],
        slots: schedulerSlots,
        schoolDayEnd: undefined,
        timezone: SEASON_TZ,
      })
    ).toThrow();
  });

  it('the payload carries the reason, no summary, and the assignments regardless', () => {
    const { schedulerSlots } = partitionPracticeSlots([BAD_ROW], {
      seasonSetting: { season_start: '2026-03-01', season_end: '2026-05-30' },
      timezone: SEASON_TZ,
    });
    const assignments = [{ teamId: 't1', slotId: 'slot-degenerate', source: 'auto' }];
    const results = buildPracticeRunResults({
      assignments,
      teams: [{ id: 't1', division: 'U8' }],
      slots: schedulerSlots,
      timezone: SEASON_TZ,
    });

    expect(results.metricsArm).toBeNull();
    expect(typeof results.metricsUnavailable.reason).toBe('string');
    expect(results.metricsUnavailable.reason.length).toBeGreaterThan(0);
    expect(results.summary).toBeUndefined();
    // The operator's schedule is still persisted; only the measurement is lost.
    expect(results.assignments).toEqual(assignments);
  });

  it('an empty roster against a real schedule is unmeasurable, not perfect', () => {
    // The falsely-perfect case, and the reason the check reads the report's
    // own `assignmentsRead`/`assignmentsCounted` rather than trusting it.
    // `teams` at the call site is `team?.teams` from the dashboard summary,
    // which is empty while that fetch is in flight, after it errors, and on
    // a cold start -- and Apply is guarded only on `canManageSchedule` and a
    // staged edit, so it is reachable in exactly that window.
    const { slots, assignments } = makeScheduleInputs();

    // Meta: the engine really does answer this vacuously, so the guard is
    // covering a live falsehood and not an imagined one.
    const raw = evaluatePracticeSchedule({
      assignments,
      unassigned: [],
      teams: [],
      slots,
      schoolDayEnd: undefined,
      timezone: SEASON_TZ,
    });
    expect(raw.summary.unassignedTeams).toBe(0);
    expect(raw.summary.assignmentRate).toBe(1);
    expect(raw.summary.assignmentsRead).toBe(4);
    expect(raw.summary.assignmentsCounted).toBe(0);

    const results = buildPracticeRunResults({
      assignments,
      teams: [],
      slots,
      timezone: SEASON_TZ,
    });
    expect(results.metricsArm).toBeNull();
    expect(results.summary).toBeUndefined();
    expect(results.metricsUnavailable.reason).toMatch(/None of the 4 applied assignment/);
    expect(results.metricsUnavailable.reason).toMatch(/0 team\(s\)/);
    expect(results.assignments).toEqual(assignments);
  });

  it('negative control: a partly-resolvable schedule still gets a real report', () => {
    // The guard must fire on "nothing resolved", not on "something odd".
    // One unknown team among four leaves three counted, so the run is
    // measured and the card reports the roster it does know.
    const { teams, slots, assignments } = makeScheduleInputs();
    const withGhost = [...assignments.slice(0, 3), { teamId: 'ghost', slotId: 's1' }];
    const results = buildPracticeRunResults({
      assignments: withGhost,
      teams,
      slots,
      timezone: SEASON_TZ,
    });
    expect(results.metricsArm).toBe('core');
    expect(results.metricsUnavailable).toBeUndefined();
    expect(results.summary.assignmentsCounted).toBe(3);
    expect(results.summary.unassignedTeams).toBe(3);
  });

  it('and the panel renders no fabricated card for it', () => {
    const { schedulerSlots } = partitionPracticeSlots([BAD_ROW], {
      seasonSetting: { season_start: '2026-03-01', season_end: '2026-05-30' },
      timezone: SEASON_TZ,
    });
    const results = buildPracticeRunResults({
      assignments: [{ teamId: 't1', slotId: 'slot-degenerate', source: 'auto' }],
      teams: [{ id: 't1', division: 'U8' }],
      slots: schedulerSlots,
      timezone: SEASON_TZ,
    });
    const mapped = mapSchedulerRunToPracticeSummary(
      makeSchedulerRun({ run_type: 'practice', results })
    );
    render(<PracticeReadinessPanel practiceReadinessSnapshot={mapped.practiceReadinessSnapshot} />);
    expect(screen.getByText('Practice Readiness')).toBeTruthy();
    expect(screen.queryByLabelText('Manual Actions')).toBeNull();
  });
});

describe('an unmeasurable run reaches the operator, not just the JSON column', () => {
  const PAGE = 'frontend/src/pages/PracticeSchedulingPage.jsx';

  it('the apply path reads metricsUnavailable back and puts it in the status line', () => {
    // `PracticeReadinessPanel` can only fall SILENT for such a run -- it
    // gates on `summary.unassignedTeams` -- and a silent panel is
    // indistinguishable from a season with nothing to report. So the reason
    // has to surface somewhere a person sees. Pinned at the source: driving
    // the full page to a persisted apply needs the whole Supabase, org,
    // permission and auto-scheduler stack, and a render test that stubbed
    // all of it would be asserting against the stubs.
    const code = codeOf(read(PAGE));
    expect(code.length).toBeGreaterThan(2000);
    // The reason must reach `setStatusMessage`, not merely be computed.
    expect(code).toMatch(/setStatusMessage\([\s\S]{0,400}?metricsUnavailable/);
    expect(code).toMatch(/results\.metricsUnavailable\.reason/);
    // ...and the status line is a live region the operator actually gets.
    expect(code).toMatch(/statusMessage\s*&&/);
    expect(code).toContain('role="status"');
  });

  it('positive control: the matcher would not find it in a page that drops the reason', () => {
    const without =
      'const results = buildPracticeRunResults({});\n' +
      'setApplyStatus("applied");\n' +
      'setStatusMessage(null);\n';
    expect(/setStatusMessage\([\s\S]{0,400}?metricsUnavailable/.test(without)).toBe(false);
    expect(/results\.metricsUnavailable\.reason/.test(without)).toBe(false);
    // ...while the real shape is found, so the pattern is not simply inert.
    const withIt =
      'setStatusMessage(r.metricsUnavailable ? results.metricsUnavailable.reason : null);';
    expect(/setStatusMessage\([\s\S]{0,400}?metricsUnavailable/.test(withIt)).toBe(true);
  });
});

/* ================================================================== *
 * C -- the twin arm: the game apply path
 * ================================================================== */

describe('the game apply path writes the keys its own panel reads', () => {
  const GAME_PAGE = 'frontend/src/pages/GameSchedulingPage.jsx';
  const GAME_PANEL = 'frontend/src/components/GameReadinessPanel.jsx';

  /**
   * The keys named at the top level of the `results:` object literal inside
   * `persistReviewedAssignments`. Taken from the writer's source because
   * there is no exported builder on that arm to call.
   */
  function persistedResultKeys(source) {
    const code = codeOf(source);
    const at = code.indexOf('const result = await persistGameScheduleReview(');
    if (at < 0) return null;
    const start = code.indexOf('results: {', at);
    if (start < 0) return null;
    // Walk braces from the opening one so nested literals do not end it early.
    const open = code.indexOf('{', start);
    let depth = 0;
    let end = open;
    for (let i = open; i < code.length; i += 1) {
      if (code[i] === '{') depth += 1;
      else if (code[i] === '}') {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    const body = code.slice(open + 1, end);
    const keys = new Set();
    let depth2 = 0;
    for (const line of body.split('\n')) {
      const match = depth2 === 0 ? line.match(/^\s*(\w+)\s*:/) : null;
      if (match) keys.add(match[1]);
      for (const ch of line) {
        if (ch === '{' || ch === '[' || ch === '(') depth2 += 1;
        if (ch === '}' || ch === ']' || ch === ')') depth2 -= 1;
      }
    }
    return keys;
  }

  it('positive control: the extractor finds the literal, and would notice a missing key', () => {
    const keys = persistedResultKeys(read(GAME_PAGE));
    expect(keys).not.toBeNull();
    expect(keys.size).toBeGreaterThan(3);
    // Shown failing: the same extractor over a literal without `summary`.
    const withoutSummary = persistedResultKeys(
      'const result = await persistGameScheduleReview({\n' +
        '  results: {\n    assignments: a,\n    warnings: w,\n  },\n});'
    );
    expect(withoutSummary.has('summary')).toBe(false);
    expect(withoutSummary.has('assignments')).toBe(true);
  });

  it('it writes a top-level summary, which is the key the practice arm was missing', () => {
    expect(persistedResultKeys(read(GAME_PAGE)).has('summary')).toBe(true);
  });

  it('and the other snapshot keys GameReadinessPanel reads', () => {
    const panelReads = new Set(
      [...codeOf(read(GAME_PANEL)).matchAll(/gameReadinessSnapshot\.(\w+)/g)].map((m) => m[1])
    );
    expect(panelReads.size).toBeGreaterThan(0);
    const written = persistedResultKeys(read(GAME_PAGE));
    for (const key of panelReads) {
      expect([...written]).toContain(key);
    }
  });

  it('the game round trip renders its metrics, so the twin arm is whole', () => {
    const results = {
      summary: {
        totalGames: 8,
        scheduledRate: 0.8,
        unscheduledMatchups: 2,
        teamsWithByes: 1,
      },
      assignments: [],
      byes: [],
      unscheduled: [{ weekIndex: 3, matchup: 'A vs B', reason: 'no slot' }],
      sharedSlotUsage: [],
      warnings: [],
    };
    const mapped = mapSchedulerRunToGameSummary(makeSchedulerRun({ run_type: 'game', results }));
    render(
      <GameReadinessPanel
        gameReadinessSnapshot={mapped.gameReadinessSnapshot}
        gameSummary={mapped.gameSummary}
        generatedAt={mapped.generatedAt}
      />
    );
    expect(screen.getByText('Week 3')).toBeTruthy();
    expect(screen.getByText('2')).toBeTruthy();
  });
});

/* ================================================================== *
 * B -- DashboardWorkflow passes the real practice flag
 * ================================================================== */

vi.mock('../frontend/src/hooks/usePermission.js', async () => {
  const { PERMISSIONS } = await import('../frontend/src/constants/permissions.js');
  return { usePermission: () => ({ can: () => true, role: 'admin', PERMISSIONS }) };
});
vi.mock('../frontend/src/components/ImportPanel.jsx', () => ({ default: () => null }));
vi.mock('../frontend/src/components/TeamOverviewPanel.jsx', () => ({ default: () => null }));
vi.mock('../frontend/src/components/teaming/TeamListView.jsx', () => ({ default: () => null }));
vi.mock('../frontend/src/components/TeamPersistencePanel.jsx', () => ({ default: () => null }));
vi.mock('../frontend/src/components/OutputGenerationPanel.jsx', () => ({ default: () => null }));
vi.mock('../frontend/src/components/ui/FeatureGuard.jsx', () => ({
  FeatureGuard: ({ children }) => children,
}));

const { default: DashboardWorkflow } =
  await import('../frontend/src/components/DashboardWorkflow.jsx');

describe('DashboardWorkflow hands PracticeReadinessPanel the live practice flag', () => {
  function renderWorkflow(loading) {
    const { teams, slots, assignments, unassigned } = makeScheduleInputs();
    const snapshot = buildPracticeRunResults({
      assignments,
      unassigned,
      teams,
      slots,
      schoolDayEnd: undefined,
      timezone: SEASON_TZ,
    });
    return render(
      <MemoryRouter>
        <DashboardWorkflow
          loading={loading}
          teamData={{ generatedAt: '2026-01-01T00:00:00Z' }}
          practiceData={{ snapshot, generatedAt: '2026-01-01T00:00:00Z' }}
          gameData={{ snapshot: {}, summary: {} }}
          persistenceSnapshot={null}
          onImport={() => {}}
          importedData={{ totalRows: 5 }}
          controlledActiveStep={4}
          onStepChange={() => {}}
        />
      </MemoryRouter>
    );
  }

  it('shows the panel’s skeleton while the practice fetch is in flight', () => {
    renderWorkflow({ team: false, practice: true, game: false });
    // The skeleton is the panel's early return: no heading, no card.
    expect(screen.queryByText('Practice Readiness')).toBeNull();
    expect(screen.queryByLabelText('Manual Actions')).toBeNull();
    // Meta-assertion: the step really rendered, so the absence is about the
    // panel and not about an unmounted step.
    expect(screen.getByText('4. Practice Scheduling')).toBeTruthy();
  });

  it('negative control: shows the loaded panel once the fetch has landed', () => {
    renderWorkflow({ team: false, practice: false, game: false });
    expect(screen.getByText('Practice Readiness')).toBeTruthy();
    expect(screen.getByLabelText('Manual Actions').textContent).toContain('2');
  });

  it('an absent loading prop still renders the loaded panel, never a stuck skeleton', () => {
    renderWorkflow(undefined);
    expect(screen.getByText('Practice Readiness')).toBeTruthy();
  });
});
