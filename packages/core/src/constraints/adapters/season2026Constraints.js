/**
 * The real season-2026 constraint set, as records.
 *
 * Every entry below existed before this file did — as an inline conditional, a
 * sort key, a `Notes` cell, a line in the corpus README, or a sentence somebody
 * said in a meeting. Nothing here is invented, and `source.reference` says for
 * each one exactly where to go and read it. Where the real origin is the
 * incident log rather than a data file, the reference says *that*, and `setAt`
 * is `null` with a note: the log preserves the order things happened in but not
 * their dates, and a plausible-looking invented date would be worse than an
 * admitted absence.
 *
 * **Four of the fourteen are wired; ten are `declared-only`.** The wired four
 * claim Phase 1 reason codes and therefore genuinely govern behaviour today. The
 * other ten — turnover minimums, coach travel, coach maximum gap, round-robin
 * completeness, home/away balance, kickoff variety, conflict fairness — have no
 * reason code to claim because the modules that would emit one are Phase 3 and
 * later. Recording them now with full scope, hardness and provenance, and saying
 * plainly that nothing consumes them yet, is the honest position; a fake reason
 * code would make the registry claim enforcement it does not have.
 *
 * Notice what the wired four do **not** do: they do not change a single Phase 1
 * severity. That is the point. Seeding a registry over a working system should
 * write down the policy that is already in force, and a test asserts exactly
 * that (`overrides.every(o => !o.changed)`). The registry earns its keep the
 * moment somebody wants a *different* policy — which is one function call away,
 * not a rewrite.
 *
 * This module takes no arguments and reads nothing from disk: it is a
 * transcription, not a loader. The arrow still points fixtures -> constraints,
 * never back.
 *
 * @module constraints/adapters/season2026Constraints
 */

import { AVAILABILITY_REASON } from '../../availability/reasonCodes.js';
import { FACILITY_REASON } from '../../facility/reasonCodes.js';
import { TIMING_REASON } from '../../timing/reasonCodes.js';
import { season2026VenueId } from '../../facility/adapters/season2026Geometry.js';
import {
  PRACTICE_DAYLIGHT_CONSTRAINT_ID,
  PRACTICE_SUNSET_MARGIN_MINUTES,
} from '../../practice/daylight.js';
import { CONSTRAINT_ENFORCEMENT, CONSTRAINT_SCOPE_KIND, CONSTRAINT_TYPE } from '../reasonCodes.js';
import { buildConstraintRegistry } from '../registry.js';

/**
 * Stable ids for the seeded set, so callers and tests never spell one by hand.
 *
 * @readonly
 * @enum {string}
 */
export const SEASON_2026_CONSTRAINT_ID = Object.freeze({
  FIELD_OVERLAP_ADJACENCY: 'field-overlap-adjacency',
  FIELD_SAME_GROUND_EXCLUSIVE: 'field-same-ground-exclusive',
  TURNOVER_FLOOR_GLOBAL: 'turnover-floor-global',
  TURNOVER_PREFERRED_GLOBAL: 'turnover-preferred-global',
  TURNOVER_ORCHARD_PARK: 'turnover-orchard-park',
  COACH_TRAVEL_BETWEEN_VENUES: 'coach-travel-between-venues',
  COACH_TRAVEL_WITHIN_VENUE: 'coach-travel-within-venue',
  COACH_MAXIMUM_GAP: 'coach-maximum-gap',
  ROUND_ROBIN_COMPLETENESS: 'round-robin-completeness',
  HOME_AWAY_BALANCE: 'home-away-balance',
  KICKOFF_VARIETY: 'kickoff-variety',
  CONFLICT_FAIRNESS: 'conflict-fairness',
  SUNSET_MARGIN: 'sunset-margin',
  PERMIT_WINDOW: 'permit-window',
});

/** The venue the traffic constraint names. Derived, never spelled as an id. */
export const ORCHARD_PARK_VENUE_ID = season2026VenueId('Orchard Park');

/** `fixtures/season-2026/README.md`, cited so often it gets a constant. */
const INCIDENT_LOG = 'fixtures/season-2026/README.md — incident log';

/** The corpus's own list of known-good invariants. */
const INVARIANTS = 'fixtures/season-2026/README.md — known-good invariants';

/**
 * The operator's statement of the constraint set, transcribed in the build plan
 * for Prompt 2.1. Used only where no corpus file carries the number.
 */
