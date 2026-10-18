/**
 * Core vs Edge scoring parity over the season-2026 corpus (audit finding 1.1;
 * remediation plan Oct 2026, M1.2). The Vitest arm; the Deno arm is
 * `supabase/functions/_shared/tests/scoring-parity_test.ts`.
 *
 * ## Why this exists beside `scoringEngineDrift.test.js`
 *
 * The drift test compares the two `evaluatePracticeSchedule` implementations
 * (`packages/core/src/practiceMetrics.js` and the Edge's
 * `_shared/engines/scoring-engine.ts`) value against value, but only on the
 * ten hand-written vectors it names. Since the practice page now sends its real
 * roster to `fairness-scoring` (M1.1), any disagreement between the arms on a
 * real season reaches every practice page. This file runs both arms over one
 * real plan: the club's combined practice sheet ("93 Combined": 142 practice
 * rows for 88 teams) against the full 132-team roster, with its head and
 * assistant coaches.
 *
 * ## The extract, and why the Deno arm needs it
 *
 * An Edge Function cannot import `packages/core`, so the Deno arm cannot run
 * core. Both arms therefore read one committed extract,
 * `supabase/functions/_shared/tests/fixtures/scoring-parity.season-2026.json`:
 * the inputs, derived from the corpus below, and core's answer on them in the
 * agreed fields. This file checks (1) the extract's inputs are exactly what the
 * corpus derives today, (2) core still gives the recorded answer, and (3) the
 * Edge engine, imported here, gives it too. The Deno arm checks (3) again in
 * the runtime the engine is deployed to. Either arm drifting turns one red.
 *
 * ## What is compared
 *
 * The agreed contract `scoringEngineDrift.test.js` states: the summary counts
 * (`totalTeams`, `assignedTeams`, `unassignedTeams`), `assignmentRate` (the one
 * score both arms publish; core rounds it to 4 dp), per-slot occupancy and the
 * number of slot rows, the rows each arm drops (core's `dataQualityWarnings`,
 * the Edge's `data-quality` issues), and every coach conflict **by identity**:
 * which two (team, slot) placements clash and which coaches they share. The
 * Edge's `fairnessScore` is Edge-only and is a function of the conflict count
 * and `assignmentRate`, both compared here.
 *
 * **What this extract can and cannot catch.** It is a real plan, so it is
 * clean: no row is dropped (`droppedRows` is 0) and every slot holds the one
 * team its grid row names. Those two comparisons only guard a future extract.
 * Dropped, duplicate and unknown rows, overbooking and the empty roster are
 * exercised by the hand-written vectors in `scoringEngineDrift.test.js`. What
 * this extract adds is scale and shape: 54 teams on two slots, 82 with
 * assistants, back-to-back practices, and one real coach conflict, which a
 * planted `>` for `>=` in either arm's overlap rule turns into more (that plant
 * passes the drift test).
 *
 * ## Pseudonyms only
 *
 * The extract replaces the corpus's person keys with opaque `coach-NNN` ids;
 * only their equality matters to a conflict. Team codes and divisions are kept.
 * Regenerate it with `node scripts/generate-scoring-parity.mjs`, only when the
 * corpus or core's answer is meant to change, and review the diff.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadSeason2026 } from '@squadlogic/core/fixtures/index.js';
import { evaluatePracticeSchedule } from '@squadlogic/core/practiceMetrics.js';
import {
  evaluateGameSchedule as edgeEvaluateGames,
  evaluatePracticeSchedule as edgeEvaluate,
} from '../supabase/functions/_shared/engines/scoring-engine.js';
import { evaluateGameSchedule as coreEvaluateGames } from '@squadlogic/core/gameMetrics.js';
import { coreGameProjection, edgeGameProjection } from './fixtures/gameScoringProjection.js';
import {
  SCORING_PARITY_DATED_EXTRACT,
  SCORING_PARITY_EXTRACT,
  SCORING_PARITY_GAMES_EXTRACT,
  coreGameAgreedFields,
  deriveGameParityInputs,
  agreedFields,
  coreAgreedFields,
  coreDatedAgreedFields,
  datedAgreedFields,
  deriveDatedParityInputs,
  deriveScoringParityInputs,
} from '../scripts/generate-scoring-parity.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DENO_ARM = 'supabase/functions/_shared/tests/scoring-parity_test.ts';

/**
 * Literals, not counts of the extract: a floor derived from the data a break
 * would shrink compares the data with itself. The Deno arm declares the same.
 */
const EXPECTED = {
  teams: 132,
  slots: 142,
  assignments: 142,
  assignedTeams: 88,
  coachConflicts: 1,
  teamsOnTwoOrMoreSlots: 54,
  teamsWithAssistants: 82,
};

const runEdge = (inputs) => {
  const result = edgeEvaluate(inputs);
  return agreedFields(result, result.issues.filter((i) => i.category === 'data-quality').length);
};

