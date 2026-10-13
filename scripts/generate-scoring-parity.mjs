#!/usr/bin/env node
/**
 * Regenerate `supabase/functions/_shared/tests/fixtures/scoring-parity.season-2026.json`,
 * the extract both arms of the core vs Edge scoring parity check read
 * (`tests/scoringParity.test.js` under Vitest, `_shared/tests/scoring-parity_test.ts`
 * under Deno).
 *
 * The extract is the club's combined practice sheet from the season-2026 corpus
 * ("93 Combined" in `fixtures/season-2026/practice/practice_grid.csv`) against the
 * full roster (`fixtures/season-2026/coach_roster.csv`), plus core's answer on it
 * (`packages/core/src/practiceMetrics.js`) in the fields both arms agree on.
 *
 * Run it only when the corpus or core's answer is meant to change, and review the
 * diff. `tests/scoringParity.test.js` fails on an extract the corpus no longer
 * derives or core no longer reproduces, so a stale one cannot sit green; the Deno
 * arm then holds the Edge engine to the new values.
 *
 * **Pseudonyms only, and fewer of them.** The corpus is already pseudonymous; the
 * extract replaces its person keys with opaque `coach-NNN` ids (numbered in sorted
 * key order), since only their equality matters to a conflict.
 *
 *   node scripts/generate-scoring-parity.mjs
 */

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadSeason2026, loadSeason2026Practice } from '../packages/core/src/fixtures/index.js';
import { evaluatePracticeSchedule } from '../packages/core/src/practiceMetrics.js';
import { requireZonedInstant } from '../packages/core/src/timing/index.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SCORING_PARITY_EXTRACT =
  'supabase/functions/_shared/tests/fixtures/scoring-parity.season-2026.json';

/** The sheet of `practice_grid.csv` that is the club's whole weekly plan. */
export const SOURCE_SHEET = '93 Combined';
/** The corpus names no zone; tests read it in New York (corpus README). */
export const TIME_ZONE = 'America/New_York';
/** A plain teaching week after Labor Day, away from any DST edge. */
const WEEK_OF = {
  Monday: '2026-09-14',
  Tuesday: '2026-09-15',
  Wednesday: '2026-09-16',
  Thursday: '2026-09-17',
  Friday: '2026-09-18',
  Saturday: '2026-09-19',
  Sunday: '2026-09-20',
};

const clock = (minutes) =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

/**
 * The extract's inputs, derived from the corpus as it is on disk now.
 *
 * @returns {{ teams: Array<object>, slots: Array<object>, assignments: Array<object> }}
 */
export function deriveScoringParityInputs() {
  const season = loadSeason2026();
  const practice = loadSeason2026Practice({ season });

  const personKeys = [
    ...new Set(season.teams.flatMap((t) => [t.coachId, ...(t.assistantCoachIds ?? [])])),
  ]
    .filter(Boolean)
    .sort();
  const coachIdOf = new Map(
    personKeys.map((key, i) => [key, `coach-${String(i + 1).padStart(3, '0')}`])
  );

  // Every roster team, not only the ones the sheet places: the roster is the
  // subject set a dropped team would leave intact. Two Select teams carry no
  // division; 'Unassigned' is the practice page's `normalizeTeam` answer to
  // that, adopted rather than a third one.
  const teams = season.teams.map((t) => ({
    id: t.id,
    division: t.division ?? 'Unassigned',
    coachId: t.coachId ? coachIdOf.get(t.coachId) : null,
    assistantCoachIds: (t.assistantCoachIds ?? []).map((key) => coachIdOf.get(key)),
  }));

  const rows = practice.practiceSlots.filter((r) => r.sourceSheet === SOURCE_SHEET);
  // One slot per grid row: each row is one team's place on one surface.
  const slots = rows.map((r) => {
    const date = WEEK_OF[r.day];
    if (!date) throw new Error(`grid row ${r.id} has an unknown day ${r.day}`);
    return {
      id: r.id,
      day: r.day,
      capacity: 1,
      start: requireZonedInstant({ date, time: clock(r.startMinutes), timeZone: TIME_ZONE }),
      end: requireZonedInstant({ date, time: clock(r.endMinutes), timeZone: TIME_ZONE }),
    };
  });
  const assignments = rows.map((r) => ({ teamId: r.teamCode, slotId: r.id }));
  return { teams, slots, assignments };
}

/** A conflict by identity: the two placements, then the coaches they share. */
export const conflictKey = (c) =>
  `${c.teams
    .map((t) => `${t.teamId}@${t.slotId}`)
    .sort()
    .join(' + ')} :: ${[...c.coachIds].sort().join(',')}`;

/**
 * One arm's answer in the fields both arms agree on (the contract
 * `tests/scoringEngineDrift.test.js` states), in the extract's `expected` shape.
 *
 * @param {any} result - either arm's `evaluatePracticeSchedule` output
 * @param {number} droppedRows - rows the arm discarded and reported
 */
export function agreedFields(result, droppedRows) {
  return {
    summary: {
      totalTeams: result.summary.totalTeams,
      assignedTeams: result.summary.assignedTeams,
      unassignedTeams: result.summary.unassignedTeams,
      // Core rounds to 4 dp; the Edge publishes the raw quotient.
      assignmentRate: Number(result.summary.assignmentRate.toFixed(4)),
    },
    slotUtilization: result.slotUtilization
      .map((s) => ({ slotId: s.slotId, assignedCount: s.assignedCount, capacity: s.capacity }))
      .sort((a, b) => a.slotId.localeCompare(b.slotId)),
    coachConflicts: result.coachConflicts.map(conflictKey).sort(),
    droppedRows,
  };
}

/** Core's answer on the inputs, in the agreed fields. */
export function coreAgreedFields(inputs) {
  const result = evaluatePracticeSchedule({
    ...inputs,
    // Neither feeds an agreed field: `schoolDayEnd` gates a core-only check, and
    // the zone is the corpus's.
    schoolDayEnd: undefined,
    timezone: TIME_ZONE,
  });
  return agreedFields(result, result.dataQualityWarnings.length);
}

function main() {
  const inputs = deriveScoringParityInputs();
  const extract = {
    source: `fixtures/season-2026/practice/practice_grid.csv sheet "${SOURCE_SHEET}" against fixtures/season-2026/coach_roster.csv; generated by scripts/generate-scoring-parity.mjs`,
    timeZone: TIME_ZONE,
    inputs,
    expected: coreAgreedFields(inputs),
  };
  writeFileSync(
    path.join(REPO_ROOT, SCORING_PARITY_EXTRACT),
    `${JSON.stringify(extract, null, 2)}\n`
  );
  console.log(
    `wrote ${SCORING_PARITY_EXTRACT}: ${inputs.teams.length} teams, ${inputs.slots.length} slots, ` +
      `${inputs.assignments.length} assignments, ${extract.expected.coachConflicts.length} coach conflict(s)`
  );
  console.log('Run `npx prettier --write` on it, then review the diff.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
