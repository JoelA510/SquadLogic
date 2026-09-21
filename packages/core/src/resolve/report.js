/**
 * **The dry-run report.** What would change, before anything is committed.
 *
 * > *"Structure the report as (a) games you asked to change, (b) games that
 * > moved as a consequence, with the constraint that forced each, and (c)
 * > quality deltas. Category (b) is the one that matters — it's what nobody
 * > notices until families complain."*
 *
 * ## The two categories are built from different sources on purpose
 *
 * Category (a) is enumerated from the **change request**: every change the
 * caller asked for, including the ones that did not happen, because "we ignored
 * four of your eight fixtures" is the single most useful line in the report and
 * a list built from what moved cannot contain it.
 *
 * Category (b) is enumerated from the **baseline schedule**, through
 * `diffAgainstBaseline()`, and then has category (a) subtracted from it. It is
 * never built from the move ledger: a stage that wrote around the mutation gate
 * is absent from the ledger, and a "games that moved" list assembled from the
 * ledger would report a quiet season while half of it had moved. That is
 * incident 1 and it is `docs/LESSONS_LEARNED.md`'s "never derive a check's
 * subject set from the data a break would corrupt".
 *
 * The partition is then **counted rather than asserted**: every moved game must
 * appear exactly once across the two lists, and one that appears twice is
 * `RESOLVE_REPORT_PARTITION_INCOMPLETE` at blocking. Membership is decided by
 * the change request, so nothing can land in both by that route — which is
 * exactly why the check is a count and not a restatement of how the lists were
 * built. A `moved` list naming one game twice double-counts it in category (b)
 * *and* against the change budget, and a partition check that could not fail
 * would be the kind `docs/LESSONS_LEARNED.md` describes comparing a set against
 * itself. `tests/minimalDiff.test.js` hands this builder such a list and proves
 * the check fires.
 *
 * ## Every consequential move names what forced it
 *
 * The cause is read from the move ledger's `cause` field, recorded by the stage
 * that decided — `checkPlacement()`'s reason codes and counterpart games, the
 * Phase 1.3 binding kind and its slack in minutes, and the Phase 2.1 registry's
 * constraint ids. Nothing is re-derived here. A moved game with no cause
 * anywhere in its slice of the ledger raises
 * `RESOLVE_CONSEQUENTIAL_MOVE_UNEXPLAINED` at blocking: a game that left the
 * schedule for a reason nobody can name is the failure this whole category
 * exists to prevent.
 *
 * **And it names who it lands on.** Each consequential move carries the people
 * whose commitments sit on that game, taken from `schedule.commitments` — the
 * roster-derived timeline, not anything re-joined here. "The knock-on to coach
 * assignments" stops being an abstraction at the point where the report can
 * print the person keys.
 *
 * @module resolve/report
 */

import { CONSTRAINT_SEVERITY } from '../constraints/reasonCodes.js';

import { RESOLVE_REASON, makeResolveFinding } from './reasonCodes.js';
import { changeTermsDisabled, disabledChangeTerms, scoreSchedule } from './objective.js';
import { slotKey } from './state.js';

/**
 * The people a game's commitments belong to, from the schedule that carries
 * them.
 *
 * @param {import('../ruleEngine/types.js').Schedule} schedule
 * @returns {Map<string, string[]>}
 */
function peopleByGameId(schedule) {
  /** @type {Map<string, Set<string>>} */
  const people = new Map();
  for (const commitment of schedule.commitments ?? []) {
    if (typeof commitment.gameId !== 'string' || commitment.gameId.length === 0) continue;
    if (!people.has(commitment.gameId)) people.set(commitment.gameId, new Set());
    /** @type {Set<string>} */ (people.get(commitment.gameId)).add(commitment.personId);
  }
  return new Map([...people].map(([gameId, ids]) => [gameId, [...ids].sort()]));
}

/**
 * The first cause recorded for a game in this run.
 *
 * First rather than last: the move that lifted a game out of its slot is the one
 * that knows why it had to move at all, and everything after it is that
 * decision playing out.
 *
 * @param {ReadonlyArray<import('./types.js').MoveRecord>} moves
 * @param {string} gameId
 * @returns {{ cause: Record<string, unknown>, move: import('./types.js').MoveRecord }|null}
 */
function firstCauseFor(moves, gameId) {
  for (const move of moves) {
    if (move.gameId !== gameId) continue;
    if (move.cause === null || move.cause === undefined) continue;
    return { cause: /** @type {Record<string, unknown>} */ (move.cause), move };
  }
  return null;
}

