/**
 * The three-valued core: what makes an answer `feasible`, `infeasible` or
 * `unknown`, what the binding set is, and where the margin comes from.
 *
 * Nothing in this file evaluates a schedule. It reads verdicts other modules
 * already reached and arranges them into one shape:
 *
 * | it needs | it asks |
 * | --- | --- |
 * | is this placement legal, under the registry | `resolve/legality.js` — `checkPlacement()`, through `attribution/explain.js` |
 * | which of the four edges bind, and by how much | `availability/kickoff.js` — `checkKickoffAvailability()` |
 * | how a finding maps to a constraint kind | `attribution/claims.js` — `groupFindingsByConstraintKind()` |
 * | what a constraint's hardness is here | `constraints/severity.js` — `effectiveSeverityTable()` |
 * | which registry constraint claims a code | `resolve/errors.js` — `registryConstraintIdsFor()` |
 * | does this constraint apply to this context | `constraints/scope.js` — `judgeApplicability()` |
 *
 * ## How "binding" is decided, and why it is a set
 *
 * By probing one minute past the boundary and reading who speaks. A constraint
 * binds at a position when moving one minute later makes *that constraint* raise
 * a finding; if two do, two are binding and neither is the winner. This is the
 * whole reason no limit is compared with another limit anywhere in this package
 * — such a comparison would have to know which margins are already inside which
 * limits, and getting that wrong is exactly how an API starts claiming a
 * precision it does not have.
 *
 * @module feasibility/verdict
 */

import { groupFindingsByConstraintKind } from '../attribution/claims.js';
import { ATTRIBUTION_SOURCE, attributionSourceOf } from '../attribution/reasonCodes.js';
import { checkKickoffAvailability } from '../availability/kickoff.js';
import { CONSTRAINT_SEVERITY, severityForType } from '../constraints/reasonCodes.js';
import { getConstraint } from '../constraints/registry.js';
import { judgeApplicability } from '../constraints/scope.js';
import { applyRegistrySeverity, effectiveSeverityTable } from '../constraints/severity.js';
import { getSurface } from '../facility/facilityGraph.js';
import { registryConstraintIdsFor } from '../resolve/errors.js';
import { bookingsOn } from '../resolve/legality.js';

import {
  FEASIBILITY_REASON,
  FEASIBILITY_THRESHOLD,
  FEASIBILITY_UNKNOWN_BY_CODE,
  makeFeasibilityFinding,
} from './reasonCodes.js';

/**
 * Build one stated unknown.
 *
 * A record, never a flag: `unknown` with nothing attached is as useless as
 * `false`, and the whole reason this module has a third verdict is to carry the
 * reason with it.
 *
 * @param {string} code - a `FEASIBILITY_REASON` value
 * @param {string} subject - what could not be decided, in one noun phrase
 * @param {string} reason - why, in the owner's own words where there is one
 * @param {{ sourceCode?: string|null, constraintId?: string|null, verdictBearing?: boolean, details?: Record<string, unknown> }} [spec]
 * @returns {import('./types.js').FeasibilityUnknown}
 */
export function makeUnknown(code, subject, reason, spec = {}) {
  return {
    code,
    subject,
    reason,
    sourceCode: spec.sourceCode ?? null,
    constraintId: spec.constraintId ?? null,
    verdictBearing: spec.verdictBearing ?? true,
    details: spec.details ?? {},
  };
}

/**
 * Fold a list of unknowns into another, dropping exact duplicates.
 *
 * Keyed on code **and** subject, so "the footprint of game X is unknown" and
 * "the footprint of game Y is unknown" both survive while the same statement
 * arriving by two routes is stated once.
 *
 * @param {import('./types.js').FeasibilityUnknown[]} target
 * @param {ReadonlyArray<import('./types.js').FeasibilityUnknown>} source
 * @returns {import('./types.js').FeasibilityUnknown[]}
 */
