/**
 * A narrow coach-travel evaluator — **and an honest statement of what it is
 * not**.
 *
 * ## Why this exists here
 *
 * Incident 9 waives the 60-minute inter-venue travel floor. Prompt 2.1 recorded
 * that floor as a constraint (`coach-travel-between-venues`, `soft`,
 * `waivable`, `minimumGapMinutes: 60`) but recorded it as **`declared-only`**,
 * because no module emits a coach-travel reason code: the person-centric
 * timeline that would produce one is Prompt 3.1. A waiver engine with nothing
 * to waive is a waiver engine nobody has tested, so this module supplies the
 * missing evaluation — narrowly, and saying so.
 *
 * **This is a proper evaluator, not a test fixture** (it is exercised by the
 * acceptance test, but it lives in the package and is exported from the
 * barrel). What makes it narrow:
 *
 * - It takes an explicit list of commitments. It does **not** build them: no
 *   roster join, no identity resolution, no external-commitment ingestion. That
 *   is the personal timeline, it is GAP-19, and it is Prompt 3.1's subject.
 * - It judges **consecutive same-day pairs for one person** and nothing else.
 *   No maximum-gap preference, no fairness, no whole-day shape.
 * - It reads its numbers from the registry (`resolvePolicy`) rather than
 *   carrying any, so when 3.1 generalises it there is no second copy of "60" to
 *   find.
 *
 * ## What Prompt 3.1 actually did, and why this file stayed
 *
 * The paragraph that used to stand here predicted that 3.1 would move these
 * reason codes into the module that owns personal timelines. It did not, and
 * the reason is worth recording rather than quietly dropping.
 *
 * `packages/core/src/people/` supplies the missing half — the roster join,
 * identity resolution, external-commitment ingestion and the sealed timeline —
 * and hands this evaluator a *complete* commitment list through
 * `people/timeline.js` `toTravelCommitments()`. What it did **not** need to
 * change is the judgement itself: this function was already grouped by person,
 * already sorted, and already judging *consecutive* same-day pairs, which is
 * exactly the model Prompt 3.1's requirement 1 asks for. The pairwise
 * team-comparison the build plan condemns is `gameValidation.checkCoachConflict()`,
 * not this.
 *
 * Moving the codes would also have moved the **waiver seam** —
 * {@link travelConstraintIdByCode}, incident 9's board exception and the ledger
 * that excepts it — into a module with no waivers in it, and would have churned
 * three green Phase 2 suites to arrive at the same behaviour. So the codes stay
 * here, the constraint stays `declared-only`, and
 * {@link travelConstraintIdByCode} stays necessary.
 *
 * `people/reasonCodes.js` makes the same call for the same reason and says so.
 *
 * ## Which floor applies: the complex, not the venue name
 *
 * Whether a pair of commitments is a *walk* or a *drive* is decided by
 * `facility/venueComplex.js`, not by `from.venueId === to.venueId`. Two
 * separately-named venues that an operator has declared to be one complex —
 * `Maplewood Back` and `Maplewood Front` — take the 15-minute walking floor,
 * and every other pair takes the 60-minute drive floor.
 *
 * Before that, name equality was the whole test, and the 15-minute rule the
 * registry describes as *"within one venue complex"* was structurally
 * unreachable for the case it was written for: it could only ever fire for two
 * commitments at the *identical* venue. On the published season-2026 schedule
 * that misread produced 18 inter-venue shortfalls across five coaches, 17 of
 * them Maplewood-to-Maplewood. Incident 9 records the board waiving the floor
 * for **one** coach, which is one genuine inter-venue case, not five.
 *
 * The complex map is a **parameter**, defaulting to
 * {@link EMPTY_VENUE_COMPLEX_MAP} — which reproduces venue-name equality
 * exactly, because a venue is always its own site. A caller with a real season
 * must pass the season's declared map; `ruleEngine/rules.js` demands it as a
 * required resource rather than defaulting, so a run cannot silently lose it.
 *
 * ## Why the codes are not in `BASE_REASON_SEVERITY` yet
 *
 * Registering them there is precisely the act of saying "a constraint record
 * may claim this code", and the seeded coach-travel record must not claim one
 * while nothing generalises this evaluator to the whole season. Registering
 * them early would let the registry look wired when it is not — which is the
 * thing this phase was told not to pretend.
 *
 * ## Where severity comes from
 *
 * Not from a frozen table, and not from a call site either: from the
 * **constraint record's own `type`**, through `severityForType()` — the same
 * table `constraints/severity.js` uses. A `soft` travel record makes a short
 * gap a `compromise`; retype the record to `hard` and the identical gap becomes
 * `blocking`, with no edit here. That is GAP-12 working exactly as intended,
 * and it is why {@link TRAVEL_REASON_SEVERITY} is only a *fallback* for the
 * case where no record governs the policy at all.
 *
 * @module waivers/coachTravel
 */