const extract = JSON.parse(readFileSync(path.join(REPO_ROOT, SCORING_PARITY_EXTRACT), 'utf8'));

describe('core vs Edge scoring parity on the season-2026 corpus', () => {
  it('the extract is what the corpus derives today', () => {
    expect(extract.inputs).toEqual(deriveScoringParityInputs());
  });

  it('the extract holds the season, with the cases parity needs (meta, can fail)', () => {
    const { teams, slots, assignments } = extract.inputs;
    expect(teams).toHaveLength(EXPECTED.teams);
    expect(slots).toHaveLength(EXPECTED.slots);
    expect(assignments).toHaveLength(EXPECTED.assignments);
    expect(new Set(assignments.map((a) => a.teamId)).size).toBe(EXPECTED.assignedTeams);
    // Teams on more than one slot: the case that once made the Edge count rows.
    const slotsPerTeam = new Map();
    for (const a of assignments) slotsPerTeam.set(a.teamId, (slotsPerTeam.get(a.teamId) ?? 0) + 1);
    expect([...slotsPerTeam.values()].filter((n) => n > 1)).toHaveLength(
      EXPECTED.teamsOnTwoOrMoreSlots
    );
    expect(teams.filter((t) => t.assistantCoachIds.length > 0)).toHaveLength(
      EXPECTED.teamsWithAssistants
    );
    // A real conflict, so "both arms found none" cannot pass as agreement.
    expect(extract.expected.coachConflicts).toHaveLength(EXPECTED.coachConflicts);
    // Some roster team is unplaced, so coverage is a real reading, not 100%.
    expect(extract.expected.summary.unassignedTeams).toBeGreaterThan(0);
  });

  it('no person key from the corpus is in the extract', () => {
    const text = JSON.stringify(extract).toLowerCase();
    const season = loadSeason2026();
    const keys = new Set(season.teams.flatMap((t) => [t.coachId, ...(t.assistantCoachIds ?? [])]));
    keys.delete(null);
    keys.delete(undefined);
    // Meta: the scan has keys to look for.
    expect(keys.size).toBeGreaterThan(100);
    // Anywhere, not only as a whole value: a key inside a longer string still leaks.
    for (const key of keys) expect(text.includes(key.toLowerCase()), key).toBe(false);
  });

  it('core gives the recorded answer', () => {
    expect(coreAgreedFields(extract.inputs)).toEqual(extract.expected);
  });

  it('the Edge engine gives the same answer', () => {
    expect(runEdge(extract.inputs)).toEqual(extract.expected);
  });

  it('the Deno arm reads the same extract, or this is not a cross-check', () => {
    const deno = readFileSync(path.join(REPO_ROOT, DENO_ARM), 'utf8');
    expect(deno).toContain('./fixtures/scoring-parity.season-2026.json');
    expect(deno).toContain(SCORING_PARITY_EXTRACT);
    // The same literals, so neither arm can quietly accept a smaller extract.
    for (const [name, value] of Object.entries(EXPECTED)) {
      expect(deno, name).toMatch(new RegExp(`\\b${name}: ${value},`));
    }
  });
});

// ---- M4.7: the dated extract (docs/PLAN_SCORING_DATE_MODEL.md §2.3, §3.4) ----
//
// The plan's corpus cases C1 (a closed revision kept beside its successor) and
// C4 (one slot re-created valid from a later date), dated as the practice page
// dates them. The undated extract above is unchanged: on the corpus's undated
// plan the date model is neutral (C0), which is why it was not regenerated.

/** Literals, as above; the Deno arm declares the same. */
const DATED_EXPECTED = {
  c1Slots: 170,
  c1Assignments: 170,
  c1ClosedRows: 28,
  c1Conflicts: 1,
  c1UndatedConflicts: 11,
  c1SharedDates: 7,
  c4Slots: 142,
  c4Conflicts: 1,
  c4UndatedConflicts: 0,
  c4SharedDates: 10,
  c5Exceptions: 2,
  c5Conflicts: 2,
  c5SharedDates: 8,
  c5TbdDates: 2,
  c5PeakOnTarget: 2,
};
const DENO_DATED_ARM = 'supabase/functions/_shared/tests/scoring-parity_test.ts';

const dated = JSON.parse(readFileSync(path.join(REPO_ROOT, SCORING_PARITY_DATED_EXTRACT), 'utf8'));
const datedInputsOf = (name) => ({
  teams: dated.teams,
  slots: dated.cases[name].slots,
  assignments: dated.cases[name].assignments,
  ...(dated.cases[name].exceptions !== undefined
    ? { exceptions: dated.cases[name].exceptions }
    : {}),
});
const DATED_CASES = ['C1', 'C4', 'C5'];
const undatedOf = ({ teams, slots, assignments }) => ({
  teams,
  slots: slots.map(({ id, day, capacity, start, end }) => ({ id, day, capacity, start, end })),
  assignments: assignments.map(({ teamId, slotId }) => ({ teamId, slotId })),
});