export function absorbUnknowns(target, source) {
  const seen = new Set(target.map((entry) => `${entry.code} ${entry.subject}`));
  for (const entry of source) {
    const key = `${entry.code} ${entry.subject}`;
    if (seen.has(key)) continue;
    seen.add(key);
    target.push(entry);
  }
  return target;
}

/**
 * The unknowns implied by a set of reason codes somebody else raised.
 *
 * Table-driven through `FEASIBILITY_UNKNOWN_BY_CODE` rather than a chain of
 * `if`s, so "which codes mean *could not measure*" is one auditable list and a
 * code added to it needs no new branch.
 *
 * @param {ReadonlyArray<{ code: string, message?: string, severity?: string }>} findings
 * @param {string} subject
 * @returns {import('./types.js').FeasibilityUnknown[]}
 */
export function unknownsFromCodes(findings, subject) {
  /** @type {import('./types.js').FeasibilityUnknown[]} */
  const out = [];
  for (const finding of findings) {
    const code = FEASIBILITY_UNKNOWN_BY_CODE[finding.code];
    if (!code) continue;
    absorbUnknowns(out, [
      makeUnknown(code, subject, finding.message ?? finding.code, { sourceCode: finding.code }),
    ]);
  }
  return out;
}

/**
 * Every registry constraint that governs this context and that **no rule
 * enforces**.
 *
 * Rule 4, mechanically. `runRuleEngine()` already reports
 * `RULE_CONSTRAINT_UNENFORCED` for every constraint with no rule behind it and
 * puts the ids on `coverage.unenforcedConstraintIds`; this filters that list to
 * the ones whose scope actually reaches the position being asked about, using
 * `judgeApplicability()` — the registry's own answer to "does this record apply
 * here", not a second scope model.
 *
 * A constraint that governs the subject and that nothing checks makes a
 * would-be `feasible` into `unknown`. It never makes an answer `infeasible`:
 * "nobody looked" is not "it is broken".
 *
 * @param {Object|null} verification - a `runRuleEngine()` result, or null
 * @param {Object} registry - a `ConstraintRegistry`
 * @param {import('../constraints/types.js').ScopeContext} context
 * @param {import('./types.js').FeasibilityMeta} meta
 * @returns {import('./types.js').FeasibilityUnknown[]}
 */
export function unenforcedGoverningConstraints(verification, registry, context, meta) {
  /** @type {import('./types.js').FeasibilityUnknown[]} */
  const out = [];
  const unenforced = verification?.coverage?.unenforcedConstraintIds ?? [];
  for (const constraintId of unenforced) {
    const record = getConstraint(
      /** @type {import('../constraints/types.js').ConstraintRegistry} */ (registry),
      constraintId
    );
    if (!record) continue;
    meta.registryConstraintsTested += 1;
    // `applicable` is the registry's own three-part answer (in window, in
    // scope, judged). A record it could not *judge* is carried too: an
    // unenforced constraint whose applicability is undecided is two unknowns
    // stacked, and dropping it would be the softer of them silently winning.
    const { applicability } = judgeApplicability(record, context);
    if (!applicability.applicable && applicability.judged) continue;
    // **Whether it bears is the record's own answer, not this module's.**
    // `severityForType()` is where hardness becomes severity, and a type that
    // maps to `info` produces findings that move no status in any derivation in
    // this repository — so an unenforced *preference* is reported and does not
    // flip a verdict, while an unenforced `hard` or `soft` one does. Retype the
    // record and the same query changes its answer, which is the property
    // `tests/feasibilityApi.test.js` constructs and proves.
    const verdictBearing = severityForType(record.type) !== CONSTRAINT_SEVERITY.INFO;
    out.push(
      makeUnknown(
        FEASIBILITY_REASON.FEASIBILITY_RULE_UNENFORCED,
        `constraint "${constraintId}" over ${context.date ?? 'this date'}`,
        `"${constraintId}" (${record.type}, policy "${record.policy}") governs this position and no rule in the run enforces it; nothing checked it, which is not the same as it being satisfied`,
        {
          constraintId,
          verdictBearing,
          details: {
            policy: record.policy,
            type: record.type,
            typeSeverity: severityForType(record.type),
          },
        }
      )
    );
  }
  return out;
}