import { z } from 'zod';

import {
  CONSTRAINT_SEVERITY,
  deriveConstraintStatus,
  severityForType,
} from '../constraints/reasonCodes.js';
import { resolvePolicy } from '../constraints/registry.js';
import {
  EMPTY_VENUE_COMPLEX_MAP,
  complexIdOf,
  sameVenueComplex,
} from '../facility/venueComplex.js';

/** The two policies this evaluator speaks to, spelled once. */
export const TRAVEL_POLICY = Object.freeze({
  BETWEEN_VENUES: 'coach-travel-between-venues',
  WITHIN_VENUE: 'coach-travel-within-venue',
});

/**
 * Every reason this evaluator can give.
 *
 * @readonly
 * @enum {string}
 */
export const TRAVEL_REASON = Object.freeze({
  /** Two commitments at different venues are closer together than the floor. */
  TRAVEL_BETWEEN_VENUES_TOO_SHORT: 'TRAVEL_BETWEEN_VENUES_TOO_SHORT',
  /** Two commitments at one site are closer together than the walking floor. */
  TRAVEL_WITHIN_VENUE_TOO_SHORT: 'TRAVEL_WITHIN_VENUE_TOO_SHORT',
  /**
   * The two commitments are at **different venues in one complex**, so the
   * walking floor applied rather than the drive floor.
   *
   * `info`, and reported whether or not the gap passes: a reader looking at a
   * 30-minute gap judged against a 15-minute minimum needs to be told *why*
   * that was the applicable rule, and silence would leave the 60-minute floor
   * looking as though it had been forgotten. Provenance, never a violation —
   * `info` findings do not move a status or a disposition.
   */
  TRAVEL_WITHIN_COMPLEX_CROSS_VENUE: 'TRAVEL_WITHIN_COMPLEX_CROSS_VENUE',
  /**
   * Two commitments overlap in time. Always `blocking` and never a travel
   * question: no gap policy makes a person able to be in two places at once,
   * so this one deliberately does **not** take its severity from the record.
   */
  TRAVEL_COMMITMENTS_OVERLAP: 'TRAVEL_COMMITMENTS_OVERLAP',
  /**
   * A commitment has no known end (GAP-14: the corpus's four `Scrimmage` rows
   * have no `game_formats.csv` entry), so the gap after it cannot be measured.
   * `compromise`, never `info` — reporting "no travel problem" for a commitment
   * of unknown length is a lie dressed as a pass.
   */
  TRAVEL_FOOTPRINT_UNKNOWN: 'TRAVEL_FOOTPRINT_UNKNOWN',
  /** No constraint record governs the travel policy in this context. */
  TRAVEL_POLICY_UNGOVERNED: 'TRAVEL_POLICY_UNGOVERNED',
  /** The evaluator examined zero transitions. Incident 4. */
  TRAVEL_SCAN_VACUOUS: 'TRAVEL_SCAN_VACUOUS',
});

