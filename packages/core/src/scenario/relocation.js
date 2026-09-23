/**
 * **Where a displaced game could actually go — proposed, never solved.**
 *
 * The build plan's acceptance test asks a scenario report to name *"the
 * affected format, the replacement venues, and the added compromises"*. The
 * re-solver cannot supply the middle one, and the reason is structural rather
 * than a bug: `resolve/inventory.js` `candidateSlotsFor()` derives a game's
 * candidate venue from **its own anchor surface** and fixes every candidate at
 * **`anchor.date`**. It is the anti-slot-inventor guarantee working exactly as
 * designed — a re-solve re-places games onto slots the baseline already used —
 * and it means a re-solve of "no venue X" produces TIME TBD fixtures each
 * correctly naming `PERMIT_BLACKOUT` and **no replacement venue at all**.
 *
 * So this module searches, and says so. It runs
 * {@link import('../reserve/capacity.js').buildReserveCapacityReport} under the
 * *branch's own* engines to find spare ground of the right format on the right
 * dates, pairs each displaced game with a slot under a **stated policy**, and
 * emits a change request naming those slots. `changeRequestApply` already
 * accepts an arbitrary date and surface, and `isSlotAdmissible()` already
 * admits an out-of-inventory slot for exactly the game the request named.
 *
 * **Widening `candidateSlotsFor()` was the alternative and was rejected.** It
 * changes the anti-slot-inventor guarantee for every caller and silently
 * redefines `reoptimiseWholeSeason()`, whose 8-games-moved figure is a headline
 * result of Prompt 4.2.
 *
 * ## Relocation proposes, `resolve/` decides (#53)
 *
 * This module filters; it does not judge. Every candidate that survives its
 * own questions — ground of the right size and grade, free, no team in two
 * places — is handed to a **probe** the caller builds from `resolve/`
 * (`createPlacementProbe()`, or the options pass's own), which asks the
 * facility model, the rule gate and the objective exactly as the placer does.
 * A candidate the gate refuses is never proposed, and the order among the rest
 * is `rankReplacementOptions()`: clean first, then `scoreObjective()`. There
 * used to be two orderings of this module's own (`RELOCATION_POLICY`), a
 * second definition of "better" that disagreed with the objective in 19 of 22
 * measured cases; they are gone.
 *
 * The same filter serves two callers: `proposeRelocations()` for a scenario
 * branch, which applies its proposals (gated, `origin: 'proposer'`), and
 * `relocationOptionsFor()` for `resolve/`'s options pass, which applies
 * nothing and offers up to three for an operator to approve.
 *
 * ## The sentence that must survive every rewrite of the report
 *
 * These replacements were **proposed by `proposeRelocations()` under a stated
 * policy**. The solver did not find them. Every finding this module emits names
 * the policy, and `docs/SCENARIOS.md` §5 says it in as many words, because a
 * report that let a reader believe the optimiser discovered a second venue
 * would be claiming a capability this package does not have.
 *
 * ## The negative control
 *
 * Running the same scenario with the proposer switched off is not a lesser
 * deliverable, it is the control: every displaced game becomes TIME TBD naming
 * the code the branch introduced, and no replacement venue appears anywhere.
 * That is what proves the replacements came from a real search rather than from
 * a list somebody typed.
 *
 * @module scenario/relocation
 */

import { AVAILABILITY_SEVERITY } from '../availability/reasonCodes.js';
import { CONSTRAINT_SEVERITY } from '../constraints/reasonCodes.js';
import { checkKickoffAvailability } from '../availability/kickoff.js';
import { DEFAULT_SIZE_RANK, checkSizeEligibility } from '../facility/eligibility.js';
import { bookingsOverlapInTime } from '../facility/occupancy.js';
import { FACILITY_STATUS } from '../facility/reasonCodes.js';
import { buildReserveCapacityReport } from '../reserve/capacity.js';
import { RESERVE_REASON } from '../reserve/reasonCodes.js';

import {
  RELOCATION_RANKING,
  REPLACEMENT_GRADE,
  SCENARIO_REASON,
  createScenarioMeta,
  deriveScenarioStatus,
  makeScenarioFinding,
} from './reasonCodes.js';
import { RelocationPolicySchema } from './schemas.js';

/** How many example ids an aggregate finding carries. */
const EXAMPLE_LIMIT = 5;

/**
 * Does any surface standing on this one state a size of its own?
 *
 * The containment forest can be deeper than one level (Alder's
 * `Pitch 1A -> Pitch 1A Side 1`), so this walks the whole subtree rather than
 * the immediate children: a sized grandchild is bookable ground under a
 * sizeless child, and offering the root as well would double-count it.
 *
 * @param {import('../facility/types.js').FacilityGraph} graph
 * @param {import('../facility/types.js').FacilitySurface} surface
 * @returns {boolean}
 */
function hasSizedDescendant(graph, surface) {
  const stack = [...surface.childIds];
  const seen = new Set();
  while (stack.length > 0) {
    const id = /** @type {string} */ (stack.pop());
    if (seen.has(id)) continue;
    seen.add(id);
    const child = graph.surfaces[id];
    if (!child) continue;
    if (child.sizes.length > 0) return true;
    stack.push(...child.childIds);
  }
  return false;
}