/**
 * The registry's own view of a set of findings, at one place on one date.
 *
 * The same two public functions `resolve/legality.js` calls, in the same order,
 * so a retyped constraint reads identically in a feasibility answer and in the
 * placement check it is derived from.
 *
 * **The seam's own provenance findings are discarded here, and `checkPlacement()`
 * no longer discards them.** That is a real difference and not an oversight.
 * `checkPlacement()` is handed a *game*, so a `team`-scoped record it cannot
 * judge is a record it could have judged and did not — worth reporting, and it
 * now returns them on `registryFindings`. This function is handed a *position*:
 * a surface, a venue and a date, with no sides anywhere in `where`, because
 * `probeKickoff()` asks about a slot rather than about a fixture. A
 * `CONSTRAINT_SCOPE_UNJUDGED` from here says only "the question named no team",
 * which is true of every call and therefore tells a reader nothing. The
 * team-scoped verdict still reaches a feasibility answer, through
 * `attribution/explain.js` and `checkPlacement()`, which is where the game is.
 *
 * @param {{ graph: Object, registry: Object }} engines
 * @param {{ surfaceId: string, venueId: string|null, date: string, divisionLabel?: string|null }} where
 * @param {ReadonlyArray<Object>} findings
 * @returns {Array<{ code: string, severity: string, message: string, details: Record<string, unknown> }>}
 */
export function underRegistry(engines, where, findings) {
  const surface = getSurface(
    /** @type {import('../facility/types.js').FacilityGraph} */ (engines.graph),
    where.surfaceId
  );
  const table = effectiveSeverityTable(
    /** @type {import('../constraints/types.js').ConstraintRegistry} */ (engines.registry),
    {
      date: where.date,
      // `undefined`, never `null`: `ScopeContextSchema` is `.strict()` and takes
      // an absent venue as "the context does not name one", which is what an
      // unknown surface means. A `null` is a stated venue whose id is nothing.
      venueId: surface?.venueId ?? where.venueId ?? undefined,
      surfaceId: where.surfaceId,
      surfaceLineage: surface ? [...surface.lineage] : [where.surfaceId],
      ...(where.divisionLabel ? { divisionLabel: where.divisionLabel } : {}),
    }
  );
  return /** @type {Array<{ code: string, severity: string, message: string, details: Record<string, unknown> }>} */ (
    applyRegistrySeverity(
      /** @type {ReadonlyArray<import('../constraints/types.js').ConstraintFinding>} */ (findings),
      table
    ).findings
  );
}

/**
 * Ask `checkKickoffAvailability()` about one minute, under the registry.
 *
 * The trial placement this module needs is derived here and thrown away: the
 * probe enters no state, adds no booking anywhere, and writes to nothing the
 * caller passed. `checkKickoffAvailability()` invents its own candidate booking
 * internally and returns a value; that is the whole mutation budget of this
 * package.
 *
 * @param {{ graph: Object, table: Object, calendar: Object, registry: Object }} engines
 * @param {{ surfaceId: string, date: string, kickoffMinutes: number, format: string|null, ignoreBookingIds: ReadonlyArray<string>, divisionLabel?: string|null }} at
 * @param {ReadonlyArray<Object>} existingBookings
 * @param {import('./types.js').FeasibilityMeta} meta
 * @returns {{ result: Object, findings: Array<{ code: string, severity: string, message: string, details: Record<string, unknown> }> }}
 */
export function probeKickoff(engines, at, existingBookings, meta) {
  const result = checkKickoffAvailability(
    engines.graph,
    engines.table,
    engines.calendar,
    {
      surfaceId: at.surfaceId,
      date: at.date,
      kickoffMinutes: at.kickoffMinutes,
      format: at.format,
      ignoreBookingIds: [...at.ignoreBookingIds],
    },
    { existingBookings }
  );
  meta.boundaryProbesRun += 1;
  meta.constraintsConsulted += result.constraints.length;
  const findings = underRegistry(
    engines,
    {
      surfaceId: at.surfaceId,
      venueId: result.venueId,
      date: at.date,
      divisionLabel: at.divisionLabel ?? null,
    },
    result.findings
  );
  return { result, findings };
}