/**
 * Fallback severity, used **only** when no constraint record governs the
 * policy. When one does, its `type` decides — see the module docstring.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const TRAVEL_REASON_SEVERITY = Object.freeze({
  [TRAVEL_REASON.TRAVEL_BETWEEN_VENUES_TOO_SHORT]: CONSTRAINT_SEVERITY.COMPROMISE,
  [TRAVEL_REASON.TRAVEL_WITHIN_VENUE_TOO_SHORT]: CONSTRAINT_SEVERITY.COMPROMISE,
  [TRAVEL_REASON.TRAVEL_WITHIN_COMPLEX_CROSS_VENUE]: CONSTRAINT_SEVERITY.INFO,
  // Compromise, by the operator's decision on #61: a coach in two places is
  // allowed with a warning, because the team may have a co-coach whose
  // registration is not complete yet. Avoiding it is still preferred, and the
  // placer does (`resolve/stages.js` `chooseSlot()`, pass 2).
  [TRAVEL_REASON.TRAVEL_COMMITMENTS_OVERLAP]: CONSTRAINT_SEVERITY.COMPROMISE,
  [TRAVEL_REASON.TRAVEL_FOOTPRINT_UNKNOWN]: CONSTRAINT_SEVERITY.COMPROMISE,
  [TRAVEL_REASON.TRAVEL_POLICY_UNGOVERNED]: CONSTRAINT_SEVERITY.COMPROMISE,
  [TRAVEL_REASON.TRAVEL_SCAN_VACUOUS]: CONSTRAINT_SEVERITY.COMPROMISE,
});

/** Which policy each gap code belongs to. */
const POLICY_BY_CODE = Object.freeze({
  [TRAVEL_REASON.TRAVEL_BETWEEN_VENUES_TOO_SHORT]: TRAVEL_POLICY.BETWEEN_VENUES,
  [TRAVEL_REASON.TRAVEL_WITHIN_VENUE_TOO_SHORT]: TRAVEL_POLICY.WITHIN_VENUE,
});

/**
 * One commitment on a person's day.
 *
 * `endMinutes` is nullable so a row of unknown footprint stays representable
 * (GAP-14) instead of being coerced into a plausible-looking number.
 */
export const CoachCommitmentSchema = z
  .object({
    id: z.string().min(1),
    personId: z.string().min(1),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { message: 'expected an ISO YYYY-MM-DD date' }),
    startMinutes: z.number().int().min(0),
    endMinutes: z.number().int().min(0).nullable().default(null),
    venueId: z.string().min(1),
    surfaceId: z.string().min(1).nullable().default(null),
    teamId: z.string().min(1).nullable().default(null),
    gameId: z.string().min(1).nullable().default(null),
    label: z.string().min(1).nullable().default(null),
  })
  .strict();

/** Fresh zeroed counters for a travel scan. */
export function createTravelMeta() {
  return {
    commitmentsExamined: 0,
    peopleExamined: 0,
    daysExamined: 0,
    transitionsExamined: 0,
    transitionsJudged: 0,
    /** Transitions between two *different* venue ids. */
    crossVenueTransitions: 0,
    /**
     * Cross-venue transitions the complex map made one site. Zero on a season
     * whose map declares nothing — which is the state that made the walking
     * floor unreachable, so a test can meta-assert the map was consulted rather
     * than assume it (incident 4).
     */
    withinComplexTransitions: 0,
    policiesResolved: 0,
    violationsFound: 0,
  };
}

/**
 * The severity a travel code carries under a given constraint record.
 *
 * @param {string} code - a {@link TRAVEL_REASON} value
 * @param {import('../constraints/types.js').ConstraintRecord|null} record
 * @returns {string}
 */
export function travelSeverityOf(code, record) {
  const fallback = TRAVEL_REASON_SEVERITY[code];
  if (!fallback) {
    throw new Error(`waivers/coachTravel: reason code "${code}" has no registered severity`);
  }
  // Overlap's severity is the operator's policy (#61: compromise, avoid but
  // allow), fixed in the table above: no constraint record moves it either way.
  if (record === null || code === TRAVEL_REASON.TRAVEL_COMMITMENTS_OVERLAP) return fallback;
  if (!(code in POLICY_BY_CODE)) return fallback;
  return severityForType(record.type);
}

/**
 * Build a travel finding. Severity is looked up from two frozen tables — the
 * fallback table above and `CONSTRAINT_TYPE_SEVERITY` — never passed in.
 *
 * @param {string} code
 * @param {string} message
 * @param {Record<string, unknown>} details
 * @param {import('../constraints/types.js').ConstraintRecord|null} [record]
 * @returns {import('../constraints/types.js').ConstraintFinding}
 */
export function makeTravelFinding(code, message, details = {}, record = null) {
  return { code, severity: travelSeverityOf(code, record), message, details };
}

