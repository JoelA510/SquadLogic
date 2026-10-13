/**
 * The dated scoring witnesses (M4.7, `docs/PLAN_SCORING_DATE_MODEL.md` §2.2,
 * §4), read by the core test (`tests/practiceMetrics.test.js`) and the
 * cross-arm drift test (`tests/scoringEngineDrift.test.js`). The Deno arm
 * (`_shared/tests/scoring-engine_test.ts`) reads the same JSON.
 *
 * Every expected value in the JSON is the truth worked out from the dates by
 * hand, never an engine answer, so a vector cannot agree with a broken engine
 * by construction.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const DATED_VECTORS_PATH =
  'supabase/functions/_shared/tests/fixtures/scoring-dated-vectors.json';

/** @type {{ timeZone: string, vectors: Array<any> }} */
export const DATED_VECTORS = JSON.parse(readFileSync(path.join(REPO, DATED_VECTORS_PATH), 'utf8'));

/** A conflict by identity, spelled as the parity extract spells it. */
const conflictKey = (c) =>
  `${c.teams
    .map((t) => `${t.teamId}@${t.slotId}`)
    .sort()
    .join(' + ')} :: ${[...c.coachIds].sort().join(',')}`;

/**
 * Either arm's report in the vectors' `expected` shape.
 *
 * @param {any} report - core or Edge `evaluatePracticeSchedule` output
 * @param {number} dataQuality - core `dataQualityWarnings.length`, or the
 *   Edge's `data-quality` issue count
 */
export function datedProjection(report, dataQuality) {
  return {
    conflicts: report.coachConflicts
      .map((c) => ({ key: conflictKey(c), firstDate: c.firstDate, sharedDates: c.sharedDates }))
      .sort((a, b) => a.key.localeCompare(b.key)),
    slotLoad: Object.fromEntries(
      report.slotUtilization.map((s) => [s.slotId, [s.assignedCount, s.assignmentRows]])
    ),
    dataQuality,
    assignedTeams: report.summary.assignedTeams,
  };
}

/** What the undated comparison sees: the same inputs with every date removed. */
export function undatedInputs(vector) {
  return {
    teams: vector.teams,
    slots: vector.slots.map(({ id, day, capacity, start, end }) => ({
      id,
      day,
      capacity,
      start,
      end,
    })),
    assignments: vector.assignments.map(({ teamId, slotId }) => ({ teamId, slotId })),
  };
}

/** Slots over capacity, sorted. */
export const overbookedOf = (report) =>
  report.slotUtilization
    .filter((s) => s.overbooked)
    .map((s) => s.slotId)
    .sort();