/**
 * Candidate replacement ground for a format, derived rather than typed in.
 *
 * Four filters, each stated:
 *
 * 1. **Not at a withdrawn venue.** Obvious, and the caller names them.
 * 2. **A leaf, or a parent no descendant of which states a size.** Booking
 *    Alder Pitch 1 takes 1A and 1B with it, so proposing onto a parent whose
 *    halves are themselves bookable ground is strictly more disruptive than
 *    proposing onto a half — and, worse, counts the same hour once per level:
 *    see the filter's own comment below for why that is a capacity report
 *    claiming ground that does not exist rather than a matter of taste.
 *    `checkOccupancy()` would refuse the parent anyway the moment either half
 *    is in use. Where the halves state no size of their own, they are not
 *    bookable ground and the parent is the pitch: Alder Pitch 2 and Pitch 3
 *    over the practice layer's 2A/2B and 3A/3B.
 * 3. **Big enough, by `checkSizeEligibility()` and not by a second rule.**
 *    Whether a format fits a patch of ground is `facility/eligibility.js`'s
 *    question, and it is asked here rather than answered again. This filter used
 *    to judge from the *smallest* declared size, which excluded every surface
 *    declaring more than one — Brookside's Upper 1 and Upper 2 declare
 *    `["7v7","9v9"]`, are `allowed` for 9v9 by `checkSizeEligibility()` and are
 *    counted as 9v9 ground by the reserve adapter, and were nonetheless refused
 *    here, so a venue withdrawal reported 9v9 games unrelocatable while legal
 *    ground stood empty.
 * 4. **Within `maxGradesAbove` size grades of the format.** The size policy is
 *    downward-closed, so *every* 11v11 pitch is technically eligible for a 7v7
 *    game and a search that took the policy literally would offer the stadium.
 *    One grade up is the club's own practice — a 7v7 game on a 9v9 pitch is a
 *    real arrangement with a real cost (`LINING_MISMATCH`); a 7v7 game on the
 *    11v11 stadium is a different conversation.
 *
 *    **The grade of a surface is its largest declared size**, which is the same
 *    quantity `checkSizeEligibility()` measures "big enough" against. Reading the
 *    floor off the largest and the ceiling off the smallest would be the two
 *    disagreeing rules again, one level down: a surface would be both big enough
 *    *because* its largest fits and not oversized *because* its smallest is
 *    close, which is a claim about two different patches of ground. A surface
 *    declaring `["4v4","11v11"]` is the stadium, and the smallest-size ceiling
 *    would have offered it to a Minis game as "one grade up" — exactly the case
 *    this filter exists to refuse.
 *
 * The result is **the input to a stated policy, not the policy itself**:
 * `RelocationPolicySchema.surfaceIds` has no default, exactly as
 * `ReserveCapacityInputSchema.earliestKickoffMinutes` has none.
 *
 * @param {import('../facility/types.js').FacilityGraph} graph
 * @param {{ format: string, excludeVenueIds?: ReadonlyArray<string>, maxGradesAbove?: number, sizeRank?: Record<string, number> }} query
 * @returns {string[]}
 */
export function replacementSurfacesFor(graph, query) {
  const rankTable = query.sizeRank ?? graph.sizeRank ?? DEFAULT_SIZE_RANK;
  const wanted = rankTable[query.format];
  if (wanted === undefined) {
    throw new Error(
      `scenario: format "${query.format}" has no size rank, so "one grade up" has no meaning for it; state the candidate surfaces instead`
    );
  }
  const excluded = new Set(query.excludeVenueIds ?? []);
  const maxGradesAbove = query.maxGradesAbove ?? 1;
  // The rank table travels with the eligibility question so the two cannot be
  // asked against different orderings.
  const sizeOptions = query.sizeRank ? { sizeRank: query.sizeRank } : {};

  return (
    Object.values(graph.surfaces)
      .filter((surface) => !excluded.has(surface.venueId))
      // **A leaf, or a parent none of whose descendants states a size.**
      //
      // The candidate set must never contain two surfaces where one stands on
      // the other. Nothing downstream subtracts a parent's occupation from its
      // children's free slots: `reserve/conditions.js` deliberately omits
      // `OCCUPIED_PARENT_CHILD` from its slot conditions *because* the ground
      // it is handed is leaf ground. Offer Pitch 1 alongside 1A and 1B and one
      // 9v9 kickoff on that pitch is counted three times, so a venue-withdrawal
      // report claims capacity that does not exist and `proposeRelocations()`
      // will put three games on one patch of grass at one time.
      //
      // "Has sizes of its own" is not the rule, because Pitch 1 (9v9) and its
      // halves 1A/1B (9v9 each) all state one — it would offer all three. The
      // rule is about who the bookable ground *is*: where the halves state a
      // size, they are the ground and the parent is not offered; where they
      // state none — Alder Pitch 2 and Pitch 3 over 2A/2B and 3A/3B, which the
      // practice layer (Phase 8.3) added and which are the same 11v11 pitch —
      // the pitch is the only bookable thing there and is still offered whole.
      // A sizeless surface is never offered on its own (the ranks check below
      // drops it), so the two clauses cannot both fire on one lineage.
      .filter((surface) => !hasSizedDescendant(graph, surface))
      .filter((surface) => {
        const ranks = surface.sizes
          .map((size) => rankTable[size])
          .filter((rank) => typeof rank === 'number');
        // Nothing rankable to measure a grade against; `checkSizeEligibility()`
        // says `SIZE_UNKNOWN_FORMAT` about the same surface.
        if (ranks.length === 0) return false;
        // The ceiling is this module's own policy and nothing else's.
        if (Math.max(...ranks) > wanted + maxGradesAbove) return false;
        // "Big enough" is not this module's question.
        return (
          checkSizeEligibility(graph, { surfaceId: surface.id, format: query.format }, sizeOptions)
            .status === FACILITY_STATUS.ALLOWED
        );
      })
      .map((surface) => surface.id)
      .sort()
  );
}