/**
 * The `constraintIdByCode` map `applyWaivers()` needs while coach travel is
 * still `declared-only`.
 *
 * Resolved from the registry rather than spelled out, so a registry that has
 * renamed or removed the travel constraints produces an empty map — and
 * `applyWaivers()` then reports `WAIVER_APPLY_UNLINKED` — instead of a map
 * pointing at ids nothing holds.
 *
 * @param {import('../constraints/types.js').ConstraintRegistry} registry
 * @param {import('../constraints/types.js').ScopeContext} [context]
 * @returns {Record<string, string>}
 */
export function travelConstraintIdByCode(registry, context = {}) {
  /** @type {Record<string, string>} */
  const map = {};
  for (const [code, policy] of Object.entries(POLICY_BY_CODE)) {
    const resolved = resolvePolicy(registry, policy, context);
    if (resolved.effective) map[code] = resolved.effective.id;
  }
  return map;
}

/**
 * Evaluate every consecutive same-day pair of commitments for every person.
 *
 * @param {ReadonlyArray<Object>} commitments - see {@link CoachCommitmentSchema}
 * @param {{ registry: import('../constraints/types.js').ConstraintRegistry, venueComplexes?: import('../facility/types.js').VenueComplexMap }} options
 *   - `venueComplexes` decides walk vs drive; it defaults to
 *     {@link EMPTY_VENUE_COMPLEX_MAP}, under which every distinct venue is its
 *     own site
 * @returns {{ transitions: Array<Object>, subjects: import('./types.js').WaiverSubject[], findings: import('../constraints/types.js').ConstraintFinding[], meta: ReturnType<typeof createTravelMeta>, status: string }}
 */
