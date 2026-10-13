#!/usr/bin/env node
/**
 * Regenerate `supabase/functions/_shared/tests/fixtures/scoring-parity.season-2026.json`,
 * the extract both arms of the core vs Edge scoring parity check read
 * (`tests/scoringParity.test.js` under Vitest, `_shared/tests/scoring-parity_test.ts`
 * under Deno), and its dated sibling `scoring-parity-dated.season-2026.json`
 * (M4.7, `docs/PLAN_SCORING_DATE_MODEL.md` §2.3 and §3.4).
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
import { weekdayCodeOf } from '../packages/core/src/availability/calendar.js';
import { isoDateOfDayNumber, isoDayNumber } from '../packages/core/src/facility/eligibility.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SCORING_PARITY_EXTRACT =
  'supabase/functions/_shared/tests/fixtures/scoring-parity.season-2026.json';
export const SCORING_PARITY_DATED_EXTRACT =
  'supabase/functions/_shared/tests/fixtures/scoring-parity-dated.season-2026.json';

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

/**
 * The dated extract's season: the corpus permits' window at Maplewood
 * (`permit_reservations.csv`), as the plan measured it (§2.1).
 */
export const DATED_SEASON = Object.freeze({ start: '2026-08-10', end: '2026-11-20' });
/** The revision date the plan's C1 assumes (§2.3): closed to 10-04, revised from 10-05. */
const REVISED_FROM = '2026-10-05';
/** The sheet C1 models as the closed revision. */
export const C1_CLOSED_SHEET = 'Select OLD';

const WEEKDAY_CODE = {
  Monday: 'MON',
  Tuesday: 'TUE',
  Wednesday: 'WED',
  Thursday: 'THU',
  Friday: 'FRI',
  Saturday: 'SAT',
  Sunday: 'SUN',
};
/** Postgres's canonical `daterange` spelling of an inclusive span: `[from,until+1)`. */
const storedRange = (from, until) => `[${from},${isoDateOfDayNumber(isoDayNumber(until) + 1)})`;

/**
 * The dated extract's inputs (M4.7): the plan's corpus cases C1 and C4
 * (`docs/PLAN_SCORING_DATE_MODEL.md` §2.3), each slot dated as the practice
 * page dates it (`slotDating`: first occurrence on or after its validity
 * start, validity end, wall window) and each row carrying a stored range.
 *
 * - **C1**: "93 Combined" plus "Select OLD" as closed series to 2026-10-04,
 *   and the revised teams' "93 Combined" rows from 2026-10-05 -- writer v3
 *   keeps both. 170 rows; one real conflict, which the first-occurrence
 *   comparison reports as eleven.
 * - **C4**: "93 Combined" with the Friday 18:00 Alder Park Pitch 3B slot
 *   re-created valid from 2026-09-14; its one real conflict is lost by the
 *   first-occurrence comparison.
 *
 * @returns {{ C1: object, C4: object }}
 */
