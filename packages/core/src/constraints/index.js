/**
 * Barrel for the constraint registry.
 *
 * Every public export of `constraints/` goes through this file, exactly as
 * `packages/core/src/facility/index.js`, `timing/index.js` and
 * `availability/index.js` do for their modules.
 *
 * The package is pure domain logic: no React, no `node:*`, no `Date`
 * construction, and **no import from `fixtures/`**. The arrow points
 * fixtures -> constraints, never back; the season-2026 adapter is a
 * transcription of records the corpus and the incident log already contain, and
 * takes no arguments at all. It *does* import `facility/`, `timing/` and
 * `availability/` — for their reason-code severity tables only, because those
 * tables are the seam through which hardness becomes data (GAP-12).
 *
 * What this module deliberately does **not** do: it does not touch
 * `gameScheduling.js`, `autoScheduler.js` or `gameMetrics.js`. Those solvers are
 * week-indexed while everything here is date-indexed, and wiring the registry
 * into them is Phase 4. `packages/core/src/placement/` is a bounded
 * demonstration harness that shows the registry changing an outcome; it is not
 * that wiring and does not pretend to be.
 *
 * Phase 2 is **in-memory only**. There is no SQL home for constraint records
 * yet and this work deliberately does not create one: the schema belongs to the
 * phase that has real persistence requirements, not to the phase that is still
 * settling the model.
 *
 * @module constraints
 */

export {
  CONSTRAINT_ENFORCEMENT,
  CONSTRAINT_REASON,
  CONSTRAINT_REASON_SEVERITY,
  CONSTRAINT_SCOPE_KIND,
  CONSTRAINT_SCOPE_SPECIFICITY,
  CONSTRAINT_SEVERITY,
  CONSTRAINT_STATUS,
  CONSTRAINT_TYPE,
  CONSTRAINT_TYPE_RANK,
  CONSTRAINT_TYPE_SEVERITY,
  constraintSeverityOf,
  createConstraintMeta,
  deriveConstraintStatus,
  makeConstraintFinding,
  mergeConstraintMeta,
  severityForType,
  specificityOf,
  typeRankOf,
} from './reasonCodes.js';

export {
  BASE_REASON_CODES,
  BASE_REASON_SEVERITY,
  REASON_CODE_OWNER,
  baseSeverityOf,
  isKnownReasonCode,
} from './baseSeverity.js';

export {
  ConstraintRecordSchema,
  ConstraintRegistryInputSchema,
  ConstraintScopeSchema,
  ConstraintSourceSchema,
  ConstraintTypeChangeSchema,
  ScopeContextSchema,
} from './schemas.js';

export {
  judgeApplicability,
  judgeScope,
  judgeWindow,
  moreRestrictiveOf,
  normaliseContext,
  pickByPrecedence,
  recordsAgree,
} from './scope.js';

export {
  activeConstraintsOn,
  buildConstraintRegistry,
  constraintsForPolicy,
  constraintsForReasonCode,
  getConstraint,
  requireConstraint,
  resolveConstraints,
  resolvePolicy,
  retypeConstraint,
} from './registry.js';

export {
  applyRegistrySeverity,
  baseSeverityTable,
  effectiveSeverityTable,
  governedReasonCodes,
  severityUnder,
} from './severity.js';

export {
  PROJECTION_AUTHOR,
  PROJECTION_DEFAULT_WEIGHT,
  PROJECTION_NOTE,
  severityMatrixFor,
  whatIfConstraintType,
} from './whatIf.js';

export {
  ORCHARD_PARK_VENUE_ID,
  SEASON_2026_CONSTRAINTS,
  SEASON_2026_CONSTRAINT_ID,
  SEASON_2026_PRACTICE_DAYLIGHT_CONSTRAINT,
  buildSeason2026ConstraintRegistry,
  buildSeason2026PracticeConstraintRegistry,
} from './adapters/season2026Constraints.js';
