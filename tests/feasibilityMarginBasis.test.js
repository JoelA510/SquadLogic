/**
 * **The margin names the tightest bound, not the first one claimed (#63).**
 *
 * `marginFrom()` (`feasibility/verdict.js`) reports the binding member with the
 * smallest `slackMinutes` as the margin and names it as the basis. The guard
 * exists because the answer once reported the tightest number under the first
 * member's name. The witness for it was the corpus's 06GMicro01 at 12:30 in
 * `feasibilityApi.test.js`. #439 (#61, coach overlaps made compromise) changed
 * that answer's binding set, and no corpus answer now has a first bound that is
 * not also its tightest, so the test there checks the invariant but a regression
 * to "name the first-claimed bound" would pass it. This file is the constructed
 * witness for `marginFrom()`.
 *
 * **Not covered here:** the roll-up in `canTeamPlay()` that copies the chosen
 * candidate's basis (`marginBasis: best?.marginBasis`, `feasibility/queries.js`).
 * The original defect was there, as `best?.binding?.[0]?.kind`. Reverting it
 * would pass this file, because no answer-level case with a divergent binding
 * exists yet.
 *
 * **Reachable, not forged.** The binding set is built by the production
 * `boundsOf()`, which orders bounds by `kind` alphabetically. That order says
 * nothing about slack, so at any boundary where the alphabetically first kind is
 * not the tightest, the first-claimed and tightest rules disagree. The inputs are
 * synthetic: three of the four availability kinds, each raised with the reason
 * code for the edge it describes (checked against 4.3's kind-to-code table), and
 * invented record ids.
 *
 * **The subject set is the input.** Which bound is tightest, loosest and
 * first-claimed is worked out from `INPUT_CONSTRAINTS`, never from the answer,
 * and the meta-assertion checks that the three are different bounds. If they
 * coincide, the first-claimed and loosest rules give the right answer too and
 * the witness proves nothing, so the test fails instead.
 */
import { describe, it, expect } from 'vitest';

import {
  AVAILABILITY_CONSTRAINT,
  AVAILABILITY_REASON,
} from '@squadlogic/core/availability/index.js';
import {
  ATTRIBUTION_CODES_BY_CONSTRAINT_KIND,
  ATTRIBUTION_SEVERITY,
} from '@squadlogic/core/attribution/index.js';
import { buildSeason2026ConstraintRegistry } from '@squadlogic/core/constraints/index.js';
import { boundsOf, marginFrom } from '@squadlogic/core/feasibility/index.js';

const registry = buildSeason2026ConstraintRegistry();

/**
 * Three availability edges at one boundary, all measured and all past their
 * limit, listed in neither slack nor kind order. `boundsOf()` will claim
 * `lighting` first (alphabetical); `permit` is the tightest and `sunset` the
 * loosest. `code` is the finding that edge raises when it is exceeded.
 */
const INPUT_CONSTRAINTS = Object.freeze([
  Object.freeze({
    kind: AVAILABILITY_CONSTRAINT.SUNSET,
    code: AVAILABILITY_REASON.SUNSET_MARGIN_VIOLATED,
    source: 'synthetic-sunset-t63',
    limitMinutes: 19 * 60 + 5,
    slackMinutes: -5,
  }),
  Object.freeze({
    kind: AVAILABILITY_CONSTRAINT.PERMIT,
    code: AVAILABILITY_REASON.PERMIT_CLOSE_EXCEEDED,
    source: 'synthetic-permit-t63',
    limitMinutes: 18 * 60 + 15,
    slackMinutes: -55,
  }),
  Object.freeze({
    kind: AVAILABILITY_CONSTRAINT.LIGHTING,
    code: AVAILABILITY_REASON.LIGHTS_OFF_EXCEEDED,
    source: 'synthetic-lights-t63',
    limitMinutes: 18 * 60 + 40,
    slackMinutes: -30,
  }),
]);

/**
 * One blocking finding per input constraint, with that constraint's own code.
 *
 * @param {ReadonlyArray<{ kind: string, code: string }>} constraints
 */
function speakingFor(constraints) {
  return constraints.map((constraint) => ({
    code: constraint.code,
    severity: ATTRIBUTION_SEVERITY.BLOCKING,
    message: `synthetic ${constraint.kind} finding`,
  }));
}

/** @param {ReadonlyArray<string>} kinds */
const byKindOrder = (kinds) => [...kinds].sort((a, b) => a.localeCompare(b));