/**
 * The bookings standing on a date, as the facility model wants them.
 *
 * Delegates to `resolve/legality.js`'s `bookingsOn()` — the one derivation of a
 * booking from a placed game — and then applies the caller's exclusions. A
 * second copy of that mapping would be free to disagree about `endMinutes`,
 * which is the one field GAP-14 makes nullable.
 *
 * @param {Object} state - a `ResolveState`
 * @param {string} date
 * @param {ReadonlyArray<string>} ignoreGameIds
 * @returns {Array<Object>}
 */
export function standingBookings(state, date, ignoreGameIds) {
  const ignored = new Set(ignoreGameIds);
  return bookingsOn(state, date, '').filter((booking) => !ignored.has(booking.id));
}

/**
 * Findings that count against a position — everything above `info`.
 *
 * @param {ReadonlyArray<{ severity: string }>} findings
 * @returns {Array<Object>}
 */
function consequential(findings) {
  return findings.filter((finding) => finding.severity !== CONSTRAINT_SEVERITY.INFO);
}

/**
 * Findings that make a position illegal.
 *
 * @param {ReadonlyArray<{ severity: string }>} findings
 * @returns {Array<Object>}
 */
function blockingOnly(findings) {
  return findings.filter((finding) => finding.severity === CONSTRAINT_SEVERITY.BLOCKING);
}

/**
 * **What counts as *speaking* at a threshold.**
 *
 * One function, so the severity view that *selects* a boundary is the same one
 * that *judges* it. It was not: `latestLegalKickoff()` picks the hard bound off
 * `availability/`'s own base severities while `boundaryOf()` re-severities the
 * same minute through the registry, and a registry that makes a base-`compromise`
 * availability code hard — which is the registry's entire purpose — then produced
 * an answer naming a latest legal kickoff and calling the position infeasible in
 * the same breath. 217 of this corpus's 1,872 bounds combinations did exactly
 * that under one such record.
 *
 * At {@link FEASIBILITY_THRESHOLD.HARD} a finding speaks when it is `blocking`;
 * at {@link FEASIBILITY_THRESHOLD.CLEAN}, when it is anything above `info`. The
 * findings handed in are always the registry's view of them —
 * {@link probeKickoff} and {@link underRegistry} produce no other kind — so
 * "selected under the same severities it is judged under" is a property of the
 * call graph rather than a habit kept at three call sites.
 *
 * @param {string} threshold - a `FEASIBILITY_THRESHOLD` value
 * @param {ReadonlyArray<{ severity: string }>} findings
 * @returns {Array<Object>} the members that speak at that threshold
 */
export function speaksAt(threshold, findings) {
  return threshold === FEASIBILITY_THRESHOLD.HARD
    ? blockingOnly(findings)
    : consequential(findings);
}

/**
 * **Who blocked it, read off the very list the verdict was derived from.**
 *
 * `deriveFeasibilityEvidence()` folds a list of severity-bearing records into
 * `blocked`; this names the records that made it so. The two read the same list
 * on purpose: `FEASIBILITY_BLOCKED_OUTSIDE_FACILITY` used to name its sources
 * from `blockers` alone while the verdict was derived from `blockers` *and* the
 * travel findings no transition owns, so a blocker arriving by the second route
 * produced the sentence *"what blocks it is stated in the blockers"* — about
 * something the blockers do not state. Deriving both from one list is what makes
 * that unsayable rather than merely unobserved.
 *
 * Every record must carry its own `source` and `codes`; nothing is inferred from
 * a code prefix here, because provenance is the one thing this finding exists to
 * report.
 *
 * @param {ReadonlyArray<{ severity: string, source: string, codes: ReadonlyArray<string> }>} evidence
 * @returns {{ sources: string[], codes: string[] }}
 */
