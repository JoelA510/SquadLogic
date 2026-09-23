/**
 * Barrel for the person-centric model.
 *
 * Every public export of `people/` goes through this file, exactly as
 * `packages/core/src/facility/index.js`, `timing/index.js`,
 * `availability/index.js`, `constraints/index.js` and `waivers/index.js` do for
 * their modules.
 *
 * The package is pure domain logic: no React, no `node:*`, no `Date`
 * construction, and **no import from `fixtures/`**. The arrow points
 * fixtures -> people, never back; the season-2026 adapter takes the
 * already-parsed roster rows and season object as arguments, so this module
 * never learns where the corpus lives or how it is read.
 *
 * ## What supersedes what
 *
 * Prompt 2.2's `waivers/coachTravel.js` says in its own docstring that Prompt
 * 3.1 supersedes it. What it was missing turned out to be narrower than that
 * sentence implies, and the honest disposition is worth stating: the travel
 * evaluator was **already** person-centric and already judged *consecutive*
 * same-day pairs. What it did not do — and said it did not do — was build the
 * commitment list. That is this module.
 *
 * So the travel judgement stays in `waivers/`, where the waiver seam lives
 * (`travelConstraintIdByCode()`, incident 9's board exception, the ledger that
 * excepts it), and `people/` supplies it a *complete* timeline through
 * {@link toTravelCommitments}. Moving the evaluator here would have relocated a
 * waiver-shaped concern into a module with no waivers in it, and would have
 * churned three green Phase 2 suites to end up at the same behaviour.
 *
 * What this module deliberately does **not** do: it does not touch
 * `gameScheduling.js`, `autoScheduler.js`, `gameMetrics.js` or
 * `gameValidation.js`. `gameValidation.checkCoachConflict()` remains the
 * pairwise drag-and-drop check it always was; `timeline.js` documents why that
 * shape is wrong for season-scale validation, and `tests/people.test.js`
 * demonstrates it on a constructed day rather than asserting it.
 *
 * Phase 3 is **in-memory only**. There is no SQL home for a person, an
 * assignment or a timeline, and this work deliberately does not create one.
 *
 * @module people
 */

export {
  ACTIVE_ASSIGNMENT_STATUSES,
  ASSIGNMENT_STATUS,
  ATTENDANCE_OUTCOME,
  COMMITMENT_SOURCE,
  COMMITMENT_SOURCES,
  IDENTITY_REVIEW_STATE,
  IDENTITY_SIGNAL,
  IDENTITY_SIGNAL_WEIGHT,
  MUST_ATTEND_BASIS,
  PEOPLE_POLICY_BY_CODE,
  PEOPLE_REASON,
  PEOPLE_REASON_SEVERITY,
  PEOPLE_SEVERITY,
  PEOPLE_STATUS,
  PERSONAL_CONSTRAINT_KIND,
  createPeopleMeta,
  derivePeopleStatus,
  makePeopleFinding,
  mergePeopleMeta,
  peopleSeverityOf,
} from './reasonCodes.js';

export {
  CoachAssignmentSchema,
  CoachListEntrySchema,
  CoachListSourceSchema,
  CoachListSourcesSchema,
  CoachRosterInputSchema,
  IdentityDecisionSchema,
  PersonCommitmentSchema,
  PersonSchema,
  PersonalConstraintPolicyInputSchema,
  PersonalConstraintSchema,
} from './schemas.js';

export {
  COACH_CELL_SEPARATOR,
  COACH_KEY_KIND,
  COACH_ORDER_DISAGREEMENT,
  COACH_SOURCE_DISAGREEMENT_CODES,
  coachDisplayText,
  coachExportCells,
  coachIdentityKey,
  coachesOfTeamRow,
  compareCoaches,
  formatCoachEmails,
  formatCoachList,
  legacyTeamCoachSource,
  reconcileTeamCoaches,
  teamCoachSources,
  teamsWithCoachSourceDisagreement,
  teamsWithUncorroboratedCoachIdentity,
} from './coachList.js';

export {
  TEAM_COACH_ROLE,
  applyCoachChange,
  assignmentRowCovers,
  coachChangeConsequence,
  coachChangeRefusal,
  coachColumnDrift,
  coachesOfTeamOn,
  rosterInputFromAssignmentRows,
} from './assignmentHistory.js';

export {
  buildCoachRoster,
  coCoachesOf,
  coachSlotOf,
  soleCoachRiskRegister,
  teamsCoachedBy,
  windowCoversDate,
} from './roster.js';

export {
  MAXIMUM_GAP_POLICY,
  buildPersonDays,
  createTimelineSet,
  evaluatePersonDays,
  findAttendanceClashes,
  ingestCommitments,
  personTimeline,
  requireSealedTimelines,
  sealTimelines,
  toTravelCommitments,
} from './timeline.js';

export {
  EMPTY_PERSONAL_CONSTRAINT_POLICY,
  buildPersonalConstraintPolicy,
  deriveMustAttend,
  isMustAttend,
  resolveAttendance,
} from './mustAttend.js';

export {
  IDENTITY_DEFAULTS,
  applyIdentityDecisions,
  buildIdentityReviewQueue,
  distinctIdentityCount,
  isContraction,
  jaro,
  jaroWinkler,
  normaliseNamePart,
  scoreIdentityPair,
  sharedPrefixLength,
} from './identity.js';

export {
  SEASON_2026_COMMITMENT_SOURCES,
  SEASON_2026_SOURCE_BY_ROW_KIND,
  buildSeason2026CoachRoster,
  buildSeason2026Timelines,
  season2026AssignmentStatus,
  season2026UncoachedFixtures,
  toSeason2026CoachAssignments,
  toSeason2026CommitmentBatches,
  toSeason2026People,
} from './adapters/season2026People.js';
