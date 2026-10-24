#!/usr/bin/env node
/**
 * Regenerate `tests/fixtures/teamGenerationEligibility.golden.json`, the golden Phase B2's
 * promise is held to (`docs/changes/2026-10-22-phase-b-teaming.md`, B2: "fresh output is
 * identical when no player is blocked").
 *
 * The scenarios below are seeded rosters in which **no player is blocked**: they carry every
 * other eligibility annotation (`in_band`, `play_up_sanctioned`, `unknown`, and players with
 * no annotation at all) beside mutual buddies, one-way requests, coach anchors, an assistant,
 * and both existing overflow reasons, so a change that reads the annotation wrongly moves a
 * player here. The third scenario is a review-mode rerun (preserved UUIDs, a manual and a
 * locked player, late players).
 *
 * **The committed golden was generated on `main` before B2 changed the generator** (the commit
 * is in the file's `generatedAt`). `tests/teamGenerationEligibility.test.js` runs today's
 * generator over the same scenarios and compares the serialized output byte for byte (the
 * rerun after removing B2's one new key, `eligibilityHolds`, which must be empty). Re-running
 * this script on a later tree records that tree's answer instead: do it only when a change is
 * meant to move these rosters, and quote every moved player in the PR.
 *
 *   node scripts/generate-teaming-eligibility-golden.mjs [--check]
 *
 * `--check` regenerates in memory and exits non-zero when the committed file differs.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { generateTeams } from '../packages/core/src/teamGeneration.js';
import { prepareTeamingInput } from '../packages/core/src/teamingPipeline.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ELIGIBILITY_GOLDEN = 'tests/fixtures/teamGenerationEligibility.golden.json';

const SEASON = 2026;

/**
 * A generator player as the page's pipeline emits it (placeholder names only).
 * @returns {any}
 */
function annotated(id, division, extra = {}) {
  return { id, division, firstName: 'Player', lastName: id, name: `Player ${id}`, ...extra };
}

const IN_BAND = { placement: 'in_band', naturalAge: 10, needsReview: false, reviewReason: null };
const SANCTIONED = {
  placement: 'play_up_sanctioned',
  naturalAge: 9,
  playUpSanctioned: true,
  needsReview: false,
  reviewReason: null,
};
const UNKNOWN = { placement: 'unknown', naturalAge: null, needsReview: false, reviewReason: null };

/** Fresh run, two divisions, every non-blocking annotation, both existing overflow reasons. */
function freshAnnotatedScenario() {
  const players = [
    // U10: a coach with five children (one more than a roster holds: coach-capacity).
    ...[1, 2, 3, 4, 5].map((n) =>
      annotated(`u10-c${n}`, 'U10', { ...IN_BAND, coachId: 'coach-a', skillRating: n % 3 })
    ),
    // A sanctioned play-up coach's child of a second coach.
    annotated('u10-up', 'U10', { ...SANCTIONED, coachId: 'coach-b', isCoachChild: true }),
    // A mutual pair, one of them with no natural age (unknown: placed, flagged by B3).
    annotated('u10-pa', 'U10', { ...IN_BAND, buddyId: 'u10-pb', skillRating: 3 }),
    annotated('u10-pb', 'U10', { ...UNKNOWN, buddyId: 'u10-pa', skillRating: 1 }),
    // A one-way request (not a unit) and a request for nobody.
    annotated('u10-ow', 'U10', { ...IN_BAND, buddyId: 'u10-g1' }),
    annotated('u10-miss', 'U10', { ...UNKNOWN, buddyId: 'nobody' }),
    // An assistant-only unit.
    annotated('u10-asst', 'U10', { ...IN_BAND, assistantCoachId: 'asst-a', skillRating: 2 }),
    // General players, some with no annotation at all (a pipeline that never ran).
    ...[1, 2, 3, 4, 5, 6].map((n) =>
      annotated(`u10-g${n}`, 'U10', n % 2 ? { ...IN_BAND, skillRating: n } : { skillRating: n })
    ),
    // U12: capped at two teams of four, so two units overflow for capacity.
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) =>
      annotated(`u12-g${n}`, 'U12', {
        ...(n % 3 === 0 ? UNKNOWN : { ...IN_BAND, naturalAge: 12 }),
        skillRating: (n * 7) % 5,
      })
    ),
  ];
  return {
    players,
    divisionConfigs: {
      U10: { id: 'U10', maxRosterSize: 4 },
      U12: { id: 'U12', maxRosterSize: 4, maxTeams: 2 },
    },
    seed: 'b2-golden-fresh',
  };
}