/**
 * **The one ordering of replacement slots** (#53), for proposals and offered
 * options alike.
 *
 * 1. **Clean first.** A replacement is clean when `resolve/`'s facility model
 *    gives its slot no compromise-severity finding; the operator's ruling is
 *    that a clean option is preferred to any carrying a code, which a weight
 *    could trade away and an order cannot. In this corpus the code is
 *    `LINING_MISMATCH` — a pitch painted for another format. The *undersized*
 *    half of the build plan's "undersized or wrongly-lined" is unreachable by
 *    design: `SIZE_TOO_SMALL` is blocking and the size policy is
 *    downward-closed, so such a slot never reaches this function, and
 *    `docs/SCENARIOS.md` §6 says so.
 * 2. **Then `scoreObjective()`**, the only scoring function in `resolve/`.
 * 3. **Then `candidateSlotsFor()`'s tie-break**: kickoff, then surface id — the
 *    sibling's contract rather than a third one. The objective has no venue or
 *    travel term (8.9 will make travel computable), so ties are common: 8 of
 *    22 measured top pairs.
 *
 * @template {{ compromiseCodes: ReadonlyArray<string>, score: number, startMinutes: number, surfaceId: string }} T
 * @param {ReadonlyArray<T>} options
 * @returns {T[]}
 */
export function rankReplacementOptions(options) {
  const dirty = (option) => (option.compromiseCodes.length === 0 ? 0 : 1);
  return [...options].sort(
    (a, b) =>
      dirty(a) - dirty(b) ||
      a.score - b.score ||
      a.startMinutes - b.startMinutes ||
      a.surfaceId.localeCompare(b.surfaceId)
  );
}

/**
 * One booking record for a game, in the shape the facility model wants.
 *
 * @param {Object} game
 * @param {import('../resolve/types.js').Slot} [slot]
 * @returns {import('../facility/types.js').FacilityBooking}
 */
function bookingFor(game, slot) {
  const at = slot ?? {
    date: game.date,
    surfaceId: game.surfaceId,
    startMinutes: game.startMinutes,
  };
  const occupancy = game.endMinutes === null ? null : game.endMinutes - game.startMinutes;
  return {
    id: String(game.id),
    surfaceId: at.surfaceId,
    date: at.date,
    startMinutes: at.startMinutes,
    endMinutes: occupancy === null ? null : at.startMinutes + occupancy,
    format: game.format ?? null,
    label: `${game.homeLabel ?? ''} v ${game.awayLabel ?? ''}`,
  };
}

/**
 * Who a game or a held slot commits, for the clash the facility model cannot see.
 *
 * **A surface knows who is standing on it, never who is playing.**
 * `checkOccupancy()` compares ground against ground, so two games sharing a
 * team on two different surfaces at the same minute are both perfectly legal
 * placements and one impossible afternoon. The team id is preferred and the
 * label is the fallback, because this corpus carries rows with a label and no
 * id; a side with neither is skipped rather than folded into a single empty
 * key, which would make every anonymous side clash with every other one.
 *
 * @param {Object} row - a schedule game or a `ReservedSlotSchema` row
 * @returns {string[]}
 */
function teamsOf(row) {
  /** @type {string[]} */
  const teams = [];
  for (const side of ['home', 'away']) {
    const id = row[`${side}TeamId`];
    const label = row[`${side}Label`];
    const key = id ? `id:${id}` : label ? `label:${label}` : null;
    if (key !== null && !teams.includes(key)) teams.push(key);
  }
  return teams;
}

/**
 * One reserved slot as a booking, so held ground is ground already occupied.
 *
 * @param {Object} slot - a `ReservedSlotSchema` row
 * @returns {import('../facility/types.js').FacilityBooking}
 */
function bookingForReservedSlot(slot) {
  return {
    id: `reserved:${slot.id}`,
    surfaceId: slot.surfaceId,
    date: slot.date,
    startMinutes: slot.startMinutes,
    endMinutes: slot.endMinutes,
    format: slot.format ?? null,
    label: slot.label ?? `reserved slot ${slot.id}`,
  };
}

