/**
 * Zod schemas for change requests and pipeline stages.
 *
 * `.strict()` throughout, matching every Phase 1-3 module.
 *
 * The refinement that carries the design is on {@link FreezeContractSchema}: a
 * stage whose freeze contract is **empty** is refused at build time, exactly as
 * `RuleExerciseSchema.superRefine` refuses a rule that promises nothing about
 * what it examined. A stage must say which kinds of write it performs, which
 * adversarial probe proves it honours the freeze, and what it claims about
 * frozen games — and the three have to agree with each other. A stage that
 * declares no mutation kinds must carry the `writes-nothing` probe, and one
 * that declares any must carry `offers-frozen-move`; a stage cannot be
 * registered in a state where its probe would pass without testing anything.
 *
 * @module resolve/schemas
 */

import { z } from 'zod';

import { MOVE_KIND } from './state.js';

/** Inclusive ISO calendar date, `YYYY-MM-DD`. No `Date` construction anywhere. */
const IsoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, { message: 'expected an ISO YYYY-MM-DD date' });

/** A non-empty opaque identifier. */
const IdSchema = z.string().min(1, { message: 'ids must be non-empty strings' });

/** Minutes past midnight. Never a `Date`, never a wall-clock string. */
const MinutesSchema = z.number().int().min(0);

/**
 * One requested change.
 *
 * `date` and `surfaceId` default to null, meaning "wherever it is now": the
 * common request is a time change on the ground the game already has.
 */
/**
 * Who chose a change's destination (#53).
 *
 * `change-request-apply` honours an operator's move as an instruction and asks
 * no rule of it (#436, incident 3). A slot a *machine* chose is not an
 * instruction, so it is judged by the same facility model and rule gate the
 * placer uses before it is applied, and refused rather than carried when it
 * fails. An operator's approval of an option `resolve/` offered is re-judged
 * the same way, because the world may have changed since it was offered.
 *
 * **Optional, and absent means `operator`.** The plan was to make it required
 * and fail closed; the callers number ~90 test call sites against the ~15 the
 * ruling set as the limit, so the fallback applies: absent reads as
 * `operator`, and `tests/relocationOptions.test.js` asserts every change
 * `packages/core/src` itself constructs states its origin. Absent is also
 * what keeps an operator change byte-identical in every report that echoes it.
 *
 * @readonly
 * @enum {string}
 */
export const CHANGE_ORIGIN = Object.freeze({
  /** A person asked for this slot. Applied as asked (#436's exemption). */
  OPERATOR: 'operator',
  /** `proposeRelocations()` chose this slot. Gated before it is applied. */
  PROPOSER: 'proposer',
  /** An operator approved an option `relocationOptions` offered. Re-judged. */
  APPROVED_OPTION: 'approved-option',
});

/**
 * The id of one offered relocation option: the game and the slot, spelled
 * the way every other slot key in this package is spelled. Deterministic, so
 * an approval names exactly the option the operator was shown.
 *
 * @param {string} gameId
 * @param {{ date: string, surfaceId: string, startMinutes: number }} slot
 * @returns {string}
 */
export function relocationOptionId(gameId, slot) {
  return `${gameId}@${slot.date}|${slot.surfaceId}|${slot.startMinutes}`;
}

export const ScheduleChangeRequestSchema = z
  .object({
    gameId: IdSchema,
    date: IsoDateSchema.nullable().default(null),
    surfaceId: IdSchema.nullable().default(null),
    startMinutes: MinutesSchema,
    reason: z.string().min(1).nullable().default(null),
    origin: z.enum(Object.values(CHANGE_ORIGIN)).optional(),
    /** `approved-option` only: the option approved, as offered. */
    optionId: IdSchema.optional(),
    /** `approved-option` only: the compromise codes the operator was shown. */
    compromiseCodes: z.array(z.string().min(1)).optional(),
  })
  .strict()
  .superRefine((change, ctx) => {
    const approved = change.origin === CHANGE_ORIGIN.APPROVED_OPTION;
    if (!approved) {
      if (change.optionId !== undefined || change.compromiseCodes !== undefined) {
        ctx.addIssue({
          code: 'custom',
          message: `optionId and compromiseCodes belong to an "${CHANGE_ORIGIN.APPROVED_OPTION}" change; on any other change they would be read by nothing`,
          path: ['origin'],
        });
      }
      return;
    }
    if (change.date === null || change.surfaceId === null) {
      ctx.addIssue({
        code: 'custom',
        message: 'an approved option names its whole slot: date, surface and kickoff',
        path: ['surfaceId'],
      });
      return;
    }
    if (change.compromiseCodes === undefined) {
      ctx.addIssue({
        code: 'custom',
        message:
          'an approved option carries the compromise codes the operator was shown, so an approval of a slot that has since grown a compromise is refused rather than applied',
        path: ['compromiseCodes'],
      });
    }
    const expected = relocationOptionId(change.gameId, {
      date: change.date,
      surfaceId: change.surfaceId,
      startMinutes: change.startMinutes,
    });
    if (change.optionId !== expected) {
      ctx.addIssue({
        code: 'custom',
        message: `an approved option's id must name the slot it moves the game to ("${expected}"); an approval that names one option and moves the game to another is approving nothing`,
        path: ['optionId'],
      });
    }
  });