const BUILD_PLAN = 'scheduling build plan, Prompt 2.1 — "the real constraint set"';

/** A global scope, spelled once. */
const GLOBAL = Object.freeze({ kind: CONSTRAINT_SCOPE_KIND.GLOBAL });

/**
 * The fourteen seeded constraints.
 *
 * @type {ReadonlyArray<Object>}
 */
export const SEASON_2026_CONSTRAINTS = Object.freeze([
  {
    id: SEASON_2026_CONSTRAINT_ID.FIELD_OVERLAP_ADJACENCY,
    policy: 'field-adjacency',
    name: 'Overlapping fields may not host concurrent games',
    type: CONSTRAINT_TYPE.HARD,
    scope: GLOBAL,
    parameters: {},
    restrictiveDirection: 'none',
    rationale:
      'Pitches 2 and 3 physically overlap 1 and 4 at Alder Park, including the halves 1A/1B and 4A/4B. Two games on overlapping ground cannot both be played, and warm-ups occupy the ground as much as games do.',
    source: {
      setBy: 'club operations',
      setAt: null,
      reference: `${INCIDENT_LOG}, incident 3; geometry in fixtures/season-2026/facility_geometry.json — venues["Alder Park"].overlap_pairs and overlap_note`,
      note: 'the incident log records that the rule arrived mid-project and was later hardened, but not the dates on which either happened',
    },
    effectiveFrom: null,
    effectiveTo: null,
    enforcement: CONSTRAINT_ENFORCEMENT.REASON_CODES,
    reasonCodes: [
      FACILITY_REASON.OCCUPIED_SPATIAL_OVERLAP,
      TIMING_REASON.WARMUP_OCCUPIED_SPATIAL_OVERLAP,
    ],
    weight: null,
    waivable: false,
    history: [
      {
        from: null,
        to: CONSTRAINT_TYPE.PREFERENCE,
        at: null,
        by: 'club operations',
        note: 'introduced as "try to leave a field between them" — several schedule versions had already modelled the fields as independent strings (incident 3)',
      },
      {
        from: CONSTRAINT_TYPE.PREFERENCE,
        to: CONSTRAINT_TYPE.HARD,
        at: null,
        by: 'club operations',
        note: 'hardened to inviolable once the geometry was understood: 2/3 physically overlap 1/4, so a "preference" was describing an impossibility',
      },
    ],
  },

  {
    id: SEASON_2026_CONSTRAINT_ID.FIELD_SAME_GROUND_EXCLUSIVE,
    policy: 'field-same-ground',
    name: 'One patch of ground holds one game',
    type: CONSTRAINT_TYPE.HARD,
    scope: GLOBAL,
    parameters: {},
    restrictiveDirection: 'none',
    rationale:
      'A surface cannot host two concurrent games, and neither can a full pitch and one of its own halves. Kept separate from field adjacency on purpose: adjacency has changed hardness once already, and demoting it must never make two games on the identical patch of grass legal.',
    source: {
      setBy: 'club operations',
      setAt: null,
      reference:
        'fixtures/season-2026/facility_geometry.json — parent/child field configuration (Pitch 1 -> 1A/1B, Pitch 4 -> 4A/4B)',
      note: 'a physical fact of the site rather than a decision anybody dated',
    },
    effectiveFrom: null,
    effectiveTo: null,
    enforcement: CONSTRAINT_ENFORCEMENT.REASON_CODES,
    reasonCodes: [
      FACILITY_REASON.OCCUPIED_SAME_SURFACE,
      FACILITY_REASON.OCCUPIED_PARENT_CHILD,
      TIMING_REASON.WARMUP_OCCUPIED_SAME_SURFACE,
      TIMING_REASON.WARMUP_OCCUPIED_PARENT_CHILD,
    ],
    weight: null,
    waivable: false,
    history: [],
  },

  {
    id: SEASON_2026_CONSTRAINT_ID.TURNOVER_FLOOR_GLOBAL,
    policy: 'turnover-minimum',
    name: 'Turnover floor between games on one field',
    type: CONSTRAINT_TYPE.HARD,
    scope: GLOBAL,
    parameters: { minimumGapMinutes: 10 },
    restrictiveDirection: 'higher',
    rationale:
      'The shortest gap the club will schedule between two games on the same field. Below this a late finish runs straight into the next warm-up.',
    source: {
      setBy: 'club operations',
      setAt: null,
      reference: 'fixtures/season-2026/game_formats.csv — "Turnover min" column (10 for 4v4-9v9)',
      note: 'carried as a column in the format table with no recorded decision date',
    },
    effectiveFrom: null,
    effectiveTo: null,
    enforcement: CONSTRAINT_ENFORCEMENT.DECLARED_ONLY,
    reasonCodes: [],
    weight: null,
    waivable: false,
    history: [],
  },

  {
    id: SEASON_2026_CONSTRAINT_ID.TURNOVER_PREFERRED_GLOBAL,
    policy: 'turnover-minimum',
    name: 'Preferred turnover between games on one field',
    type: CONSTRAINT_TYPE.PREFERENCE,
    scope: GLOBAL,
    parameters: { minimumGapMinutes: 20 },
    restrictiveDirection: 'higher',
    rationale:
      'What the club aims for: 20 minutes lets one team clear the field and the next warm up without either being hurried. It is a target, not a floor — the floor is 10.',
    source: {
      setBy: 'club operations',
      setAt: null,
      reference:
        'fixtures/season-2026/game_formats.csv — "Turnover preferred" column (20 for Minis-9v9)',
      note: 'carried as a column in the format table with no recorded decision date',
    },
    effectiveFrom: null,
    effectiveTo: null,
    enforcement: CONSTRAINT_ENFORCEMENT.DECLARED_ONLY,
    reasonCodes: [],
    weight: 1,
    waivable: false,
    history: [],
  },

  {
    id: SEASON_2026_CONSTRAINT_ID.TURNOVER_ORCHARD_PARK,
    policy: 'turnover-minimum',
    name: 'Orchard Park turnover is hard, not preferred',
    type: CONSTRAINT_TYPE.HARD,
    scope: { kind: CONSTRAINT_SCOPE_KIND.VENUE, venueId: ORCHARD_PARK_VENUE_ID },
    parameters: { minimumGapMinutes: 20 },
    restrictiveDirection: 'higher',
    rationale:
      'Orchard Park is traffic constrained: the car park cannot clear one wave of families before the next arrives, so the 20 minutes that is a preference everywhere else is inviolable here. This is GAP-12 in one record — the same policy, a different hardness, narrowed to one venue.',
    source: {
      setBy: 'venue permit holder',
      setAt: null,
      reference:
        'fixtures/season-2026/facility_permits.csv — Orchard Park "SAT default" row, Notes: "traffic constraint: 20-min turnover HARD"; repeated in fixtures/season-2026/facility_geometry.json — venues["Orchard Park"].notes',
      note: 'the permit row carries the constraint but no date on which it was agreed',
    },
    effectiveFrom: null,
    effectiveTo: null,
    enforcement: CONSTRAINT_ENFORCEMENT.DECLARED_ONLY,
    reasonCodes: [],
    weight: null,
    waivable: false,
    history: [],
  },

  {
    id: SEASON_2026_CONSTRAINT_ID.COACH_TRAVEL_BETWEEN_VENUES,
    policy: 'coach-travel-between-venues',
    name: 'Travel time between venues for one coach',
    type: CONSTRAINT_TYPE.SOFT,
    scope: GLOBAL,
    parameters: { minimumGapMinutes: 60 },
    restrictiveDirection: 'higher',
    rationale:
      'A coach with commitments at two venues needs an hour between them. Soft and waivable rather than hard: some venue pairs are five minutes apart, which is exactly the exception the board granted in incident 9 and which Phase 2.2 turns into a waiver record.',
    source: {
      setBy: 'club board',
      setAt: null,
      reference: `${INCIDENT_LOG}, incident 9 (the 60-minute travel floor and its waiver); magnitude restated in the ${BUILD_PLAN}`,
      note: 'incident 9 records that the waiver "lived in a code comment and was lost once across a rebuild", so no dated decision survives',
    },
    effectiveFrom: null,
    effectiveTo: null,
    enforcement: CONSTRAINT_ENFORCEMENT.DECLARED_ONLY,
    reasonCodes: [],
    weight: 60,
    waivable: true,
    history: [],
  },

  {
    id: SEASON_2026_CONSTRAINT_ID.COACH_TRAVEL_WITHIN_VENUE,
    policy: 'coach-travel-within-venue',
    name: 'Walking time within one venue complex for one coach',
    type: CONSTRAINT_TYPE.SOFT,
    scope: GLOBAL,
    parameters: { minimumGapMinutes: 15 },
    restrictiveDirection: 'higher',
    rationale:
      'Moving between fields on one site is a walk, not a drive, so a quarter of an hour is enough. Kept as its own policy rather than as a rival to the between-venues rule: the two never apply to the same pair of commitments, so they must not compete for precedence.',
    source: {
      setBy: 'club operations',
      setAt: null,
      reference: `${BUILD_PLAN} — "Coach travel: 60 min between venues, 15 min within one venue complex"`,
      note: 'no corpus file carries the within-venue figure; it is the operator’s statement of standing practice',
    },
    effectiveFrom: null,
    effectiveTo: null,
    enforcement: CONSTRAINT_ENFORCEMENT.DECLARED_ONLY,
    reasonCodes: [],
    weight: 15,
    waivable: true,
    history: [],
  },

  {
    id: SEASON_2026_CONSTRAINT_ID.COACH_MAXIMUM_GAP,
    policy: 'coach-maximum-gap',
    name: 'Keep a coach’s day compact',
    type: CONSTRAINT_TYPE.PREFERENCE,
    scope: GLOBAL,
    parameters: { maximumGapMinutes: 180 },
    restrictiveDirection: 'lower',
    rationale:
      'Nobody should sit at a venue for half a day between commitments. Stated as "where possible", which is precisely a preference: there is no violation to report, only a schedule to optimise toward. Incident 5 is what it exists to prevent — a coach left with a 6.5-hour gap because a scrimmage was appended after solving.',
    source: {
      setBy: 'club operations',
      setAt: null,
      reference: `${BUILD_PLAN} — "Coach maximum gap: 3 hours where possible"; motivating failure in ${INCIDENT_LOG}, incident 5`,
      note: 'stated as standing practice with no recorded decision date',
    },
    effectiveFrom: null,
    effectiveTo: null,
    enforcement: CONSTRAINT_ENFORCEMENT.DECLARED_ONLY,
    reasonCodes: [],
    weight: 1,
    waivable: false,
    history: [],
  },

  {
    id: SEASON_2026_CONSTRAINT_ID.ROUND_ROBIN_COMPLETENESS,
    policy: 'round-robin-completeness',
    name: 'Every division plays a complete round robin',
    type: CONSTRAINT_TYPE.HARD,
    scope: GLOBAL,
    parameters: { maxOpponentCountSpread: 1 },
    restrictiveDirection: 'lower',
    rationale:
      'Within a division every team must meet every other, and the number of times any two teams meet may differ by at most one. A season that quietly drops a fixture pairing is not a season anybody agreed to.',
    source: {
      setBy: 'club operations',
      setAt: null,
      reference: `${INVARIANTS} — "Round-robin complete within every division; opponent counts differ by at most 1"`,
      note: 'recorded as a corpus invariant rather than as a dated decision',
    },
    effectiveFrom: null,
    effectiveTo: null,
    enforcement: CONSTRAINT_ENFORCEMENT.DECLARED_ONLY,
    reasonCodes: [],
    weight: null,
    waivable: false,
    history: [],
  },

  {
    id: SEASON_2026_CONSTRAINT_ID.HOME_AWAY_BALANCE,
    policy: 'home-away-balance',
    name: 'Hosting balance over a nine-game season',
    type: CONSTRAINT_TYPE.HARD,
    scope: GLOBAL,
    parameters: { gamesPerTeam: 9, minHomeGames: 4, maxHomeGames: 5 },
    restrictiveDirection: 'none',
    rationale:
      'Nine games do not divide evenly, so every team hosts four or five. Hard because a team hosting three or six is a complaint from a parent, not a rounding artefact.',
    source: {
      setBy: 'club operations',
      setAt: null,
      reference: `${INVARIANTS} — "Every rec team plays exactly 9 games, hosting 4 or 5"`,
      note: 'recorded as a corpus invariant rather than as a dated decision',
    },
    effectiveFrom: null,
    effectiveTo: null,
    enforcement: CONSTRAINT_ENFORCEMENT.DECLARED_ONLY,
    reasonCodes: [],
    weight: null,
    waivable: false,
    history: [],
  },

  {
    id: SEASON_2026_CONSTRAINT_ID.KICKOFF_VARIETY,
    policy: 'kickoff-variety',
    name: 'Spread each team’s kickoff times across the season',
    type: CONSTRAINT_TYPE.PREFERENCE,
    scope: GLOBAL,
    parameters: { maxSameSlotGames: 4, ofGames: 9 },
    restrictiveDirection: 'lower',
    rationale:
      'No family should get the 8:30 slot every week. A preference, not a rule: there is no such thing as an illegal kickoff time here, only a less pleasant distribution.',
    source: {
      setBy: 'club operations',
      setAt: null,
      reference: `${BUILD_PLAN} — "Kickoff variety: no team in the same slot more than 4 of 9"`,
      note: 'stated as standing practice; no corpus file records the threshold',
    },
    effectiveFrom: null,
    effectiveTo: null,
    enforcement: CONSTRAINT_ENFORCEMENT.DECLARED_ONLY,
    reasonCodes: [],
    weight: 1,
    waivable: false,
    history: [],
  },

  {
    id: SEASON_2026_CONSTRAINT_ID.CONFLICT_FAIRNESS,
    policy: 'conflict-fairness',
    name: 'Coach conflicts are shared evenly within an age group',
    type: CONSTRAINT_TYPE.HARD,
    scope: GLOBAL,
    parameters: { maxConflictSpread: 1 },
    restrictiveDirection: 'lower',
    rationale:
      'A coach conflict means a team plays with its co-coach covering. Within an age group no team may carry two or more of them than another: the burden is unavoidable, its concentration on one team is not.',
    source: {
      setBy: 'club operations',
      setAt: null,
      reference: `${INVARIANTS} — "within every age group the conflict spread is ≤ 1"`,
      note: 'recorded as a corpus invariant rather than as a dated decision',
    },
    effectiveFrom: null,
    effectiveTo: null,
    enforcement: CONSTRAINT_ENFORCEMENT.DECLARED_ONLY,
    reasonCodes: [],
    weight: null,
    waivable: false,
    history: [],
  },

  {
    id: SEASON_2026_CONSTRAINT_ID.SUNSET_MARGIN,
    policy: 'sunset-margin',
    name: 'Unlit games finish before dusk',
    type: CONSTRAINT_TYPE.HARD,
    scope: GLOBAL,
    parameters: { marginMinutes: 15 },
    restrictiveDirection: 'higher',
    rationale:
      'On unlit ground a game must be over fifteen minutes before sunset. The margin is the safety, not the sunset itself: a game finishing at last light is a game finishing in the dark.',
    source: {
      setBy: 'club operations',
      setAt: null,
      reference: `${INVARIANTS} — "No unlit game ends within 15 min of sunset"; per-date sunsets in fixtures/season-2026/sunsets.csv`,
      note: 'recorded as a corpus invariant rather than as a dated decision. Enforced in core evaluation only (availability/kickoff.js, the rule engine); the live game path -- gameScheduling.js and the Edge game functions -- reads no sunset, so there it is declared, not enforced (8.9 plan, F2 and D7)',
    },
    effectiveFrom: null,
    effectiveTo: null,
    enforcement: CONSTRAINT_ENFORCEMENT.REASON_CODES,
    reasonCodes: [AVAILABILITY_REASON.SUNSET_MARGIN_VIOLATED],
    weight: null,
    waivable: false,
    history: [],
  },

  {
    id: SEASON_2026_CONSTRAINT_ID.PERMIT_WINDOW,
    policy: 'permit-window',
    name: 'Games sit inside their venue permit',
    type: CONSTRAINT_TYPE.HARD,
    scope: GLOBAL,
    parameters: {},
    restrictiveDirection: 'none',
    rationale:
      'A game outside the permit window is a game on ground the club has no right to use, including the blackout dates where the permit is absent entirely. Not negotiable by the scheduler at any price.',
    source: {
      setBy: 'venue permit holder',
      setAt: null,
      reference:
        'fixtures/season-2026/facility_permits.csv — per-venue windows, the 09/12 early open and the 09/19 "NO PERMIT this date" blackout',
      note: 'the permit table carries the windows but no date on which each was issued',
    },
    effectiveFrom: null,
    effectiveTo: null,
    enforcement: CONSTRAINT_ENFORCEMENT.REASON_CODES,
    reasonCodes: [
      AVAILABILITY_REASON.PERMIT_OPEN_PRECEDED,
      AVAILABILITY_REASON.PERMIT_CLOSE_EXCEEDED,
      AVAILABILITY_REASON.PERMIT_BLACKOUT,
    ],
    weight: null,
    waivable: false,
    history: [],
  },
]);