export function blockingEvidenceOf(evidence) {
  /** @type {Set<string>} */
  const sources = new Set();
  /** @type {Set<string>} */
  const codes = new Set();
  for (const record of evidence) {
    if (record.severity !== CONSTRAINT_SEVERITY.BLOCKING) continue;
    sources.add(record.source);
    for (const code of record.codes ?? []) codes.add(code);
  }
  return { sources: [...sources].sort(), codes: [...codes].sort() };
}

/**
 * **A boundary describes its own position, and nobody else's.**
 *
 * The rule `types.js` states about {@link import('./types.js').FeasibilityBoundary}
 * `claims` and `notApplicable`, enforced where a boundary is *built* rather than
 * where one is consumed.
 *
 * The rule it enforces is deliberately not *"a boundary with no position carries
 * nothing"*, which is what the contract said and the code has never done: the
 * hard boundary on a blacked-out date has no position **and** one claim —
 * `PERMIT_BLACKOUT`, naming the permit record — and that claim is the answer to
 * *"why is there no boundary here?"*. Deleting it to satisfy the sentence would
 * trade an explanation for a shrug. What must never happen is the thing that
 * did: the clean boundary was once built from the *hard* result, so a position
 * no minute of the day offered was described in another minute's constraints.
 *
 * So a boundary is checked against the position its own availability result is
 * about. A result that states no kickoff at all — the empty one a caller builds
 * when there is no clean boundary to probe — reads as `null` and matches a
 * boundary that has none.
 *
 * **What it does and does not currently guarantee, so nobody reads more into it
 * than is there.** For the *clean* boundary it is a real check: the position is
 * found by `searchBoundary()` and the result is a separate probe, so a search
 * and a probe that disagreed would be caught. For the *hard* boundary it is
 * tautological — `feasibleKickoffBounds()` derives the position and the result
 * from the same call in every branch (availability's own answer, a probe at the
 * minute the registry moved the bound to, or — where the registry refused every
 * minute — the probe of that refusal with its position taken off, which is
 * `null` on both sides by construction), so the two cannot differ. It is kept
 * there as a guard against a future
 * caller that pairs them by hand, which is the mistake it was written for, not
 * because it is presently falsifiable on that path.
 *
 * @param {Object} result - a `checkKickoffAvailability()` or `latestLegalKickoff()` answer
 * @param {number|null} kickoffMinutes - the boundary's own position
 * @param {string} threshold - a `FEASIBILITY_THRESHOLD` value, named in the failure
 * @returns {Object} the same result
 */
export function assertBoundaryResult(result, kickoffMinutes, threshold) {
  const describes = result?.kickoffMinutes ?? null;
  if (describes !== kickoffMinutes) {
    throw new Error(
      `feasibility: the "${threshold}" boundary is at ${JSON.stringify(kickoffMinutes)} but the availability result it was built from is about ${JSON.stringify(describes)}; a boundary carries the constraints that spoke about its own position, and one that has no position may say why it has none but never in another minute's words`
    );
  }
  return result;
}

/**
 * Which constraints bind at a position, by probing one minute later.
 *
 * `threshold` decides what counts as speaking: at the hard threshold a
 * constraint binds when it would raise something `blocking`; at the clean
 * threshold, anything above `info`. Findings are attributed to a constraint kind
 * by `groupFindingsByConstraintKind()` — 4.3's table, not a second one — and a
 * finding no kind buckets is reported under its own code, so a blocker can never
 * be silently unattributed.
 *
 * @param {Object} engines
 * @param {{ surfaceId: string, date: string, kickoffMinutes: number, format: string|null, ignoreBookingIds: ReadonlyArray<string>, divisionLabel?: string|null }} at -
 *   the boundary itself; the probe runs at `kickoffMinutes + 1`
 * @param {ReadonlyArray<Object>} existingBookings
 * @param {Object} boundaryResult - the `checkKickoffAvailability()` result at the boundary
 * @param {string} threshold - a `FEASIBILITY_THRESHOLD` value
 * @param {import('./types.js').FeasibilityMeta} meta
 * @returns {import('./types.js').FeasibilityBound[]}
 */