/**
 * Capacity codes this proposer does **not** lift into its plan's findings.
 *
 * Every one of them answers the requirement `proposeRelocations()` invents for
 * its own grid derivation — `slots: Math.max(1, perDate)`, computed from the
 * displaced set a moment earlier — rather than a requirement an operator stated
 * about the branch. Two consequences make lifting them wrong rather than merely
 * noisy.
 *
 * - **They restate, worse, what this plan already reports.** "The ground cannot
 *   hold all of them" is exactly the fact `unrelocatable` carries, per game,
 *   with a reason, as `SCENARIO_RELOCATION_UNAVAILABLE` and a TIME TBD fixture.
 *   A second copy at date granularity adds no information and names no game.
 * - **They would put shelving on the wrong side of this module's own line.**
 *   `docs/SCENARIOS.md` states it: a branch that *shelves* games is
 *   `compromised` and promotable, and a branch that *loses* one carries
 *   `FIXTURE_DROPPED` at blocking and is refused. A capacity shortfall is the
 *   cause of shelving, so blocking on it would make every venue-withdrawal
 *   branch with a single TIME TBD fixture unpromotable — including the
 *   acceptance run, whose twelve are the documented answer rather than a fault.
 *
 * They stay on `capacities` in full, where a caller asking about the ground
 * rather than about the branch can read them.
 *
 * @type {ReadonlySet<string>}
 */
const ANSWERS_THE_PROPOSERS_OWN_REQUIREMENT = Object.freeze(
  new Set([
    RESERVE_REASON.RESERVE_CAPACITY_BELOW_REQUIREMENT,
    RESERVE_REASON.RESERVE_CAPACITY_AT_REQUIREMENT,
    RESERVE_REASON.RESERVE_CAPACITY_CONDITIONAL_SHORTFALL,
  ])
);

/**
 * `resolve/`'s judgement of one slot, injected so this module never keeps a
 * second one (#53).
 *
 * @typedef {Object} ReplacementProbe
 * @property {(gameId: string, slot: import('../resolve/types.js').Slot) => { cleared: boolean, compromiseCodes: string[], score: number, counts: Record<string, number> }} evaluate
 * @property {(gameId: string, slot: import('../resolve/types.js').Slot) => void} hold - the game now stands on `slot` for every later question
 */

/**
 * @param {unknown} probe
 * @param {string} caller
 */
function requireProbe(probe, caller) {
  const candidate = /** @type {any} */ (probe);
  if (typeof candidate?.evaluate !== 'function' || typeof candidate?.hold !== 'function') {
    throw new Error(
      `scenario: ${caller} needs a probe from resolve/ (createPlacementProbe()); without one it would judge slots by a rule of its own, and #53 removed the second definition of "better"`
    );
  }
}

/**
 * Every legal replacement for one game on one date, ranked.
 *
 * Three filters of this module's own, then `resolve/`'s: the ground is free
 * (`checkKickoffAvailability()` against what stands), no team of the game's is
 * in two places at once (`bookingsOverlapInTime()`, which returns `null` for an
 * unknown footprint — an undecidable pair is not a clash, and the rule engine
 * reports the unknown footprint in its own right), and then the probe: facility
 * findings, coach overlap and turnover through the rule gate, and the score.
 * A candidate the probe does not clear is counted and dropped, never ranked.
 *
 * @param {{ graph: Object, table: Object, calendar: Object }} engines
 * @param {{ gameId: string, row: Object, format: string, date: string, surfaceIds: ReadonlyArray<string>, kickoffsFor: (surfaceId: string) => ReadonlyArray<number>, bookings: ReadonlyArray<Object>, commitments: ReadonlyArray<{ teams: string[], booking: Object }>, probe: ReplacementProbe }} query
 * @returns {{ options: Array<{ surfaceId: string, startMinutes: number, grade: string, driftMinutes: number, compromiseCodes: string[], score: number, counts: Record<string, number> }>, considered: number, refusedForTeamClash: number, refusedByGate: number }}
 */