describe('core vs Edge scoring parity, dated (M4.7)', () => {
  it('the dated extract is what the corpus derives today', () => {
    const derived = deriveDatedParityInputs();
    for (const name of DATED_CASES) {
      expect(datedInputsOf(name), name).toEqual(derived[name]);
    }
    expect(Object.keys(dated.cases).sort()).toEqual(DATED_CASES);
  });

  it('the cases are the plan cases, and the undated comparison gets both wrong (meta, can fail)', () => {
    const c1 = datedInputsOf('C1');
    const c4 = datedInputsOf('C4');
    expect(c1.slots).toHaveLength(DATED_EXPECTED.c1Slots);
    expect(c1.assignments).toHaveLength(DATED_EXPECTED.c1Assignments);
    // The closed series: rows whose range ends before the revision.
    expect(
      c1.assignments.filter((a) => a.effectiveDateRange.endsWith(',2026-10-05)'))
    ).toHaveLength(DATED_EXPECTED.c1ClosedRows);
    expect(c4.slots).toHaveLength(DATED_EXPECTED.c4Slots);
    // Every slot and row dated, so neither arm can fall back to undated.
    for (const { slots, assignments } of [c1, c4]) {
      expect(slots.every((s) => s.firstDate && s.lastDate && s.startTime && s.endTime)).toBe(true);
      expect(assignments.every((a) => typeof a.effectiveDateRange === 'string')).toBe(true);
    }
    // The defect, executed on these inputs: eleven conflicts where one is real
    // (C1), and the real one missed (C4).
    const undated = (inputs) =>
      evaluatePracticeSchedule({ ...undatedOf(inputs), schoolDayEnd: undefined, timezone: 'UTC' })
        .coachConflicts.length;
    expect(undated(c1)).toBe(DATED_EXPECTED.c1UndatedConflicts);
    expect(undated(c4)).toBe(DATED_EXPECTED.c4UndatedConflicts);
    // And the recorded answer is the truth, not merely core's word.
    expect(dated.cases.C1.expected.coachConflicts).toHaveLength(DATED_EXPECTED.c1Conflicts);
    expect(dated.cases.C4.expected.coachConflicts).toHaveLength(DATED_EXPECTED.c4Conflicts);
    expect(dated.cases.C1.expected.coachConflicts[0]).toMatch(
      new RegExp(` x${DATED_EXPECTED.c1SharedDates}$`)
    );
    expect(dated.cases.C4.expected.coachConflicts[0]).toMatch(
      new RegExp(` @ 2026-09-18 x${DATED_EXPECTED.c4SharedDates}$`)
    );
    expect(dated.cases.C1.expected.dateModel).toBe('dated');
  });

  it('C5 is C4 with two saved exceptions, and they are what move its answer (meta, can fail)', () => {
    const c5 = datedInputsOf('C5');
    expect(c5.exceptions).toHaveLength(DATED_EXPECTED.c5Exceptions);
    expect(new Set(c5.exceptions.map((e) => e.kind))).toEqual(new Set(['relocated', 'time_tbd']));
    // Every exception names a row of the case, so none is read as ROW_UNREAD.
    const ids = new Set(c5.assignments.map((a) => a.id));
    expect(c5.exceptions.every((e) => ids.has(e.assignment_id))).toBe(true);
    const { expected } = dated.cases.C5;
    expect(expected.droppedRows).toBe(0);
    expect(expected.coachConflicts).toHaveLength(DATED_EXPECTED.c5Conflicts);
    // C4's real clash keeps 8 of its 10 Fridays; the relocation adds one clash.
    expect(expected.coachConflicts).toContain(
      dated.cases.C4.expected.coachConflicts[0].replace(
        / @ 2026-09-18 x10$/,
        ` @ 2026-10-02 x${DATED_EXPECTED.c5SharedDates}`
      )
    );
    expect(expected.coachConflicts.filter((c) => / @ 2026-10-15 x1$/.test(c))).toHaveLength(1);
    expect(expected.timeTbd).toHaveLength(1);
    expect(expected.timeTbd[0].dates).toHaveLength(DATED_EXPECTED.c5TbdDates);
    const target = c5.exceptions.find((e) => e.kind === 'relocated').practice_slot_id;
    expect(expected.slotUtilization.find((s) => s.slotId === target)).toEqual({
      slotId: target,
      assignedCount: DATED_EXPECTED.c5PeakOnTarget,
      assignmentRows: 1,
      capacity: 1,
    });
    // Without its exceptions C5 scores exactly as C4: nothing else differs.
    const { exceptions: _e, ...without } = c5;
    const { timeTbd: _t, ...plain } = coreDatedAgreedFields(without);
    expect(plain).toEqual(dated.cases.C4.expected);
  });

  it.each(DATED_CASES)('core gives the recorded dated answer: %s', (name) => {
    expect(coreDatedAgreedFields(datedInputsOf(name))).toEqual(dated.cases[name].expected);
  });

  it.each(DATED_CASES)('the Edge engine gives the same dated answer: %s', (name) => {
    const result = edgeEvaluate(datedInputsOf(name));
    expect(
      datedAgreedFields(result, result.issues.filter((i) => i.category === 'data-quality').length)
    ).toEqual(dated.cases[name].expected);
  });

  it('the Deno arm reads the dated extract with the same literals', () => {
    const deno = readFileSync(path.join(REPO_ROOT, DENO_DATED_ARM), 'utf8');
    expect(deno).toContain('./fixtures/scoring-parity-dated.season-2026.json');
    expect(deno).toContain(SCORING_PARITY_DATED_EXTRACT);
    for (const [name, value] of Object.entries(DATED_EXPECTED)) {
      expect(deno, name).toMatch(new RegExp(`\\b${name}: ${value},`));
    }
  });
});