/**
 * One string field of a cause, or null when the cause did not carry it.
 *
 * @param {Record<string, unknown>|null} cause
 * @param {string} key
 * @returns {string|null}
 */
function text(cause, key) {
  if (cause === null) return null;
  const value = cause[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * One list field of a cause, copied out.
 *
 * @param {Record<string, unknown>|null} cause
 * @param {string} key
 * @returns {string[]}
 */
function list(cause, key) {
  if (cause === null) return [];
  const value = cause[key];
  return Array.isArray(value) ? value.map((entry) => String(entry)) : [];
}

/**
 * Violation counts per code and per severity.
 *
 * **Exported since Prompt 6.1**, so `scenario/diff.js` can answer *"which
 * constraints break"* with this tally rather than a second one. Two tallies
 * would be free to disagree about a waived violation, and nothing would detect
 * the drift.
 *
 * @param {Object|null} verification
 * @returns {{ byCode: Record<string, number>, bySeverity: Record<string, number>, total: number }}
 */
export function violationTally(verification) {
  /** @type {Record<string, number>} */
  const byCode = {};
  /** @type {Record<string, number>} */
  const bySeverity = {
    [CONSTRAINT_SEVERITY.BLOCKING]: 0,
    [CONSTRAINT_SEVERITY.COMPROMISE]: 0,
    [CONSTRAINT_SEVERITY.INFO]: 0,
  };
  const violations = verification?.violations ?? [];
  for (const violation of violations) {
    byCode[violation.code] = (byCode[violation.code] ?? 0) + 1;
    bySeverity[violation.severity] = (bySeverity[violation.severity] ?? 0) + 1;
  }
  return { byCode, bySeverity, total: violations.length };
}

/**
 * Build the dry-run report for one run.
 *
 * @param {Object} input
 * @param {string} input.name
 * @param {import('../ruleEngine/types.js').Schedule} input.baselineSchedule
 * @param {import('../ruleEngine/types.js').Schedule} input.schedule - the proposal
 * @param {ReadonlyArray<Object>} input.changes - the parsed change request
 * @param {ReadonlyArray<import('./types.js').ScheduleChange>} input.moved - `diffAgainstBaseline().moved`
 * @param {import('./types.js').BaselinePartition} [input.partition] - the whole of it
 * @param {ReadonlyArray<{ gameId: string, reason: string }>} input.unplaced
 * @param {ReadonlyArray<import('./types.js').MoveRecord>} input.moves
 * @param {import('./types.js').ResolveState} input.state
 * @param {Object|null} input.baselineVerification
 * @param {Object|null} input.verification
 * @param {Readonly<Record<string, number>>} input.weights
 * @param {number|null} input.changeBudget
 * @returns {import('./types.js').ChangeReport}
 */
export function buildChangeReport(input) {
  const {
    baselineSchedule,
    schedule,
    changes,
    moved,
    moves,
    state,
    baselineVerification,
    verification,
    weights,
    changeBudget,
  } = input;
  const partition = input.partition ?? null;

  const movedById = new Map(moved.map((change) => [change.gameId, change]));
  const requestedIds = new Set(changes.map((change) => change.gameId));
  const people = peopleByGameId(baselineSchedule);

  /** @type {import('../freeze/types.js').FreezeFinding[]} */
  const findings = [];

  /* -- (a) the games you asked to change ----------------------------------- */

  /** @type {import('./types.js').RequestedChange[]} */
  const requested = changes.map((change) => {
    const baseline = state.baseline[change.gameId] ?? null;
    const now = state.games[change.gameId] ?? null;
    const target =
      baseline === null
        ? null
        : {
            date: change.date ?? baseline.date,
            surfaceId: change.surfaceId ?? baseline.surfaceId,
            startMinutes: change.startMinutes,
          };
    const beforeKey =
      baseline === null
        ? null
        : slotKey({
            date: baseline.date,
            surfaceId: baseline.surfaceId,
            startMinutes: baseline.startMinutes,
          });
    const afterKey =
      now === null
        ? null
        : slotKey({ date: now.date, surfaceId: now.surfaceId, startMinutes: now.startMinutes });
    const requestedKey = target === null ? null : slotKey(target);

    /** @type {string} */
    let outcome;
    if (baseline === null) outcome = 'unknown-game';
    else if (afterKey === null) outcome = 'unplaced';
    else if (afterKey === requestedKey) outcome = beforeKey === requestedKey ? 'no-op' : 'applied';
    else if (afterKey === beforeKey) outcome = 'refused';
    else outcome = 'displaced';

    return {
      gameId: change.gameId,
      label: baseline === null ? null : `${baseline.homeLabel} v ${baseline.awayLabel}`,
      disposition: state.dispositions[change.gameId] ?? null,
      requestedSlot: requestedKey,
      before: beforeKey,
      after: afterKey,
      outcome,
      moved: movedById.has(change.gameId),
      personIds: people.get(change.gameId) ?? [],
    };
  });

  /* -- (b) the games that moved as a consequence --------------------------- */

  /** @type {import('./types.js').ConsequentialChange[]} */
  const consequential = [];
  for (const change of moved) {
    if (requestedIds.has(change.gameId)) continue;
    const found = firstCauseFor(moves, change.gameId);
    const cause = found?.cause ?? null;
    const entry = {
      gameId: change.gameId,
      label: change.label,
      disposition: change.disposition,
      before: slotKey(change.before),
      after: change.after === null ? null : slotKey(change.after),
      changedFields: [...change.changedFields],
      // The specific instance, not the class: which codes, which registry
      // constraints, which *other games* it clashed with, and how many minutes
      // short the binding edge was.
      causeKind: cause === null ? null : String(cause.kind),
      codes: /** @type {string|null} */ (text(cause, 'codes')),
      constraintId: /** @type {string|null} */ (text(cause, 'constraintId')),
      constraintIds: list(cause, 'constraintIds'),
      counterpartGameIds: list(cause, 'counterpartGameIds'),
      bindingKinds: list(cause, 'bindingKinds'),
      slackMinutes: /** @type {number|null} */ (
        cause === null || typeof cause.slackMinutes !== 'number' ? null : cause.slackMinutes
      ),
      forcedByStageId: found?.move.stageId ?? null,
      reason: found?.move.reason ?? null,
      // Who finds out.
      personIds: people.get(change.gameId) ?? [],
    };
    consequential.push(entry);

    if (cause === null) {
      findings.push(
        makeResolveFinding(
          RESOLVE_REASON.RESOLVE_CONSEQUENTIAL_MOVE_UNEXPLAINED,
          `game "${change.gameId}" moved from ${entry.before} to ${entry.after ?? '(unplaced)'} and nothing in this run can say what forced it; a game nobody asked about that moved for a reason nobody recorded is incident 1 in miniature`,
          { gameId: change.gameId, beforeSlot: entry.before, afterSlot: entry.after ?? '' }
        )
      );
    }
  }
  consequential.sort((a, b) => a.gameId.localeCompare(b.gameId));

  /* -- the partition, checked rather than assumed -------------------------- */

  const movedRequested = moved.filter((change) => requestedIds.has(change.gameId));

  // **Counted, not assumed.** Every moved game must appear exactly once across
  // the two categories. Membership is decided by the change request, so a game
  // cannot land in both by that route — but the two lists are still built by
  // different passes over different inputs, and the failure this catches is the
  // one that would otherwise be invisible: a `moved` list naming one game twice
  // double-counts it in category (b), double-counts it against the change
  // budget, and reports a diff larger than the season contains. A partition
  // stated as a construction invariant and never counted is the shape of every
  // check in `docs/LESSONS_LEARNED.md` that compared a set against itself.
  /** @type {Map<string, number>} */
  const appearances = new Map();
  for (const change of movedRequested) {
    appearances.set(change.gameId, (appearances.get(change.gameId) ?? 0) + 1);
  }
  for (const entry of consequential) {
    appearances.set(entry.gameId, (appearances.get(entry.gameId) ?? 0) + 1);
  }
  const uncategorised = [...appearances]
    .filter(([, count]) => count !== 1)
    .map(([gameId]) => gameId)
    .sort();
  if (uncategorised.length > 0) {
    findings.push(
      makeResolveFinding(
        RESOLVE_REASON.RESOLVE_REPORT_PARTITION_INCOMPLETE,
        `${uncategorised.length} moved game(s) do not appear exactly once across the two categories of this report (${uncategorised.slice(0, 5).join(', ')}); a game counted twice is a diff larger than the season contains and a change budget spent on nothing`,
        { gameCount: uncategorised.length, exampleGameIds: uncategorised.slice(0, 5) }
      )
    );
  }

  /* -- (c) quality deltas --------------------------------------------------- */

  const before = violationTally(baselineVerification);
  const after = violationTally(verification);
  const measured = baselineVerification !== null && verification !== null;

  /** @type {Record<string, { baseline: number, resolved: number, delta: number }>} */
  const byCode = {};
  for (const code of [
    ...new Set([...Object.keys(before.byCode), ...Object.keys(after.byCode)]),
  ].sort()) {
    const baselineCount = before.byCode[code] ?? 0;
    const resolvedCount = after.byCode[code] ?? 0;
    byCode[code] = {
      baseline: baselineCount,
      resolved: resolvedCount,
      delta: resolvedCount - baselineCount,
    };
  }
  /** @type {Record<string, { baseline: number, resolved: number, delta: number }>} */
  const bySeverity = {};
  for (const severity of Object.values(CONSTRAINT_SEVERITY)) {
    const baselineCount = before.bySeverity[severity] ?? 0;
    const resolvedCount = after.bySeverity[severity] ?? 0;
    bySeverity[severity] = {
      baseline: baselineCount,
      resolved: resolvedCount,
      delta: resolvedCount - baselineCount,
    };
  }

  if (!measured) {
    findings.push(
      makeResolveFinding(
        RESOLVE_REASON.RESOLVE_REPORT_QUALITY_UNMEASURED,
        'this run reports no quality deltas because the standing rule engine did not run over it; "nothing got worse" and "nothing was measured" are the same sentence to a tired operator and only one of them is good news, so commitResolve() refuses this run unless the caller names the acceptance',
        { name: input.name }
      )
    );
  }

  /* -- the objective, scored through the one function ---------------------- */

  // **Both sides measured the same way, or neither.** `measured` is exactly
  // "the rule engine ran over both", and a caller who supplies a
  // `baselineVerification` alongside `verify: false` would otherwise have a
  // quality-inclusive baseline subtracted from a quality-free result: a delta of
  // several thousand to the good, entirely an artefact of the mismatch, reading
  // as the one thing this report exists to be trusted about. The `measured:
  // false` finding is an `info` and would not stop anybody reading the number,
  // so the number itself is made honest instead. With quality dropped from both
  // sides the delta is a pure change cost, which can only ever be >= 0 — a
  // re-solve is never *rewarded* for having moved something.
  const baselineScore = scoreSchedule({
    referenceGames: baselineSchedule.games,
    games: baselineSchedule.games,
    verification: measured ? baselineVerification : null,
    weights,
  });
  const resolvedScore = scoreSchedule({
    referenceGames: baselineSchedule.games,
    games: schedule.games,
    verification: measured ? verification : null,
    weights,
  });

  const disabledTerms = disabledChangeTerms(weights);
  // "All of them" is the stronger statement and is asked for as such, rather
  // than by counting this list against a number written here.
  const all = changeTermsDisabled(weights);
  if (disabledTerms.length > 0) {
    findings.push(
      makeResolveFinding(
        RESOLVE_REASON.RESOLVE_OBJECTIVE_CHANGE_TERM_DISABLED,
        all
          ? `every change term of the objective (${disabledTerms.join(', ')}) is weighted zero, so this run was scored with change minimisation switched off: it returns the best schedule it could find rather than the nearest acceptable one, which is the objective incident 1’s solver had`
          : `the change term(s) ${disabledTerms.join(', ')} are weighted zero, so this run was scored with change minimisation partly switched off; what is left of it cannot outweigh an ordinary quality shortfall, and the run behaves like a re-optimisation while reading as an ordinary change request`,
        // Read back out of the score this run actually used, rather than out of
        // the weight table: no file outside `objective.js` reads an individual
        // weight, which is what keeps one table one table. It also means the
        // finding reports the weights that were *applied* rather than the ones
        // that were passed, and those are the same number only while nothing in
        // between has gone wrong.
        {
          disabledTerms: [...disabledTerms],
          allChangeTermsDisabled: all,
          ...Object.fromEntries(
            disabledTerms.map((term) => [term, resolvedScore.terms[term].weight])
          ),
        }
      )
    );
  }

  /* -- the change budget ---------------------------------------------------- */

  const blockingConstraintIds = [
    ...new Set(consequential.flatMap((entry) => entry.constraintIds)),
  ].sort();
  const withinBudget = changeBudget === null || moved.length <= changeBudget;
  const budget = {
    limit: changeBudget,
    moved: moved.length,
    requested: movedRequested.length,
    consequential: consequential.length,
    withinBudget,
    blockingConstraintIds,
  };

  // Did the budget *stop* something, rather than merely not being reached?
  // `RESOLVE_CHANGE_BUDGET_BOUND` is emitted by the placing stages at the
  // moment they refuse a move, so its presence is the fact; counting refusals
  // here from the run's own meta would be a second opinion about the same
  // event. `RESOLVE_CHANGE_BUDGET_MET` at `info` would read as an all-clear
  // over a repair that stopped early, so the two are mutually exclusive.
  const budgetBoundTheRepair = state.ledger.findings.some(
    (finding) => finding.code === RESOLVE_REASON.RESOLVE_CHANGE_BUDGET_BOUND
  );

  if (changeBudget !== null) {
    if (!withinBudget) {
      findings.push(
        makeResolveFinding(
          RESOLVE_REASON.RESOLVE_CHANGE_BUDGET_EXCEEDED,
          `the change budget allows ${changeBudget} moved game(s) and this re-solve moves ${moved.length}: ${movedRequested.length} the request named and ${consequential.length} that moved as a consequence, forced by ${blockingConstraintIds.join(', ') || 'no constraint this run can name'}. Nothing has been committed`,
          {
            budget: changeBudget,
            moved: moved.length,
            requested: movedRequested.length,
            consequential: consequential.length,
            constraintIds: blockingConstraintIds,
            constraintId: blockingConstraintIds[0] ?? null,
            exampleGameIds: consequential.slice(0, 5).map((entry) => entry.gameId),
          }
        )
      );
    } else if (!budgetBoundTheRepair) {
      findings.push(
        makeResolveFinding(
          RESOLVE_REASON.RESOLVE_CHANGE_BUDGET_MET,
          `the change budget of ${changeBudget} was checked against ${moved.length} moved game(s): ${movedRequested.length} requested and ${consequential.length} consequential`,
          {
            budget: changeBudget,
            moved: moved.length,
            requested: movedRequested.length,
            consequential: consequential.length,
          }
        )
      );
    }
  }

  /* -- published-time hold -------------------------------------------------- */

  /** @type {import('./types.js').PublishedHold|null} */
  let hold = null;
  if (partition !== null) {
    hold = {
      baselineGames: partition.counts.baselineGames,
      kickoffHeld: partition.counts.publishedKickoffHeld,
      slotHeld: partition.counts.publishedSlotHeld,
      kickoffChanged: partition.counts.baselineGames - partition.counts.publishedKickoffHeld,
      moved: partition.counts.moved,
      unplaced: partition.counts.unplaced,
    };
    findings.push(
      makeResolveFinding(
        RESOLVE_REASON.RESOLVE_PUBLISHED_HOLD_MEASURED,
        `${hold.kickoffHeld} of ${hold.baselineGames} published kickoff(s) held, ${hold.slotHeld} of them on their published ground; ${hold.moved} game(s) moved and ${hold.unplaced} have no time at all`,
        {
          baselineGames: hold.baselineGames,
          kickoffHeld: hold.kickoffHeld,
          slotHeld: hold.slotHeld,
          kickoffChanged: hold.kickoffChanged,
          moved: hold.moved,
          unplaced: hold.unplaced,
        }
      )
    );
  }

  const explained = consequential.filter((entry) => entry.causeKind !== null).length;

  return /** @type {import('./types.js').ChangeReport} */ ({
    name: input.name,
    dryRun: true,
    requested,
    consequential,
    quality: {
      measured,
      byCode,
      bySeverity,
      introduced: Object.entries(byCode)
        .filter(([, counts]) => counts.delta > 0)
        .map(([code, counts]) => ({ code, ...counts })),
      resolved: Object.entries(byCode)
        .filter(([, counts]) => counts.delta < 0)
        .map(([code, counts]) => ({ code, ...counts })),
    },
    objective: {
      weights,
      changeTermsDisabled: changeTermsDisabled(weights),
      disabledChangeTerms: [...disabledTerms],
      baseline: baselineScore,
      resolvedSchedule: resolvedScore,
      delta: resolvedScore.total - baselineScore.total,
      // Whether the delta above includes the quality half at all. It says so
      // rather than the reader having to infer it from two `qualityMeasured`
      // flags that would agree by construction.
      deltaIncludesQuality: measured,
    },
    budget,
    hold,
    unplaced: input.unplaced.map((entry) => ({ ...entry })),
    meta: {
      movedGames: moved.length,
      movedRequested: movedRequested.length,
      movedConsequential: consequential.length,
      movedConsequentialExplained: explained,
      changesRequested: changes.length,
      partitionComplete:
        uncategorised.length === 0 && movedRequested.length + consequential.length === moved.length,
      peopleNamed: [...new Set(consequential.flatMap((entry) => entry.personIds))].length,
    },
    findings,
  });
}