export function bindingAt(engines, at, existingBookings, boundaryResult, threshold, meta) {
  const probe = probeKickoff(
    engines,
    { ...at, kickoffMinutes: at.kickoffMinutes + 1 },
    existingBookings,
    meta
  );
  return boundsOf(engines, boundaryResult, speaksAt(threshold, probe.findings));
}

/**
 * **Turn the findings that spoke into the binding set.**
 *
 * Extracted from {@link bindingAt} rather than copied out of it, because
 * `feasibility/moveRequest.js` needs the same construction at a *placement* —
 * where `types.js` says a constraint binds when it speaks **at** the position —
 * while {@link bindingAt} needs it one minute past a **boundary**. The two
 * differ only in which minute is probed, and the alternative was a second bound
 * builder free to attribute a finding to a different kind, name a different
 * constraint id, or sort differently from the first.
 *
 * `owningResult` is the availability answer about the position the bounds
 * describe; it supplies each kind's own `limitMinutes` and `slackMinutes`, which
 * is why the margin is copied from its owner rather than recomputed here.
 *
 * @param {Object} engines
 * @param {Object} owningResult - the `checkKickoffAvailability()` result the bounds describe
 * @param {ReadonlyArray<{ code: string, severity: string }>} speaking - the findings
 *   that count at this threshold, already filtered by {@link speaksAt}
 * @returns {import('./types.js').FeasibilityBound[]}
 */
export function boundsOf(engines, owningResult, speaking) {
  const grouped = groupFindingsByConstraintKind(
    /** @type {ReadonlyArray<import('../attribution/types.js').AttributionFinding>} */ (speaking)
  );

  /** @type {Map<string, import('./types.js').FeasibilityBound>} */
  const bounds = new Map();
  const ownerOf = (kind) =>
    (owningResult.constraints ?? []).find((entry) => entry.kind === kind) ?? null;

  for (const [kind, findings] of Object.entries(grouped.byKind)) {
    if (findings.length === 0) continue;
    const owner = ownerOf(kind);
    const codes = findings.map((finding) => finding.code);
    bounds.set(kind, {
      kind,
      source: attributionSourceOf(codes[0], ATTRIBUTION_SOURCE.AVAILABILITY),
      instanceId: owner?.source ?? null,
      constraintId: registryConstraintIdsFor(engines.registry, codes)[0] ?? null,
      limitMinutes: owner?.limitMinutes ?? null,
      slackMinutes: owner?.slackMinutes ?? null,
      raises: findings.map((finding) => ({ code: finding.code, severity: finding.severity })),
    });
  }

  for (const finding of grouped.ungrouped) {
    const kind = `code:${finding.code}`;
    if (bounds.has(kind)) continue;
    bounds.set(kind, {
      kind,
      source: attributionSourceOf(finding.code, ATTRIBUTION_SOURCE.FACILITY),
      instanceId: null,
      constraintId: registryConstraintIdsFor(engines.registry, [finding.code])[0] ?? null,
      limitMinutes: null,
      slackMinutes: null,
      raises: [{ code: finding.code, severity: finding.severity }],
    });
  }

  return [...bounds.values()].sort((a, b) => a.kind.localeCompare(b.kind));
}

/**
 * The margin an answer reports, and which bound it came from.
 *
 * **Copied, never computed.** The number is the binding member's own
 * `slackMinutes`; when no binding member measured one, the margin is `null` and
 * a `FEASIBILITY_MARGIN_UNAVAILABLE` finding says so. Reporting `0` there would
 * be a confident claim of "exactly at the edge" about a bound nobody could
 * measure.
 *
 * When several members bind, the tightest measurable slack is the headline and
 * every member keeps its own on the bound record — so "0" is never read as
 * belonging to one constraint when two are holding the line.
 *
 * @param {ReadonlyArray<import('./types.js').FeasibilityBound>} binding
 * @returns {{ marginMinutes: number|null, marginBasis: string|null }}
 */