export function deriveDatedParityInputs() {
  const { teams } = deriveScoringParityInputs();
  const season = loadSeason2026();
  const practice = loadSeason2026Practice({ season });
  const rowsOf = (sheet) => practice.practiceSlots.filter((r) => r.sourceSheet === sheet);

  /**
   * @param {any} r - a grid row
   * @param {string} [validFrom] - the slot's validity start
   */
  const datedSlot = (r, validFrom = DATED_SEASON.start) => {
    const code = WEEKDAY_CODE[r.day];
    if (!code) throw new Error(`grid row ${r.id} has an unknown day ${r.day}`);
    let day = isoDayNumber(validFrom);
    while (weekdayCodeOf(isoDateOfDayNumber(day)) !== code) day += 1;
    const firstDate = isoDateOfDayNumber(day);
    const startTime = clock(r.startMinutes);
    const endTime = clock(r.endMinutes);
    return {
      id: r.id,
      day: r.day,
      capacity: 1,
      start: requireZonedInstant({ date: firstDate, time: startTime, timeZone: TIME_ZONE }),
      end: requireZonedInstant({ date: firstDate, time: endTime, timeZone: TIME_ZONE }),
      firstDate,
      lastDate: DATED_SEASON.end,
      startTime: `${startTime}:00`,
      endTime: `${endTime}:00`,
    };
  };
  const FULL = storedRange(DATED_SEASON.start, DATED_SEASON.end);

  const plan = rowsOf(SOURCE_SHEET);
  const closed = rowsOf(C1_CLOSED_SHEET);
  const revised = new Set(closed.map((r) => r.teamCode));
  const closedUntil = isoDateOfDayNumber(isoDayNumber(REVISED_FROM) - 1);
  const C1 = {
    teams,
    slots: [...plan, ...closed].map((r) => datedSlot(r)),
    assignments: [
      ...closed.map((r) => ({
        teamId: r.teamCode,
        slotId: r.id,
        effectiveDateRange: storedRange(DATED_SEASON.start, closedUntil),
      })),
      ...plan.map((r) => ({
        teamId: r.teamCode,
        slotId: r.id,
        effectiveDateRange: revised.has(r.teamCode)
          ? storedRange(REVISED_FROM, DATED_SEASON.end)
          : FULL,
      })),
    ],
  };

  const SPLIT_FROM = '2026-09-14';
  const isSplit = (r) =>
    r.venue === 'Alder Park' &&
    r.field === 'Pitch 3B' &&
    r.day === 'Friday' &&
    r.startMinutes === 18 * 60;
  if (plan.filter(isSplit).length !== 1) throw new Error('C4: the split slot is not unique');
  const C4 = {
    teams,
    slots: plan.map((r) => (isSplit(r) ? datedSlot(r, SPLIT_FROM) : datedSlot(r))),
    assignments: plan.map((r) => ({
      teamId: r.teamCode,
      slotId: r.id,
      effectiveDateRange: isSplit(r) ? storedRange(SPLIT_FROM, DATED_SEASON.end) : FULL,
    })),
  };
  return { C1, C4 };
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

/**
 * The agreed fields of a dated run: the undated ones, plus each slot's row
 * count beside its busiest-date load, and each conflict's first date and
 * number of shared dates (plan Q4, Q7).
 *
 * @param {any} result
 * @param {number} droppedRows
 */
export function datedAgreedFields(result, droppedRows) {
  const base = agreedFields(result, droppedRows);
  return {
    ...base,
    dateModel: result.summary.dateModel,
    slotUtilization: result.slotUtilization
      .map((s) => ({
        slotId: s.slotId,
        assignedCount: s.assignedCount,
        assignmentRows: s.assignmentRows,
        capacity: s.capacity,
      }))
      .sort((a, b) => a.slotId.localeCompare(b.slotId)),
    coachConflicts: result.coachConflicts
      .map((c) => `${conflictKey(c)} @ ${c.firstDate} x${c.sharedDates}`)
      .sort(),
  };
}

/** Core's dated answer on one case's inputs. */
export function coreDatedAgreedFields(inputs) {
  const result = evaluatePracticeSchedule({
    ...inputs,
    schoolDayEnd: undefined,
    timezone: TIME_ZONE,
  });
  return datedAgreedFields(result, result.dataQualityWarnings.length);
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

  const datedInputs = deriveDatedParityInputs();
  const dated = {
    source: `fixtures/season-2026/practice/practice_grid.csv sheets "${SOURCE_SHEET}" and "${C1_CLOSED_SHEET}" against fixtures/season-2026/coach_roster.csv, dated as docs/PLAN_SCORING_DATE_MODEL.md §2.3 cases C1 and C4; generated by scripts/generate-scoring-parity.mjs`,
    timeZone: TIME_ZONE,
    season: DATED_SEASON,
    // One roster for both cases, written once.
    teams: datedInputs.C1.teams,
    cases: Object.fromEntries(
      Object.entries(datedInputs).map(([name, { slots, assignments, ...caseInputs }]) => [
        name,
        {
          slots,
          assignments,
          expected: coreDatedAgreedFields({ ...caseInputs, slots, assignments }),
        },
      ])
    ),
  };
  writeFileSync(
    path.join(REPO_ROOT, SCORING_PARITY_DATED_EXTRACT),
    `${JSON.stringify(dated, null, 2)}\n`
  );
  for (const [name, c] of Object.entries(dated.cases)) {
    console.log(
      `wrote ${SCORING_PARITY_DATED_EXTRACT} ${name}: ${c.slots.length} slots, ` +
        `${c.assignments.length} assignments, ${c.expected.coachConflicts.length} coach conflict(s)`
    );
  }
  console.log('Run `npx prettier --write` on both, then review the diff.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