/** The same kind of roster annotated by the real pipeline (birthdates, a coach link). */
function freshPipelineScenario() {
  const players = [
    { id: 'pl-child', division: 'U10', dob: '2017-04-01', firstName: 'Kid', lastName: 'Coach' },
    { id: 'pl-a', division: 'U10', dob: '2016-02-01', buddyId: 'pl-b' },
    { id: 'pl-b', division: 'U10', dob: '2016-09-01', buddyId: 'pl-a' },
    // No birthdate: unknown.
    { id: 'pl-c', division: 'U10' },
    ...Array.from({ length: 8 }, (_, i) => ({
      id: `pl-g${i + 1}`,
      division: 'U10',
      dob: `2016-0${(i % 9) + 1}-15`,
      skillRating: i % 4,
    })),
  ];
  const prepared = prepareTeamingInput({
    players,
    coaches: [{ id: 'coach-p', player_id: 'pl-child' }],
    divisions: [{ id: 'U10', name: 'U10', min_age: 10, max_age: 10 }],
    seasonYear: SEASON,
    cutoffMode: 'birth_year',
    remapBlocked: false,
  });
  return {
    players: prepared.players,
    divisionConfigs: { U10: { id: 'U10', maxRosterSize: 5 } },
    seed: 'b2-golden-pipeline',
  };
}

/** A review-mode rerun: preserved UUID teams, a manual and a locked player, late players. */
function reviewRerunScenario() {
  const roster = [
    ...['r1', 'r2', 'r3'].map((id) => annotated(id, 'U10', { ...IN_BAND, coachId: 'coach-r' })),
    ...['r4', 'r5', 'r6'].map((id) => annotated(id, 'U10', { ...UNKNOWN })),
    ...['r7', 'r8'].map((id) => annotated(id, 'U10', { ...SANCTIONED })),
  ];
  const late = [
    annotated('late-1', 'U10', { ...IN_BAND, skillRating: 2 }),
    annotated('late-2', 'U10', { ...UNKNOWN, skillRating: 4 }),
    annotated('late-3', 'U10', { ...IN_BAND, coachId: 'coach-r' }),
    annotated('late-4', 'U10', { ...IN_BAND, buddyId: 'r8' }),
    annotated('late-5', 'U10', { ...IN_BAND }),
  ];
  // r8 reciprocates late-4, so late-4 is routed to r8's team.
  roster[7] = { ...roster[7], buddyId: 'late-4' };
  const existingSnapshot = {
    status: 'review',
    runId: 'run-golden',
    teamsByDivision: {
      U10: [
        {
          id: '0b2e0000-0000-4000-8000-000000000001',
          name: 'Team One',
          division: 'U10',
          coachId: 'coach-r',
          assistantCoachIds: [],
          players: [
            { id: 'r1', assignment_source: 'auto' },
            { id: 'r2', assignment_source: 'manual' },
            { id: 'r3', assignment_source: 'auto' },
          ],
        },
        {
          id: '0b2e0000-0000-4000-8000-000000000002',
          name: 'Team Two',
          division: 'U10',
          coachId: null,
          players: [
            { id: 'r4', assignment_source: 'auto' },
            { id: 'r5', assignment_source: 'auto', locked: true },
            { id: 'r6', assignment_source: 'auto' },
          ],
        },
        {
          id: '0b2e0000-0000-4000-8000-000000000003',
          name: 'Team Three',
          division: 'U10',
          coachId: null,
          locked: true,
          players: [
            { id: 'r7', assignment_source: 'auto' },
            { id: 'r8', assignment_source: 'auto' },
          ],
        },
      ],
    },
  };
  return {
    players: [...roster, ...late],
    divisionConfigs: { U10: { id: 'U10', maxRosterSize: 4 } },
    seed: 'b2-golden-rerun',
    existingSnapshot,
    generationMode: 'review',
  };
}

/**
 * The golden's scenarios, by name; the test builds the same ones.
 * @returns {Record<string, any>}
 */
export function eligibilityGoldenScenarios() {
  return {
    freshAnnotated: freshAnnotatedScenario(),
    freshPipeline: freshPipelineScenario(),
    reviewRerun: reviewRerunScenario(),
  };
}

/** The serialized generator output of each scenario (JSON drops `undefined`, as storage does). */
export function eligibilityGoldenOutputs() {
  return Object.fromEntries(
    Object.entries(eligibilityGoldenScenarios()).map(([name, scenario]) => [
      name,
      JSON.parse(JSON.stringify(generateTeams(scenario))),
    ])
  );
}

function main() {
  const check = process.argv.includes('--check');
  const outputs = eligibilityGoldenOutputs();
  const head = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  }).trim();
  const target = path.join(REPO_ROOT, ELIGIBILITY_GOLDEN);
  if (check) {
    const committed = JSON.parse(readFileSync(target, 'utf8'));
    const same = JSON.stringify(committed.scenarios) === JSON.stringify(outputs);
    console.log(same ? 'golden matches' : 'golden DIFFERS');
    process.exitCode = same ? 0 : 1;
    return;
  }
  const golden = {
    source: 'scripts/generate-teaming-eligibility-golden.mjs (Phase B2)',
    generatedAt: head,
    scenarios: outputs,
  };
  writeFileSync(target, `${JSON.stringify(golden, null, 2)}\n`);
  console.log(`wrote ${ELIGIBILITY_GOLDEN} at ${head}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