/**
 * Which input constraint each selection rule would pick. Worked out from the
 * input alone. "First claimed" is `boundsOf()`'s documented order (by kind).
 *
 * @param {ReadonlyArray<{ kind: string, slackMinutes: number }>} constraints
 */
function rolesOf(constraints) {
  const bySlack = [...constraints].sort((a, b) => a.slackMinutes - b.slackMinutes);
  const firstKind = byKindOrder(constraints.map((constraint) => constraint.kind))[0];
  return {
    tightest: bySlack[0],
    loosest: bySlack[bySlack.length - 1],
    firstClaimed: constraints.find((constraint) => constraint.kind === firstKind),
    distinctSlacks: new Set(constraints.map((constraint) => constraint.slackMinutes)).size,
  };
}

/**
 * Every ordering of a list.
 *
 * @template T
 * @param {ReadonlyArray<T>} items
 * @returns {T[][]}
 */
function permutationsOf(items) {
  if (items.length <= 1) return [[...items]];
  return items.flatMap((item, index) =>
    permutationsOf([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [
      item,
      ...rest,
    ])
  );
}

/** The production binding set for the fixture. */
function productionBinding() {
  return boundsOf({ registry }, { constraints: INPUT_CONSTRAINTS }, speakingFor(INPUT_CONSTRAINTS));
}

describe('feasibility :: #63 — the margin names the tightest bound, not the first claimed', () => {
  const roles = rolesOf(INPUT_CONSTRAINTS);

  it('the fixture separates first-claimed, tightest and loosest (meta-assertion)', () => {
    // Taken from the input. With ties or a shared bound, the first-claimed or
    // loosest rule would give the tightest's answer and the witness would pass
    // over nothing.
    expect(INPUT_CONSTRAINTS.length).toBe(3);
    expect(roles.distinctSlacks).toBe(INPUT_CONSTRAINTS.length);
    expect(roles.firstClaimed?.kind).not.toBe(roles.tightest.kind);
    expect(roles.firstClaimed?.kind).not.toBe(roles.loosest.kind);
    expect(roles.tightest.kind).not.toBe(roles.loosest.kind);
    // Each code really is one production groups under its constraint's kind.
    for (const constraint of INPUT_CONSTRAINTS) {
      expect(ATTRIBUTION_CODES_BY_CONSTRAINT_KIND[constraint.kind], constraint.kind).toContain(
        constraint.code
      );
    }
  });

  it('boundsOf() claims a non-tightest bound first, and marginFrom() still names the tightest', () => {
    const binding = productionBinding();

    // Every input constraint became a bound, each with its own slack copied
    // over, and the production order really does put the non-tightest first.
    expect(binding.map((bound) => bound.kind)).toEqual(
      byKindOrder(INPUT_CONSTRAINTS.map((constraint) => constraint.kind))
    );
    for (const constraint of INPUT_CONSTRAINTS) {
      const bound = binding.find((candidate) => candidate.kind === constraint.kind);
      expect(bound?.slackMinutes, constraint.kind).toBe(constraint.slackMinutes);
    }
    expect(binding[0].kind).toBe(roles.firstClaimed?.kind);

    // **The guard.**
    const { marginMinutes, marginBasis } = marginFrom(binding);
    expect(marginBasis).toBe(roles.tightest.kind);
    expect(marginMinutes).toBe(roles.tightest.slackMinutes);
    expect(marginBasis).not.toBe(roles.firstClaimed?.kind);
    expect(marginBasis).not.toBe(roles.loosest.kind);
  });

  it('names the same bound whatever order the binding arrives in', () => {
    // `canGameMove()` builds its binding from claims in merge order, not by
    // kind, so an order other than `boundsOf()`'s can reach `marginFrom()`. The
    // answer must not depend on it. The coverage condition for this test is the
    // meta-assertion above: with three distinct slacks, some orderings put the
    // loosest bound first and some the middle one.
    const binding = productionBinding();
    expect(binding).toHaveLength(INPUT_CONSTRAINTS.length);
    const orderings = permutationsOf(binding);
    expect(orderings).toHaveLength(6);
    for (const ordering of orderings) {
      const label = ordering.map((bound) => bound.kind).join(',');
      expect(marginFrom(ordering), label).toEqual({
        marginMinutes: roles.tightest.slackMinutes,
        marginBasis: roles.tightest.kind,
      });
    }
  });
});