export function marginFrom(binding) {
  const measured = binding.filter((bound) => typeof bound.slackMinutes === 'number');
  if (measured.length === 0) return { marginMinutes: null, marginBasis: null };
  const tightest = measured.reduce((best, bound) =>
    /** @type {number} */ (bound.slackMinutes) < /** @type {number} */ (best.slackMinutes)
      ? bound
      : best
  );
  return {
    marginMinutes: /** @type {number} */ (tightest.slackMinutes),
    marginBasis: tightest.kind,
  };
}

/**
 * **The candidate ledger: considered must equal answered.**
 *
 * `types.js` states the invariant on `FeasibilityMeta.candidatesAnswered` — *"must
 * equal the line above"* — and until this function existed nothing checked it.
 * The `canTeamPlay()` grid had a guard of its own, over the grid size derived
 * from the query, but that guard is about one query shape; the unknown-game
 * early return in `canGameMove()` counted a candidate as considered, answered
 * none, and said nothing, because no shape-independent check existed to notice.
 *
 * So this runs from `seal()`, which every answer of every shape passes through,
 * and it is the reason the invariant is now a property of the module rather
 * than of one loop. It takes a meta rather than a list on purpose: a counter
 * incremented beside the `push` it counts can never disagree with it, and the
 * two numbers here are incremented at genuinely different places.
 *
 * @param {import('./types.js').FeasibilityMeta} meta
 * @param {Record<string, unknown>} where
 * @returns {import('./types.js').FeasibilityFinding[]}
 */
export function candidateAccountingFindings(meta, where) {
  if (meta.candidatesAnswered === meta.candidatesConsidered) return [];
  return [
    makeFeasibilityFinding(
      FEASIBILITY_REASON.FEASIBILITY_CANDIDATE_DROPPED,
      `${meta.candidatesConsidered} candidate position(s) were considered and ${meta.candidatesAnswered} produced an answer; a position that cannot be judged is reported with a reason, never dropped`,
      {
        ...where,
        candidatesConsidered: meta.candidatesConsidered,
        candidatesAnswered: meta.candidatesAnswered,
      }
    ),
  ];
}

/**
 * The findings a binding set implies about the answer that carries it.
 *
 * @param {ReadonlyArray<import('./types.js').FeasibilityBound>} binding
 * @param {number|null} marginMinutes
 * @param {Record<string, unknown>} where
 * @returns {import('./types.js').FeasibilityFinding[]}
 */
export function boundFindings(binding, marginMinutes, where) {
  /** @type {import('./types.js').FeasibilityFinding[]} */
  const findings = [];
  if (binding.length === 0) {
    findings.push(
      makeFeasibilityFinding(
        FEASIBILITY_REASON.FEASIBILITY_BOUND_UNSTATED,
        'nothing this run holds bounds the position asked about, so the answer is the top of the searched range rather than a limit anybody stated',
        where
      )
    );
    return findings;
  }
  if (binding.length > 1) {
    findings.push(
      makeFeasibilityFinding(
        FEASIBILITY_REASON.FEASIBILITY_BOUND_JOINT,
        `${binding.length} constraints bind at the same minute (${binding.map((bound) => bound.kind).join(', ')}); none of them is the reason on its own and this answer names all of them`,
        { ...where, bindingKinds: binding.map((bound) => bound.kind) }
      )
    );
  }
  if (marginMinutes === null) {
    findings.push(
      makeFeasibilityFinding(
        FEASIBILITY_REASON.FEASIBILITY_MARGIN_UNAVAILABLE,
        `${binding.map((bound) => bound.kind).join(', ')} bound this position and none of them reported a measurable slack, so the margin is stated as unavailable rather than as zero`,
        { ...where, bindingKinds: binding.map((bound) => bound.kind) }
      )
    );
  }
  return findings;
}