/**
 * The practice daylight claim (8.9 PR 4): unlit practices end by sunset.
 *
 * **Kept out of {@link SEASON_2026_CONSTRAINTS} on purpose.** That set is the
 * registry the rule engine and the feasibility queries run over, and both
 * treat a hard constraint no *game* rule claims as unenforced: added there,
 * this record would put `RULE_CONSTRAINT_UNENFORCED` into every game run and
 * turn every feasible game answer into `unknown` -- a change to game results
 * the 8.9 plan rules out. It governs practices, which the rule engine does not
 * evaluate; its evaluator is `practice/daylight.js`, and
 * {@link buildSeason2026PracticeConstraintRegistry} is the registry that
 * carries it.
 *
 * @type {Readonly<Object>}
 */
export const SEASON_2026_PRACTICE_DAYLIGHT_CONSTRAINT = Object.freeze({
  id: PRACTICE_DAYLIGHT_CONSTRAINT_ID,
  policy: 'practice-daylight',
  name: 'Unlit practices end by sunset',
  type: CONSTRAINT_TYPE.HARD,
  scope: GLOBAL,
  parameters: { marginMinutes: PRACTICE_SUNSET_MARGIN_MINUTES },
  restrictiveDirection: 'higher',
  rationale:
    'On unlit or undeclared ground a practice must end at or before sunset (floor of the minute). The civil twilight after sunset is the teardown window for equipment, not practice time; games keep their own fifteen-minute margin.',
  source: {
    setBy: 'operator',
    setAt: '2026-09-27',
    reference:
      'docs/PHASE_8_9_PLAN.md — operator ruling 2026-09-27 ("teams don\'t practice after sunset at unlit fields, and the right margin is sunset"); decisions D1, D2, D5, D6',
    note: 'enforced in core evaluation by practice/daylight.js over materialised occurrences. Not enforced by the core practiceScheduling.js or autoScheduler.js, which do not call it: the live practice scheduler is the Deno auto-scheduler, whose daylight post-pass (8.9 PR 6) enforces it on the placements a run produces -- truncating each at its first date past sunset, the remainder TIME TBD -- and reports, never changes, locked rows past sunset; an unlit venue with no coordinates is flagged there, not refused (D4). practice/repair.js (8.9 PR 7) refuses every re-home candidate that runs past sunset or whose sunset is unknown: enforced in that module, not live until 8.6 3b PRs 9-11 wire the repair. The season adapts through practice/durationPhases.js (8.9 PR 5): duration phases, hold-start and cascade compression, the DST survival report. Those report and propose; cascade proposals are 8.8 change-log entries and are never applied. Optimising toward surviving slots is declared, not optimised (D11): no durations, starts or nights are chosen to maximise survivors',
  },
  effectiveFrom: null,
  effectiveTo: null,
  enforcement: CONSTRAINT_ENFORCEMENT.REASON_CODES,
  reasonCodes: [AVAILABILITY_REASON.PRACTICE_PAST_SUNSET],
  weight: null,
  waivable: false,
  history: [],
});

/**
 * Build the seeded registry.
 *
 * @param {{ extraConstraints?: ReadonlyArray<Object> }} [options]
 * @returns {import('../types.js').ConstraintRegistry}
 */
export function buildSeason2026ConstraintRegistry(options = {}) {
  return buildConstraintRegistry({
    name: 'season-2026',
    source: 'fixtures/season-2026 + the incident log',
    constraints: [...SEASON_2026_CONSTRAINTS, ...(options.extraConstraints ?? [])],
  });
}

/**
 * The seeded registry plus the practice daylight claim: the registry a
 * practice evaluation resolves `PRACTICE_PAST_SUNSET` through. The game
 * registry above is unchanged by it.
 *
 * @param {{ extraConstraints?: ReadonlyArray<Object> }} [options]
 * @returns {import('../types.js').ConstraintRegistry}
 */
export function buildSeason2026PracticeConstraintRegistry(options = {}) {
  return buildSeason2026ConstraintRegistry({
    extraConstraints: [
      SEASON_2026_PRACTICE_DAYLIGHT_CONSTRAINT,
      ...(options.extraConstraints ?? []),
    ],
  });
}