function searchReplacements(engines, query) {
  const { row } = query;
  const teams = teamsOf(row);
  const occupancy = row.endMinutes === null ? null : row.endMinutes - row.startMinutes;
  /**
   * Would this kickoff put one of this game's teams in two places at once?
   *
   * @param {number} kickoff
   */
  const teamClash = (kickoff) => {
    if (teams.length === 0) return null;
    const candidate = {
      id: query.gameId,
      surfaceId: row.surfaceId,
      date: query.date,
      startMinutes: kickoff,
      endMinutes: occupancy === null ? null : kickoff + occupancy,
    };
    for (const entry of query.commitments) {
      if (entry.booking.id === query.gameId) continue;
      if (!entry.teams.some((team) => teams.includes(team))) continue;
      if (bookingsOverlapInTime(candidate, entry.booking) !== true) continue;
      return entry.booking;
    }
    return null;
  };

  let considered = 0;
  let refusedForTeamClash = 0;
  let refusedByGate = 0;
  const options = [];
  for (const surfaceId of query.surfaceIds) {
    for (const kickoff of query.kickoffsFor(surfaceId)) {
      considered += 1;
      const answer = checkKickoffAvailability(
        engines.graph,
        engines.table,
        engines.calendar,
        {
          surfaceId,
          date: query.date,
          kickoffMinutes: kickoff,
          format: query.format,
          ignoreBookingIds: [query.gameId],
        },
        { existingBookings: query.bookings }
      );
      if (answer.findings.some((f) => f.severity === AVAILABILITY_SEVERITY.BLOCKING)) continue;
      // **Legality before grade.** The ground is free; the teams may not be.
      if (teamClash(kickoff) !== null) {
        refusedForTeamClash += 1;
        continue;
      }
      const slot = { date: query.date, surfaceId, startMinutes: kickoff };
      const judged = query.probe.evaluate(query.gameId, slot);
      if (!judged.cleared) {
        refusedByGate += 1;
        continue;
      }
      options.push({
        surfaceId,
        startMinutes: kickoff,
        grade:
          judged.compromiseCodes.length === 0
            ? REPLACEMENT_GRADE.CLEAN
            : REPLACEMENT_GRADE.COMPROMISED,
        driftMinutes: Math.abs(kickoff - row.startMinutes),
        compromiseCodes: [...judged.compromiseCodes],
        score: judged.score,
        counts: { ...judged.counts },
      });
    }
  }
  return {
    options: rankReplacementOptions(options),
    considered,
    refusedForTeamClash,
    refusedByGate,
  };
}

/**
 * Up to `limit` cross-venue options for one game, for `resolve/`'s options
 * pass (#53). **Offered, never applied** by anything in this package's live
 * path: an operator approves one, and the approval re-enters `resolve/` as an
 * `approved-option` change that is judged again.
 *
 * The candidate ground is the stated policy's, minus every surface at the
 * game's own venue — an option is by definition somewhere else; the same
 * venue is the placer's business. The kickoff grid is the reserve capacity
 * report's for this one format and date, as in {@link proposeRelocations}.
 *
 * @param {{ graph: Object, table: Object, calendar: Object, registry?: Object }} engines
 * @param {Object} input
 * @param {Object} input.game - the game's baseline row
 * @param {ReadonlyArray<Object>} input.standing - every other game standing on the result
 * @param {Object} input.policy - see `RelocationPolicySchema`
 * @param {ReplacementProbe} input.probe
 * @param {number} input.limit
 * @returns {{ options: ReturnType<typeof searchReplacements>['options'], candidatesConsidered: number, refusedForTeamClash: number, refusedByGate: number, surfaceIds: string[], capacityFindings: Object[] }}
 */
export function relocationOptionsFor(engines, input) {
  requireProbe(input.probe, 'relocationOptionsFor()');
  const policy = RelocationPolicySchema.parse(input.policy);
  const game = input.game;
  const surfaceIds = policy.surfaceIds.filter(
    (surfaceId) => engines.graph.surfaces[surfaceId]?.venueId !== game.venueId
  );
  const empty = {
    options: [],
    candidatesConsidered: 0,
    refusedForTeamClash: 0,
    refusedByGate: 0,
    surfaceIds,
    capacityFindings: [],
  };
  if (typeof game.format !== 'string' || surfaceIds.length === 0) return empty;

  const report = buildReserveCapacityReport(engines, {
    name: `cross-venue options for ${game.id} (${policy.source})`,
    format: game.format,
    dates: [game.date],
    surfaceIds,
    cadenceMinutes: policy.cadenceMinutes,
    earliestKickoffMinutes: policy.earliestKickoffMinutes,
    latestKickoffMinutes: policy.latestKickoffMinutes,
    requirement: { slots: 1, label: 'one game needing a time', source: policy.source },
    reservedSlots: [],
    bookings: [],
  });
  /** @type {Map<string, number[]>} */
  const grid = new Map();
  for (const dateRow of report.dates) {
    for (const surfaceRow of dateRow.bySurface) {
      grid.set(surfaceRow.surfaceId, [...surfaceRow.kickoffMinutes]);
    }
  }
  const sameDay = input.standing.filter(
    (other) => other.date === game.date && String(other.id) !== String(game.id)
  );
  const searched = searchReplacements(engines, {
    gameId: String(game.id),
    row: game,
    format: game.format,
    date: game.date,
    surfaceIds,
    kickoffsFor: (surfaceId) => grid.get(surfaceId) ?? [],
    bookings: sameDay.map((other) => bookingFor(other)),
    commitments: sameDay
      .map((other) => ({ teams: teamsOf(other), booking: bookingFor(other) }))
      .filter((entry) => entry.teams.length > 0),
    probe: input.probe,
  });
  return {
    options: searched.options.slice(0, input.limit),
    candidatesConsidered: searched.considered,
    refusedForTeamClash: searched.refusedForTeamClash,
    refusedByGate: searched.refusedByGate,
    surfaceIds,
    capacityFindings: report.findings.filter(
      (finding) =>
        finding.severity !== CONSTRAINT_SEVERITY.INFO &&
        !ANSWERS_THE_PROPOSERS_OWN_REQUIREMENT.has(finding.code)
    ),
  };
}