/**
 * `resolve/`'s opt-in search for cross-venue options (#53).
 *
 * One stated search per format, in `RelocationPolicySchema`'s shape (the
 * scenario proposer's), because the ground, cadence and first kickoff are a
 * per-format question and there is no season-wide answer. The game's own
 * venue is excluded per game: an option is, by definition, somewhere else.
 */
export const RelocationSearchSchema = z
  .object({
    policies: z.record(z.string().min(1), z.unknown()),
    limit: z.number().int().min(1).max(3).default(3),
  })
  .strict();

/** The probe kinds a stage can declare. */
export const STAGE_PROBE = Object.freeze({
  /**
   * The stage is offered a frozen game it would want to move. The probe asserts
   * both that nothing frozen moved **and** that `movesRejectedByFreeze` grew.
   * The second half is the teeth: without it the probe passes against a stage
   * that never looked.
   */
  OFFERS_FROZEN_MOVE: 'offers-frozen-move',
  /**
   * The stage writes nothing. The probe asserts it applied no move at all and
   * left every placement identical.
   */
  WRITES_NOTHING: 'writes-nothing',
});

/** @see {@link import('./types.js').FreezeContract} */
export const FreezeContractSchema = z
  .object({
    mutationKinds: z
      .array(z.enum([MOVE_KIND.RELOCATE, MOVE_KIND.DISLODGE, MOVE_KIND.TIME_TBD]))
      .default([]),
    probe: z.enum([STAGE_PROBE.OFFERS_FROZEN_MOVE, STAGE_PROBE.WRITES_NOTHING]),
    claim: z.string().min(1, {
      message:
        'a stage must state what it promises about frozen games; a stage that promises nothing cannot be told apart from one that ignores the freeze (incident 2)',
    }),
  })
  .strict()
  .superRefine((contract, ctx) => {
    if (new Set(contract.mutationKinds).size !== contract.mutationKinds.length) {
      ctx.addIssue({
        code: 'custom',
        message: 'a stage must not declare the same mutation kind twice',
        path: ['mutationKinds'],
      });
    }
    const writes = contract.mutationKinds.length > 0;
    if (writes && contract.probe !== STAGE_PROBE.OFFERS_FROZEN_MOVE) {
      ctx.addIssue({
        code: 'custom',
        message: `a stage that declares mutation kinds must carry the "${STAGE_PROBE.OFFERS_FROZEN_MOVE}" probe; the "${STAGE_PROBE.WRITES_NOTHING}" probe would pass without ever offering it a frozen game`,
        path: ['probe'],
      });
    }
    if (!writes && contract.probe !== STAGE_PROBE.WRITES_NOTHING) {
      ctx.addIssue({
        code: 'custom',
        message: `a stage that declares no mutation kinds must carry the "${STAGE_PROBE.WRITES_NOTHING}" probe; the "${STAGE_PROBE.OFFERS_FROZEN_MOVE}" probe demands a rejection counter it can never produce`,
        path: ['probe'],
      });
    }
  });

/** @see {@link import('./types.js').ResolveStage} */
export const ResolveStageSchema = z
  .object({
    id: IdSchema,
    title: z.string().min(1),
    freezeContract: FreezeContractSchema,
    run: z.custom((value) => typeof value === 'function', 'a stage must carry a run() function'),
  })
  .strict();