// ---- Games (#576 follow-up, docs/PLAN_GAME_EVALUATOR_UNKNOWN_TEAM.md §2.2, §3.5) ----
//
// The corpus's combined game schedule (the 542 rows naming both sides) against
// the same 132-team roster. Its five unknown teams are the external league's
// sides, which the club does not roster: real opponents, reported as warnings
// (Q3), not suppressed. Its three coach conflicts include assistants, which the
// Edge used to leave unread (2 instead of 3).

/** Literals, as above; the Deno arm declares the same. */
const GAMES_EXPECTED = {
  games: 542,
  teamsRostered: 132,
  teamsScheduled: 131,
  unknownTeams: 5,
  gameCoachConflicts: 3,
};
const games = JSON.parse(readFileSync(path.join(REPO_ROOT, SCORING_PARITY_GAMES_EXTRACT), 'utf8'));

describe('core vs Edge game scoring parity on the season-2026 corpus', () => {
  it('the games extract is what the corpus derives today', () => {
    expect(games.inputs).toEqual(deriveGameParityInputs());
  });

  it('the extract holds the season and the cases parity needs (meta, can fail)', () => {
    expect(games.inputs.games).toHaveLength(GAMES_EXPECTED.games);
    expect(games.inputs.teams).toHaveLength(GAMES_EXPECTED.teamsRostered);
    expect(games.expected.teamsRostered).toBe(GAMES_EXPECTED.teamsRostered);
    expect(games.expected.teamsScheduled).toBe(GAMES_EXPECTED.teamsScheduled);
    expect(games.expected.unknownTeams).toHaveLength(GAMES_EXPECTED.unknownTeams);
    expect(games.expected.teamsReferencedUnknown).toBe(GAMES_EXPECTED.unknownTeams);
    expect(games.expected.coachConflicts).toHaveLength(GAMES_EXPECTED.gameCoachConflicts);
    // Every unknown side is one the roster lacks, from the roster: never a
    // rostered team the engine failed to find.
    const rostered = new Set(games.inputs.teams.map((t) => t.id));
    expect(games.expected.unknownTeams.every((id) => !rostered.has(id))).toBe(true);
    // An assistant is needed for the third conflict: the head-coach-only
    // reading finds fewer.
    const headOnly = coreEvaluateGames({
      assignments: games.inputs.games,
      teams: games.inputs.teams.map(({ assistantCoachIds: _a, ...t }) => t),
    });
    expect(coreGameProjection(headOnly).coachConflicts.length).toBeLessThan(
      GAMES_EXPECTED.gameCoachConflicts
    );
  });

  it('core gives the recorded game answer', () => {
    expect(coreGameAgreedFields(games.inputs)).toEqual(games.expected);
  });

  it('the Edge engine gives the same game answer', () => {
    const edge = edgeEvaluateGames({ assignments: games.inputs.games, teams: games.inputs.teams });
    expect(edgeGameProjection(edge)).toEqual(games.expected);
    // Coverage from the roster: 131 of 132.
    expect(edge.summary.coveragePercent).toBe(99.24);
    expect(edge.status).toBe('action-required');
  });

  it('the Deno arm reads the games extract with the same literals', () => {
    const deno = readFileSync(path.join(REPO_ROOT, DENO_ARM), 'utf8');
    expect(deno).toContain('./fixtures/scoring-parity-games.season-2026.json');
    expect(deno).toContain(SCORING_PARITY_GAMES_EXTRACT);
    for (const [name, value] of Object.entries(GAMES_EXPECTED)) {
      expect(deno, name).toMatch(new RegExp(`\\b${name}: ${value},`));
    }
  });
});