export function evaluateCoachTravel(commitments, options) {
  const { registry, venueComplexes = EMPTY_VENUE_COMPLEX_MAP } = options;
  const meta = createTravelMeta();
  /** @type {import('../constraints/types.js').ConstraintFinding[]} */
  const scanFindings = [];
  /** @type {Array<Object>} */
  const transitions = [];

  const parsed = commitments.map((commitment) => CoachCommitmentSchema.parse(commitment));
  meta.commitmentsExamined = parsed.length;

  /** @type {Map<string, Map<string, Array<Object>>>} */
  const byPersonAndDate = new Map();
  for (const commitment of parsed) {
    if (!byPersonAndDate.has(commitment.personId))
      byPersonAndDate.set(commitment.personId, new Map());
    const days = /** @type {Map<string, Array<Object>>} */ (
      byPersonAndDate.get(commitment.personId)
    );
    if (!days.has(commitment.date)) days.set(commitment.date, []);
    /** @type {Array<Object>} */ (days.get(commitment.date)).push(commitment);
  }

  /** @type {Map<string, import('../constraints/types.js').ResolvedPolicy>} */
  const resolutionCache = new Map();
  /**
   * @param {string} policy
   * @param {string} date
   * @param {string} personId
   * @returns {import('../constraints/types.js').ResolvedPolicy}
   */
  const resolve = (policy, date, personId) => {
    const key = `${policy}|${date}|${personId}`;
    const cached = resolutionCache.get(key);
    if (cached) return cached;
    const resolved = resolvePolicy(registry, policy, { date, personId });
    meta.policiesResolved += 1;
    scanFindings.push(...resolved.findings);
    resolutionCache.set(key, resolved);
    return resolved;
  };

  for (const [personId, days] of [...byPersonAndDate.entries()].sort((a, b) =>
    a[0].localeCompare(b[0])
  )) {
    meta.peopleExamined += 1;
    for (const [date, entries] of [...days.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      meta.daysExamined += 1;
      const ordered = [...entries].sort((a, b) =>
        a.startMinutes === b.startMinutes
          ? String(a.id).localeCompare(String(b.id))
          : a.startMinutes - b.startMinutes
      );

      for (let index = 0; index < ordered.length - 1; index += 1) {
        const from = ordered[index];
        const to = ordered[index + 1];
        meta.transitionsExamined += 1;
        const sameVenue = from.venueId === to.venueId;
        // One *site*, which is not the same question as one venue name: two
        // venues an operator has declared to be one complex are a walk apart.
        const oneSite = sameVenueComplex(venueComplexes, from.venueId, to.venueId);
        // Null unless the complex is what made the two one site: naming the
        // `from` venue's complex on a transition that leaves it would read as
        // though the complex governed a decision it had no part in.
        const complexId = oneSite ? complexIdOf(venueComplexes, from.venueId) : null;
        const crossVenueWithinComplex = oneSite && !sameVenue;
        if (!sameVenue) meta.crossVenueTransitions += 1;
        if (crossVenueWithinComplex) meta.withinComplexTransitions += 1;
        const policy = oneSite ? TRAVEL_POLICY.WITHIN_VENUE : TRAVEL_POLICY.BETWEEN_VENUES;
        const code = oneSite
          ? TRAVEL_REASON.TRAVEL_WITHIN_VENUE_TOO_SHORT
          : TRAVEL_REASON.TRAVEL_BETWEEN_VENUES_TOO_SHORT;
        const id = `${personId}|${date}|${from.id}->${to.id}`;
        /** @type {import('../constraints/types.js').ConstraintFinding[]} */
        const findings = [];

        if (from.endMinutes === null) {
          findings.push(
            makeTravelFinding(
              TRAVEL_REASON.TRAVEL_FOOTPRINT_UNKNOWN,
              `commitment "${from.id}" has no known end, so the gap before "${to.id}" cannot be measured`,
              { transitionId: id, personId, date, commitmentId: from.id }
            )
          );
          transitions.push(
            buildTransition({
              id,
              personId,
              date,
              from,
              to,
              sameVenue,
              sameComplex: oneSite,
              complexId,
              policy,
              gapMinutes: null,
              minimumGapMinutes: null,
              constraintId: null,
              findings,
            })
          );
          continue;
        }

        meta.transitionsJudged += 1;
        const gapMinutes = to.startMinutes - from.endMinutes;

        if (gapMinutes < 0) {
          meta.violationsFound += 1;
          findings.push(
            makeTravelFinding(
              TRAVEL_REASON.TRAVEL_COMMITMENTS_OVERLAP,
              `"${personId}" is committed to "${from.id}" until ${from.endMinutes} and to "${to.id}" from ${to.startMinutes} on ${date}; the two overlap by ${-gapMinutes} minutes`,
              { transitionId: id, personId, date, gapMinutes, fromId: from.id, toId: to.id }
            )
          );
          transitions.push(
            buildTransition({
              id,
              personId,
              date,
              from,
              to,
              sameVenue,
              sameComplex: oneSite,
              complexId,
              policy,
              gapMinutes,
              minimumGapMinutes: null,
              constraintId: null,
              findings,
            })
          );
          continue;
        }

        // Context, not a verdict: say out loud that two *different* venues were
        // judged as one site, and which complex made them one. Without this a
        // reader sees a 30-minute gap measured against 15 minutes and cannot
        // tell whether the drive floor was applied and passed, deliberately
        // replaced, or simply forgotten.
        if (crossVenueWithinComplex) {
          findings.push(
            makeTravelFinding(
              TRAVEL_REASON.TRAVEL_WITHIN_COMPLEX_CROSS_VENUE,
              `"${personId}" moves from "${from.venueId}" to "${to.venueId}" on ${date}; both belong to venue complex "${complexId}", so the ${gapMinutes}-minute gap is judged as a walk under policy "${policy}" rather than as a drive between venues`,
              {
                transitionId: id,
                personId,
                date,
                policy,
                complexId,
                gapMinutes,
                fromVenueId: from.venueId,
                toVenueId: to.venueId,
                fromId: from.id,
                toId: to.id,
              }
            )
          );
        }

        const resolved = resolve(policy, date, personId);
        const record = resolved.effective;
        const minimum =
          record && typeof record.parameters.minimumGapMinutes === 'number'
            ? record.parameters.minimumGapMinutes
            : null;

        if (minimum === null) {
          findings.push(
            makeTravelFinding(
              TRAVEL_REASON.TRAVEL_POLICY_UNGOVERNED,
              `no constraint record gives policy "${policy}" a minimum gap here, so the ${gapMinutes}-minute gap between "${from.id}" and "${to.id}" cannot be judged`,
              { transitionId: id, personId, date, policy, gapMinutes }
            )
          );
        } else if (gapMinutes < minimum) {
          meta.violationsFound += 1;
          findings.push(
            makeTravelFinding(
              code,
              `"${personId}" has ${gapMinutes} minutes between "${from.id}" at ${from.venueId} and "${to.id}" at ${to.venueId} on ${date}; policy "${policy}" requires ${minimum}`,
              {
                transitionId: id,
                personId,
                date,
                policy,
                constraintId: record.id,
                constraintType: record.type,
                gapMinutes,
                minimumGapMinutes: minimum,
                shortfallMinutes: minimum - gapMinutes,
                fromVenueId: from.venueId,
                toVenueId: to.venueId,
                // Which floor applied and why, on the violation itself: a
                // within-venue shortfall between two *named* venues is a
                // different thing to explain than one inside a single venue.
                sameVenue,
                complexId,
                fromId: from.id,
                toId: to.id,
              },
              record
            )
          );
        }

        transitions.push(
          buildTransition({
            id,
            personId,
            date,
            from,
            to,
            sameVenue,
            sameComplex: oneSite,
            complexId,
            policy,
            gapMinutes,
            minimumGapMinutes: minimum,
            constraintId: record ? record.id : null,
            findings,
          })
        );
      }
    }
  }

  if (meta.transitionsExamined === 0) {
    scanFindings.push(
      makeTravelFinding(
        TRAVEL_REASON.TRAVEL_SCAN_VACUOUS,
        `the travel scan examined ${meta.commitmentsExamined} commitment(s) and found no consecutive same-day pair to judge`,
        { commitmentsExamined: meta.commitmentsExamined, peopleExamined: meta.peopleExamined }
      )
    );
  }

  const findings = [...scanFindings, ...transitions.flatMap((transition) => transition.findings)];

  return {
    transitions,
    subjects: transitions.map((transition) => transition.subject),
    findings,
    meta,
    status: deriveConstraintStatus(findings),
  };
}

/**
 * Assemble one transition and the waiver subject that stands for it.
 *
 * The subject's context names **both** venues, which is what lets incident 9's
 * waiver — scoped to a coach *and a pair of sites* — match this transition and
 * not a different one involving a third venue. The venue ids stay on the
 * context even when both belong to one complex: a waiver is granted over the
 * sites somebody named, and collapsing them to a complex id would silently
 * widen or narrow its scope.
 *
 * `sameVenue` and `sameComplex` are both carried, and they are not the same
 * claim: `sameVenue && !sameComplex` is impossible, while
 * `!sameVenue && sameComplex` is exactly the Maplewood case — one site, two
 * names — and is the reason the walking floor applied.
 *
 * @param {Object} input
 * @returns {Object}
 */
function buildTransition(input) {
  const {
    id,
    personId,
    date,
    from,
    to,
    sameVenue,
    sameComplex,
    complexId,
    policy,
    gapMinutes,
    minimumGapMinutes,
    constraintId,
    findings,
  } = input;
  const venueIds = [...new Set([from.venueId, to.venueId])].sort();
  const teamIds = [...new Set([from.teamId, to.teamId].filter(Boolean))].sort();
  const gameIds = [...new Set([from.gameId, to.gameId].filter(Boolean))].sort();

  // An empty list is left **out** of the context rather than passed in empty:
  // absent means "the subject cannot answer", which a team-scoped waiver must
  // report as unjudged, while an empty list would read as "answered, no match"
  // and drop the waiver silently.
  /** @type {import('./types.js').WaiverContext} */
  const context = { date, personId, venueIds };
  if (teamIds.length > 0) context.teamIds = /** @type {string[]} */ (teamIds);
  if (gameIds.length > 0) context.gameIds = /** @type {string[]} */ (gameIds);

  return {
    id,
    personId,
    date,
    policy,
    sameVenue,
    sameComplex,
    complexId,
    gapMinutes,
    minimumGapMinutes,
    constraintId,
    from,
    to,
    findings,
    status: deriveConstraintStatus(findings),
    subject: {
      id,
      context,
      findings,
      details: {
        personId,
        date,
        policy,
        gapMinutes,
        minimumGapMinutes,
        fromCommitmentId: from.id,
        toCommitmentId: to.id,
        fromVenueId: from.venueId,
        toVenueId: to.venueId,
        sameVenue,
        sameComplex,
        complexId,
      },
    },
  };
}