/**
 * Propose a replacement slot for each displaced game.
 *
 * @param {{ graph: Object, table: Object, calendar: Object, registry?: Object }} engines - the **branch's** engines
 * @param {Object} input
 * @param {ReadonlyArray<import('./types.js').DisplacedGame>} input.displaced
 * @param {ReadonlyArray<Object>} input.survivors - every game the branch leaves standing, so a proposal cannot double-book
 * @param {Record<string, Object>} input.gamesById - the baseline rows, for footprints and labels
 * @param {Object} input.policy - see `RelocationPolicySchema`
 * @param {{ slots: number, label: string, source: string }} input.requirement - what the ground is being asked to hold
 * @param {ReadonlyArray<Object>} [input.reservedSlots] - the branch's own `ReservedSlotSchema` rows; ground already held
 * @param {ReplacementProbe} input.probe - `resolve/`'s judgement of a slot; see `createPlacementProbe()`
 * @returns {import('./types.js').RelocationPlan}
 */
export function proposeRelocations(engines, input) {
  requireProbe(input.probe, 'proposeRelocations()');
  const policy = RelocationPolicySchema.parse(input.policy);
  const meta = createScenarioMeta();
  /** @type {import('./types.js').ScenarioFinding[]} */
  const findings = [];

  const displaced = [...input.displaced].sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      a.startMinutes - b.startMinutes ||
      a.gameId.localeCompare(b.gameId)
  );
  const dates = [...new Set(displaced.map((game) => game.date))].sort();
  const formats = [
    ...new Set(displaced.map((game) => game.format).filter((f) => typeof f === 'string')),
  ].sort();

  if (displaced.length === 0 || dates.length === 0 || formats.length === 0) {
    // Nothing to propose. Not a finding of its own: `runScenario()` reports the
    // displaced count, and a proposer that was handed nothing has nothing to
    // say about the season.
    return {
      ranking: RELOCATION_RANKING,
      surfaceIds: Object.freeze([...policy.surfaceIds]),
      proposals: [],
      unrelocatable: [],
      capacities: [],
      findings,
      status: deriveScenarioStatus(findings),
      meta,
    };
  }

  /**
   * Ground the branch already holds.
   *
   * A reserved slot is a commitment, not a hint: the record set is one a
   * scenario override may edit, so a branch that holds a pitch for a
   * tournament must not then be offered that pitch as spare replacement
   * ground. They go in twice on purpose — to the capacity report, so its
   * `reserved` and `spare` counts are about the branch's own ground, and to the
   * booking table below, so `checkOccupancy()` refuses a candidate standing on
   * one.
   */
  const reservedSlots = input.reservedSlots ?? [];

  /**
   * The grid, from the capacity report under the branch's own engines.
   *
   * One report per format, because a capacity report has exactly one stated
   * format and a grid derived for 7v7 says nothing about 9v9 occupancy.
   */
  /** @type {Map<string, number[]>} */
  const grid = new Map();
  /**
   * Every report, whole.
   *
   * This was `capacity`: **one** report, arbitrarily the first, with every
   * report's `findings` and `status` dropped. Two blocking codes could
   * therefore reach nothing — `RESERVE_CAPACITY_VACUOUS`, which says the report
   * generated no slot at all so every requirement it met was met by an empty
   * count, and `RESERVED_SLOT_UNCOVERED`, which says a reservation stands on
   * ground this report does not cover. The first is the worse of the two here:
   * an empty grid and a season with no spare ground both make the search report
   * *"nowhere to go"*, and nothing distinguished them.
   *
   * @type {Object[]}
   */
  const capacities = [];
  for (const format of formats) {
    const forFormat = displaced.filter((game) => game.format === format);
    const perDate = Math.max(
      ...dates.map((date) => forFormat.filter((game) => game.date === date).length)
    );
    const report = buildReserveCapacityReport(engines, {
      name: `replacement ground for ${format} (${policy.source})`,
      format,
      dates: [...new Set(forFormat.map((game) => game.date))].sort(),
      surfaceIds: [...policy.surfaceIds],
      cadenceMinutes: policy.cadenceMinutes,
      earliestKickoffMinutes: policy.earliestKickoffMinutes,
      latestKickoffMinutes: policy.latestKickoffMinutes,
      requirement: {
        slots: Math.max(1, perDate),
        label: input.requirement.label,
        source: input.requirement.source,
      },
      reservedSlots: [...reservedSlots],
      bookings: [],
    });
    capacities.push(report);
    // **The report's own verdict, carried rather than discarded.** What is
    // lifted into the plan's findings is everything that impeaches the report:
    // it examined nothing, it does not cover ground somebody reserved, a
    // reservation sits off its grid, a date is over its own cap. Those are
    // things this proposer cannot say for itself, and while they were dropped a
    // blocking finding could not reach `plan.status`, `runScenario()`'s result
    // or `promoteScenario()`'s gate.
    //
    // `info` provenance is not lifted — `SLOT_CONDITION_SATISFIED` per
    // generated slot and `RESERVE_CAPACITY_BOUND` per date run to hundreds of
    // entries on a real season and would bury the branch's own report without
    // moving a single status. Nothing is dropped: every report is on
    // `capacities` in full.
    for (const finding of report.findings) {
      if (finding.severity === CONSTRAINT_SEVERITY.INFO) continue;
      if (ANSWERS_THE_PROPOSERS_OWN_REQUIREMENT.has(finding.code)) continue;
      findings.push(/** @type {import('./types.js').ScenarioFinding} */ (finding));
    }
    for (const dateRow of report.dates) {
      for (const surfaceRow of dateRow.bySurface) {
        grid.set(`${format}|${dateRow.date}|${surfaceRow.surfaceId}`, [
          ...surfaceRow.kickoffMinutes,
        ]);
      }
    }
  }

  /**
   * What already stands on the ground, per date, growing as proposals land.
   *
   * A proposal that double-booked a surface would be handed to
   * `applyChangeRequest()` only for `dislodge` to lift a published neighbour
   * back off it, so the search checks each candidate against everything the
   * branch leaves standing **plus every earlier proposal**.
   */
  /** @type {Map<string, import('../facility/types.js').FacilityBooking[]>} */
  const bookingsByDate = new Map();
  /**
   * Who is already committed when, per date, growing as proposals land.
   *
   * The half of "what already stands on the ground" that the ground itself
   * cannot answer. Seeded from the same rows, walked the same way, and checked
   * before a candidate is graded — because a grade is a claim about the quality
   * of a placement and must not be issued on one that is not legal.
   */
  /** @type {Map<string, Array<{ teams: string[], booking: import('../facility/types.js').FacilityBooking }>>} */
  const commitmentsByDate = new Map();
  const commit = (date, teams, booking) => {
    if (teams.length === 0) return;
    const bucket = commitmentsByDate.get(date) ?? [];
    bucket.push({ teams, booking });
    commitmentsByDate.set(date, bucket);
  };
  for (const game of input.survivors) {
    const bucket = bookingsByDate.get(game.date) ?? [];
    const booking = bookingFor(game);
    bucket.push(booking);
    bookingsByDate.set(game.date, bucket);
    commit(game.date, teamsOf(game), booking);
  }
  for (const slot of reservedSlots) {
    const bucket = bookingsByDate.get(slot.date) ?? [];
    const booking = bookingForReservedSlot(slot);
    bucket.push(booking);
    bookingsByDate.set(slot.date, bucket);
    commit(slot.date, teamsOf(slot), booking);
    // **Counted here, where the slot becomes a booking**, rather than off
    // `reservedSlots.length` where it was only a restatement of the input: a
    // counter named for what the search *did* must be incremented where the
    // search does it, or deleting this loop would leave it claiming otherwise.
    meta.reservedSlotsHonoured += 1;
  }

  /** @type {import('./types.js').RelocationProposal[]} */
  const proposals = [];
  /** @type {import('./types.js').UnrelocatableGame[]} */
  const unrelocatable = [];
  for (const game of displaced) {
    const row = input.gamesById[game.gameId];
    if (!row) {
      throw new Error(
        `scenario: proposeRelocations() was handed displaced game "${game.gameId}" and no baseline row for it; the footprint that travels with a game comes from the row, and inventing one would be a second duration model`
      );
    }
    const format = /** @type {string} */ (game.format);
    const bookings = bookingsByDate.get(game.date) ?? [];
    const commitments = commitmentsByDate.get(game.date) ?? [];
    const searched = searchReplacements(engines, {
      gameId: game.gameId,
      row,
      format,
      date: game.date,
      surfaceIds: policy.surfaceIds,
      kickoffsFor: (surfaceId) => grid.get(`${format}|${game.date}|${surfaceId}`) ?? [],
      bookings,
      commitments,
      probe: input.probe,
    });
    meta.candidatesConsidered += searched.considered;
    meta.candidatesRefusedTeamClash += searched.refusedForTeamClash;
    meta.candidatesRefusedByGate += searched.refusedByGate;
    /**
     * Every candidate slot this game was offered, before any filter.
     *
     * `candidatesConsidered` used to be `options.length` — the slots that
     * *survived* — and on an unrelocatable game that branch runs only when
     * `options.length === 0`, so the field was structurally nought while the
     * run-wide counter beside it read in the thousands. `CLAUDE.md` §3 names
     * that shape: a meta-assertion nothing can make fail is not one. The
     * per-game counts now sum to `meta.candidatesConsidered`, so neither can
     * drift from the other without the reconciliation in the test failing.
     */
    const candidatesConsidered = searched.considered;
    if (searched.options.length === 0) {
      const refusals = [
        searched.refusedForTeamClash === 0
          ? ''
          : `${searched.refusedForTeamClash} otherwise-free slot(s) would have put one of its teams in two places at once`,
        searched.refusedByGate === 0
          ? ''
          : `${searched.refusedByGate} would have double-booked a coach, turned a surface over too fast or broken a facility rule, by resolve/'s own gate`,
      ].filter(Boolean);
      unrelocatable.push({
        gameId: game.gameId,
        label: game.label,
        reason: `the scenario withdraws the ground it stood on (${game.codes.join(', ')}) and none of the ${candidatesConsidered} candidate slot(s) on ${game.date} across ${policy.surfaceIds.length} replacement surface(s) is legal for it${refusals.length === 0 ? '' : ` (${refusals.join('; ')})`}; kept visible as TIME TBD rather than dropped (incident 10)`,
        codes: Object.freeze([...game.codes]),
        constraintIds: Object.freeze([...game.constraintIds]),
        candidatesConsidered,
      });
      meta.relocationsUnavailable += 1;
      continue;
    }

    const [chosen] = searched.options;
    const toSlot = {
      date: game.date,
      surfaceId: chosen.surfaceId,
      startMinutes: chosen.startMinutes,
    };
    const surface = engines.graph.surfaces[chosen.surfaceId];
    proposals.push({
      gameId: game.gameId,
      label: game.label,
      format,
      ranking: RELOCATION_RANKING,
      grade: chosen.grade,
      from: { date: game.date, surfaceId: game.surfaceId, startMinutes: game.startMinutes },
      to: toSlot,
      fromVenueId: game.venueId,
      toVenueId: surface?.venueId ?? '',
      driftMinutes: chosen.driftMinutes,
      score: chosen.score,
      compromiseCodes: Object.freeze([...chosen.compromiseCodes]),
      candidatesConsidered,
    });
    meta.relocationsProposed += 1;
    if (chosen.grade === REPLACEMENT_GRADE.COMPROMISED) meta.relocationsCompromised += 1;
    // The slot is held from this point on, keyed the way the capacity report
    // spells a candidate so the two can be reconciled — and in the probe, so
    // the next game's coach and turnover questions see this one where it is
    // going rather than where it was.
    const held = bookingFor(row, toSlot);
    bookings.push(held);
    bookingsByDate.set(game.date, bookings);
    input.probe.hold(game.gameId, toSlot);
    // The teams are held from this point on as well, so the next displaced game
    // sharing one of them cannot be offered the same minute on other ground.
    commit(game.date, teamsOf(row), held);
  }

  if (proposals.length > 0) {
    const venues = [...new Set(proposals.map((p) => p.toVenueId))].sort();
    const surfaces = [...new Set(proposals.map((p) => p.to.surfaceId))].sort();
    findings.push(
      makeScenarioFinding(
        SCENARIO_REASON.SCENARIO_RELOCATION_PROPOSED,
        `proposeRelocations() searched ${meta.candidatesConsidered} candidate slot(s), ranked "${RELOCATION_RANKING}", and proposed ${proposals.length} replacement(s) on ${venues.join(', ')}. These were **proposed**, not solved: the re-solver cannot move a game to another venue, and it is being handed these slots by name`,
        {
          ranking: RELOCATION_RANKING,
          policySource: policy.source,
          proposed: proposals.length,
          candidatesConsidered: meta.candidatesConsidered,
          venueIds: venues,
          surfaceIds: surfaces,
          formats,
        }
      )
    );
  }

  const compromised = proposals.filter((p) => p.grade === REPLACEMENT_GRADE.COMPROMISED);
  if (compromised.length > 0) {
    const codes = [...new Set(compromised.flatMap((p) => p.compromiseCodes))].sort();
    findings.push(
      makeScenarioFinding(
        SCENARIO_REASON.SCENARIO_RELOCATION_COMPROMISED,
        `${compromised.length} of the ${proposals.length} replacement(s) are legal but add ${codes.join(', ')}: ${[...new Set(compromised.map((p) => p.to.surfaceId))].sort().join(', ')} are size-eligible for the format under the downward-closed policy and painted for another one`,
        {
          ranking: RELOCATION_RANKING,
          compromised: compromised.length,
          proposed: proposals.length,
          codes,
          surfaceIds: [...new Set(compromised.map((p) => p.to.surfaceId))].sort(),
          exampleGameIds: compromised.slice(0, EXAMPLE_LIMIT).map((p) => p.gameId),
        }
      )
    );
  }

  if (unrelocatable.length > 0) {
    findings.push(
      makeScenarioFinding(
        SCENARIO_REASON.SCENARIO_RELOCATION_UNAVAILABLE,
        `${unrelocatable.length} displaced game(s) have no legal replacement slot on their own date across the ${policy.surfaceIds.length} stated replacement surface(s), and are carried as TIME TBD with a reason rather than dropped (incident 10)`,
        {
          ranking: RELOCATION_RANKING,
          unrelocatable: unrelocatable.length,
          surfaceCount: policy.surfaceIds.length,
          exampleGameIds: unrelocatable.slice(0, EXAMPLE_LIMIT).map((entry) => entry.gameId),
          dates: [...new Set(unrelocatable.map((entry) => input.gamesById[entry.gameId]?.date))]
            .filter(Boolean)
            .sort(),
        }
      )
    );
  }

  return {
    ranking: RELOCATION_RANKING,
    surfaceIds: Object.freeze([...policy.surfaceIds]),
    proposals,
    unrelocatable,
    capacities,
    findings,
    status: deriveScenarioStatus(findings),
    meta,
  };
}
