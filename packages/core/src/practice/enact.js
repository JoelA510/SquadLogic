/**
 * Enacting ONE practice repair recommendation, the core half (8.6 3b PR 11a;
 * `docs/PHASE_8_6_PR11_ENACT_PLAN.md` §1 steps 3a, 6, 7 and 8, §2, §5).
 *
 * Pure: no DB, no clock, no randomness. The caller (3b PR 11c) reads the
 * season fresh, adapts it (`buildPracticeRepairInput`), re-bases the session
 * state onto it (`practice/recommendations.js`), and then asks this module,
 * in order:
 *
 * 1. {@link retirementCommitOf}: is the retirement COMMITTED? Operator answer
 *    Q3: enact only once `fields.effective_to` is stored, and equal to the
 *    loss's date. It reads the FRESH field row, never the `loss` prop, which
 *    the dry-run preview builds from its own unsaved date.
 * 2. {@link judgeEnact}: does the one recommendation still stand, exactly as
 *    it was shown? Its series is still displaced, its `to` is still one of its
 *    candidates, its marginal against every other recommendation is not
 *    null, and `to`, `tier`, `origin`, `reason` and `objective.counts` equal
 *    what the admin was shown. Anything else is STALE and nothing is sent
 *    (the approved-option precedent, `resolve/stages.js:1011-1034`).
 * 3. {@link buildEnactPayload}: the write for that one entry only, built by
 *    the adapter's own builder from the FRESH recommendation, never from
 *    `result.rehomed` (a tier-2 move sits in `timeTbd`, `repair.js:108-113`,
 *    and is written as the move). The new row is
 *    `assigned_via = 'recommendation'`. `unlock` comes only from the prompt's
 *    accepted answer, with a GENERATED reason: ids and a date, no free text
 *    (Q4). A blackout is refused with a null payload (Q1: retirement-only
 *    until 3b PR 11d).
 * 4. {@link buildEnactRecord}: the `practice.recommendation_enacted` audit
 *    metadata, validated by the strict {@link PracticeEnactRecordSchema}.
 *
 * Every refusal is a `payload: null` with a named `refusal`: the caller sends
 * nothing. A refusal is never a partial write.
 *
 * **Unwired.** Nothing in production calls this module until 3b PR 11c
 * (`tests/unwiredLayerImporters.test.js` pins that).
 *
 * **Declared, not enforced here.** The writer's fingerprint does not cover
 * slots, fields, `effective_to`, blackouts, closures or coach data (plan §4,
 * Q5); the re-judge reads them fresh, so the exposure is the click-to-commit
 * latency, and the record says so in `fingerprint_covers`.
 *
 * @module practice/enact
 */

import { z } from 'zod';

import { isoDateOfDayNumber, isoDayNumber } from '../facility/index.js';
import {
  buildPracticeRepairContext,
  placementsExcept,
  repairPracticeLoss,
  shapeKey,
} from './repair.js';
import { PRACTICE_REPAIR_CAUSE_KIND, buildPracticeRepairPayload } from './repairAdapter.js';
import { PRACTICE_CHAIN_STOP } from './recommendations.js';

/** Why an enact is refused. Each one means: nothing is sent. */
export const PRACTICE_ENACT_REFUSAL = Object.freeze({
  /** The cause field's stored `effective_to` is NULL: the retirement is a preview. */
  RETIREMENT_UNCOMMITTED: 'retirement-uncommitted',
  /** The stored `effective_to` differs from the loss's date. */
  RETIREMENT_CHANGED: 'retirement-changed',
  /** Blackout enact is 3b PR 11d, after PR 12 (operator answer Q1). */
  BLACKOUT_NOT_ENACTABLE: 'blackout-not-enactable',
  /** The fresh re-judge differs from what the admin was shown. */
  STALE: 'stale',
  /** The adapter refused the write (its `refused` list says why). */
  PAYLOAD_REFUSED: 'payload-refused',
  /** The write re-ranges or replaces a locked row, and the prompt was not accepted. */
  UNLOCK_NOT_ACCEPTED: 'unlock-not-accepted',
  /** No writer fingerprint: an enact is never blind (plan §4). */
  NO_BASE_FINGERPRINT: 'no-base-fingerprint',
});

/** Why a re-judge is stale. */
export const PRACTICE_ENACT_STALE = Object.freeze({
  /** The series is enacted already. */
  ENACTED: 'enacted',
  /** The series is no longer displaced by the loss. */
  NOT_DISPLACED: 'not-displaced',
  /** The shown shape is no longer one of the series' candidates. */
  NOT_A_CANDIDATE: 'not-a-candidate',
  /** The shown shape clashes with another recommendation. */
  CLASHES: 'clashes',
  /** The fresh recommendation differs from the shown one. */
  CHANGED: 'changed',
});

/** What the writer's fingerprint covers (`20260929000000:179-204`), declared in every record. */
export const PRACTICE_ENACT_FINGERPRINT_COVERS = 'practice_assignments+practice_exceptions';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** @param {string} date @param {number} days */
function shiftDate(date, days) {
  return isoDateOfDayNumber(isoDayNumber(date) + days);
}

/** @param {unknown} value */
function id(value) {
  return String(value).toLowerCase();
}

/** One spelling of a JSON value with its keys sorted, for an exact comparison. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * The commit gate (operator answer Q3), on FRESH rows. Committed exactly when
 * the cause field's stored `effective_to` is non-null and equals the loss's
 * `field.effective_to`. The `loss` prop only names the field and the date
 * the caller believes; the stored row decides.
 *
 * @param {{ fields?: Array<{ id: string, effective_to?: string | null }> }} freshRows
 * @param {{ kind: string, field?: { id: string, effective_to?: string } }} loss
 * @returns {{ committed: boolean, refusal: string | null, fieldId: string | null,
 *   stored: string | null, claimed: string | null }}
 */
export function retirementCommitOf(freshRows, loss) {
  if (loss?.kind !== PRACTICE_REPAIR_CAUSE_KIND.RETIREMENT) {
    return {
      committed: false,
      refusal: PRACTICE_ENACT_REFUSAL.BLACKOUT_NOT_ENACTABLE,
      fieldId: null,
      stored: null,
      claimed: null,
    };
  }
  const fieldId = id(loss.field?.id);
  const claimed = loss.field?.effective_to ?? null;
  const row = (freshRows?.fields ?? []).find((field) => id(field.id) === fieldId) ?? null;
  // A field the fresh read does not hold has nothing stored for it.
  const stored = row?.effective_to ?? null;
  if (stored === null) {
    return {
      committed: false,
      refusal: PRACTICE_ENACT_REFUSAL.RETIREMENT_UNCOMMITTED,
      fieldId,
      stored,
      claimed,
    };
  }
  if (stored !== claimed) {
    return {
      committed: false,
      refusal: PRACTICE_ENACT_REFUSAL.RETIREMENT_CHANGED,
      fieldId,
      stored,
      claimed,
    };
  }
  return { committed: true, refusal: null, fieldId, stored, claimed };
}

/** The fields of a recommendation the admin is shown, and that must not change. */
function shownFieldsOf(recommendation) {
  return {
    to: recommendation.to === null ? null : { ...recommendation.to },
    tier: recommendation.tier,
    origin: recommendation.origin,
    reason: recommendation.reason,
    counts: recommendation.objective.counts,
  };
}

/**
 * Re-judge ONE recommendation against a re-based state (plan §1, step 6).
 *
 * @param {{ input: Object, recommendations: any[], enacted: string[] }} rebased -
 *   the session state re-based onto the fresh input
 * @param {string} assignmentId - S
 * @param {Object} shown - S's recommendation exactly as the admin was shown it
 * @returns {{ stands: boolean, why: string | null, assignmentId: string,
 *   differences: string[], shown: Object, fresh: any }}
 */
export function judgeEnact(rebased, assignmentId, shown) {
  const verdict = (why, fresh, differences = []) =>
    Object.freeze({
      stands: why === null,
      why,
      assignmentId,
      differences,
      shown,
      fresh,
    });
  if (shown?.assignmentId !== assignmentId) {
    throw new Error(`enact: the shown recommendation is not ${assignmentId}'s`);
  }
  if (rebased.enacted.includes(assignmentId)) return verdict(PRACTICE_ENACT_STALE.ENACTED, null);
  const fresh = rebased.recommendations.find((r) => r.assignmentId === assignmentId) ?? null;
  if (fresh === null) return verdict(PRACTICE_ENACT_STALE.NOT_DISPLACED, null);

  if (shown.to !== null) {
    // The shown shape, judged on the fresh context by the repair's own tests.
    const context = buildPracticeRepairContext(rebased.input);
    const entryById = new Map(context.candidatesBySeries.map((e) => [e.series.assignmentId, e]));
    const candidateFor = (seriesId, shape) => {
      const entry = entryById.get(seriesId);
      const key = shapeKey(shape);
      return [...entry.same, ...entry.cross].find((c) => shapeKey(c.shape) === key) ?? null;
    };
    const candidate = candidateFor(assignmentId, shown.to);
    if (candidate === null) return verdict(PRACTICE_ENACT_STALE.NOT_A_CANDIDATE, fresh);
    const chosen = new Map();
    for (const other of rebased.recommendations) {
      if (other.to === null || other.assignmentId === assignmentId) continue;
      const held = candidateFor(other.assignmentId, other.to);
      if (held === null) {
        throw new Error(`enact: ${other.assignmentId}'s recommendation is not its candidate`);
      }
      chosen.set(other.assignmentId, held);
    }
    const series = entryById.get(assignmentId).series;
    const rest = placementsExcept(context, chosen, assignmentId);
    if (context.marginal(series, candidate, rest.placed, rest.coachDays) === null) {
      return verdict(PRACTICE_ENACT_STALE.CLASHES, fresh);
    }
  }

  const before = shownFieldsOf(shown);
  const after = shownFieldsOf(fresh);
  const differences = Object.keys(before).filter(
    (key) => canonical(before[key]) !== canonical(after[key])
  );
  return verdict(
    differences.length === 0 ? null : PRACTICE_ENACT_STALE.CHANGED,
    fresh,
    differences
  );
}

/** The generated unlock reason (Q4): ids and the date only. */
function unlockReasonOf(enactKey, fieldId, lossDate) {
  return `enact ${enactKey}: retirement of field ${fieldId} from ${lossDate}`;
}

/**
 * The write for ONE judged recommendation (plan §1, step 7). `payload` is
 * null, with a `refusal`, unless every gate passes: a retirement, committed
 * on the fresh read and for the adapted loss's date, a standing re-judge, a
 * base fingerprint, no adapter refusal, and, when the write re-ranges or
 * replaces a locked row, the prompt accepted.
 *
 * @param {any} adapted - `buildPracticeRepairInput()` of the fresh read
 * @param {ReturnType<typeof judgeEnact>} judged
 * @param {{ accepted?: boolean, enactKey?: string } | null | undefined} answer - the prompt's answer
 * @param {ReturnType<typeof retirementCommitOf>} commit - the gate on the same fresh read
 */
export function buildEnactPayload(adapted, judged, answer, commit) {
  const refuse = (refusal, extra = {}) =>
    Object.freeze({ refusal, payload: null, plan: null, refused: [], unlock: [], ...extra });
  const { cause, baseFingerprint } = adapted.context;
  if (cause.kind !== PRACTICE_REPAIR_CAUSE_KIND.RETIREMENT) {
    return refuse(PRACTICE_ENACT_REFUSAL.BLACKOUT_NOT_ENACTABLE);
  }
  const lossDate = adapted.input.loss.from;
  if (!commit?.committed) {
    return refuse(commit?.refusal ?? PRACTICE_ENACT_REFUSAL.RETIREMENT_UNCOMMITTED);
  }
  // The gate must have judged THIS loss: its field, and D-1 stored.
  if (commit.fieldId !== cause.causeId || commit.stored !== shiftDate(lossDate, -1)) {
    return refuse(PRACTICE_ENACT_REFUSAL.RETIREMENT_CHANGED);
  }
  if (!judged.stands) return refuse(PRACTICE_ENACT_REFUSAL.STALE);
  if (typeof baseFingerprint !== 'string' || baseFingerprint === '') {
    return refuse(PRACTICE_ENACT_REFUSAL.NO_BASE_FINGERPRINT);
  }

  // Built from the FRESH recommendation, so a tier-2 move is written as the move.
  const recommendation = judged.fresh;
  const entry = { assignmentId: recommendation.assignmentId, window: null };
  const built = buildPracticeRepairPayload(
    adapted,
    {
      representation: 'split',
      lossDate,
      rehomed: recommendation.to === null ? [] : [{ ...entry, to: recommendation.to }],
      timeTbd: recommendation.to === null ? [{ ...entry, reason: recommendation.reason }] : [],
    },
    { assignedVia: 'recommendation' }
  );
  // One entry in, so every write names S alone; anything else is a bug here.
  const s = recommendation.assignmentId;
  const strays = [
    ...built.plan.closes,
    ...built.plan.exceptions,
    ...built.plan.unlockRequired,
  ].filter((item) => item.assignment_id !== s);
  if (strays.length > 0) {
    throw new Error(`enact: the write for ${s} touches ${strays.map((i) => i.assignment_id)}`);
  }
  if (built.payload === null) {
    return refuse(PRACTICE_ENACT_REFUSAL.PAYLOAD_REFUSED, {
      plan: built.plan,
      refused: built.refused,
    });
  }
  const unlockRequired = built.plan.unlockRequired;
  const accepted = answer?.accepted === true;
  if (unlockRequired.length > 0 && !accepted) {
    return refuse(PRACTICE_ENACT_REFUSAL.UNLOCK_NOT_ACCEPTED, { plan: built.plan });
  }
  let unlock = [];
  if (accepted) {
    const enactKey = answer?.enactKey;
    if (typeof enactKey !== 'string' || !UUID.test(enactKey)) {
      throw new TypeError('enact: an accepted answer needs its enactKey (a lowercase uuid)');
    }
    unlock = unlockRequired.map((row) => ({
      assignment_id: row.assignment_id,
      reason: unlockReasonOf(enactKey, cause.causeId, lossDate),
    }));
  }
  return Object.freeze({
    refusal: null,
    plan: built.plan,
    refused: [],
    unlock,
    payload: {
      assignmentRows: built.payload.assignmentRows,
      repair: { ...built.payload.repair, unlock },
    },
  });
}

/* -- the audit record ------------------------------------------------------ */

const Uuid = z.string().regex(UUID);
const IsoDate = z.string().regex(ISO_DATE);
const Range = z.string().regex(/^[[(]\d{4}-\d{2}-\d{2},\d{4}-\d{2}-\d{2}[\])]$/);
const Fingerprint = z.string().regex(/^[0-9a-f]{32}$/);
const Weekday = z.enum(['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']);
const Minutes = z.number().int().min(0).max(1440);
const Shape = z.strictObject({
  surface_id: Uuid,
  weekday: Weekday,
  start_minutes: Minutes,
  duration_minutes: z.number().int().positive(),
});
const Counts = z.record(z.string().regex(/^[A-Za-z]+$/), z.number().int().nonnegative());
const UnlockReason = z
  .string()
  .regex(/^enact [0-9a-f-]{36}: retirement of field [0-9a-f-]{36} from \d{4}-\d{2}-\d{2}$/);

/**
 * The `practice.recommendation_enacted` metadata (plan §5), strict: ids,
 * enums, dates and numbers only; the one free-text field is the generated
 * unlock reason. The Edge holds a strict twin (3b PR 11b).
 */
export const PracticeEnactRecordSchema = z.strictObject({
  schema_version: z.literal(1),
  enact_key: Uuid,
  run_id: Uuid,
  season_settings_id: Uuid,
  cause: z.strictObject({
    kind: z.literal(PRACTICE_REPAIR_CAUSE_KIND.RETIREMENT),
    id: Uuid,
    loss: z.strictObject({
      from: IsoDate,
      until: z.null(),
      surface_ids: z.array(Uuid).min(1),
      start_minutes: z.null(),
      end_minutes: z.null(),
      reason: z.literal('retirement'),
    }),
    stored_effective_to: IsoDate,
  }),
  series: z.strictObject({
    assignment_id: Uuid,
    team_id: Uuid,
    from: Shape,
    window: z.strictObject({ from: IsoDate, until: IsoDate }),
  }),
  decision: z.strictObject({
    kind: z.enum(['rehome', 'time_tbd']),
    to: Shape.nullable(),
    tier: z.enum(['same-venue', 'cross-venue']).nullable(),
    origin: z.literal('approved-option').nullable(),
    tbd_reason: z
      .string()
      .regex(/^[a-z-]+$/)
      .nullable(),
    objective: z.strictObject({ total: z.number().nonnegative(), counts: Counts }),
    coach_overlaps: z.array(Uuid),
    coach_days_worsened: z.number().int().nonnegative(),
  }),
  rejudge: z.strictObject({ stands: z.literal(true), shown_counts: Counts }),
  declined: z.array(z.strictObject({ assignment_id: Uuid, to: Shape })),
  chains: z.array(
    z.strictObject({
      kind: z.enum(['decline', 'undo', 'release']),
      assignment_id: Uuid,
      hops: z.number().int().nonnegative(),
      stopped_by: z.enum(/** @type {[string, ...string[]]} */ (Object.values(PRACTICE_CHAIN_STOP))),
    })
  ),
  local: z.boolean(),
  enacted_before: z.array(Uuid),
  prompt: z.strictObject({
    rows: z.array(
      z.strictObject({
        assignment_id: Uuid,
        assigned_via: z.enum(['auto', 'manual', 'repair', 'recommendation', 'override']),
        effect: z.enum(['closed', 'removed and replaced']),
        range_after: Range.nullable(),
      })
    ),
    published_practices_affected: z.number().int().nonnegative(),
    accepted: z.literal(true),
  }),
  unlock: z.array(z.strictObject({ assignment_id: Uuid, reason: UnlockReason })),
  writes: z.strictObject({
    closes: z.array(z.strictObject({ assignment_id: Uuid, last_day: IsoDate })),
    new_rows: z.array(
      z.strictObject({ team_id: Uuid, practice_slot_id: Uuid, effective_date_range: Range })
    ),
    exceptions: z.number().int().nonnegative(),
  }),
  base_fingerprint: Fingerprint,
  result_fingerprint: Fingerprint.nullable(),
  fingerprint_covers: z.literal(PRACTICE_ENACT_FINGERPRINT_COVERS),
  solver: z.strictObject({
    strategy: z.enum(['exact', 'greedy']),
    proven_optimal: z.boolean(),
    daylight_supplied: z.boolean(),
    closures_supplied: z.boolean(),
  }),
});

/** @param {{ surfaceId: string, weekday: string, startMinutes: number, durationMinutes: number }} shape */
function shapeRecord(shape) {
  return {
    surface_id: shape.surfaceId,
    weekday: shape.weekday,
    start_minutes: shape.startMinutes,
    duration_minutes: shape.durationMinutes,
  };
}

/**
 * The enact audit record (plan §5), parsed by {@link PracticeEnactRecordSchema}.
 * `result_fingerprint` is null: the wrapper RPC fills it from the writer's
 * return (3b PR 11b). `declined` is ALL of Δ at enact time (decision 10),
 * not only S's.
 *
 * @param {Object} args
 * @param {string} args.enactKey - the run id
 * @param {string} args.seasonSettingsId
 * @param {any} args.adapted - `buildPracticeRepairInput()` of the fresh read
 * @param {any} args.state - the re-based state the recommendation was judged on
 * @param {ReturnType<typeof judgeEnact>} args.judged
 * @param {ReturnType<typeof retirementCommitOf>} args.commit
 * @param {ReturnType<typeof buildEnactPayload>} args.enactment
 * @param {{ rows: Array<{ assignment_id: string, assigned_via: string, effect: string,
 *   range_after: string | null }>, published_practices_affected: number, accepted: boolean }} args.prompt -
 *   the override prompt as it was shown and answered
 */
export function buildEnactRecord({
  enactKey,
  seasonSettingsId,
  adapted,
  state,
  judged,
  commit,
  enactment,
  prompt,
}) {
  if (enactment.payload === null) {
    throw new Error(`enact: a refused enact (${enactment.refusal}) has no record`);
  }
  const promptIds = prompt.rows.map((row) => row.assignment_id).sort();
  const requiredIds = enactment.plan.unlockRequired.map((row) => row.assignment_id).sort();
  if (canonical(promptIds) !== canonical(requiredIds)) {
    throw new Error('enact: the prompt shown does not list the rows the write unlocks');
  }
  const recommendation = judged.fresh;
  const { cause, snapshot, slots, baseFingerprint } = adapted.context;
  const row = snapshot.find((r) => r.id === recommendation.assignmentId);
  const loss = adapted.input.loss;
  const fresh = repairPracticeLoss(state.input);
  const local = state.chains.length > 0;
  const overlaps = [...new Set(recommendation.coachOverlaps.map((o) => o.coach))].sort();
  return PracticeEnactRecordSchema.parse({
    schema_version: 1,
    enact_key: enactKey,
    run_id: enactKey,
    season_settings_id: seasonSettingsId,
    cause: {
      kind: cause.kind,
      id: cause.causeId,
      loss: {
        from: loss.from,
        until: null,
        surface_ids: [...loss.surfaceIds],
        start_minutes: null,
        end_minutes: null,
        reason: loss.reason,
      },
      stored_effective_to: commit.stored,
    },
    series: {
      assignment_id: recommendation.assignmentId,
      team_id: recommendation.teamId,
      from: shapeRecord({
        ...recommendation.from,
        durationMinutes: slots.get(row.slotId).durationMinutes,
      }),
      window: { from: recommendation.effectiveFrom, until: recommendation.effectiveUntil },
    },
    decision: {
      kind: recommendation.to === null ? 'time_tbd' : 'rehome',
      to: recommendation.to === null ? null : shapeRecord(recommendation.to),
      tier: recommendation.tier,
      origin: recommendation.origin,
      tbd_reason: recommendation.reason,
      objective: {
        total: recommendation.objective.total,
        counts: { ...recommendation.objective.counts },
      },
      coach_overlaps: overlaps,
      coach_days_worsened: recommendation.coachDaysWorsened,
    },
    rejudge: { stands: judged.stands, shown_counts: { ...judged.shown.objective.counts } },
    declined: state.declined.map((pair) => ({
      assignment_id: pair.assignmentId,
      to: shapeRecord(pair.to),
    })),
    chains: state.chains.map((chain) => ({
      kind: chain.kind,
      assignment_id: chain.assignmentId,
      hops: chain.hops.length,
      stopped_by: chain.stoppedBy,
    })),
    local,
    enacted_before: [...state.enacted],
    prompt,
    unlock: enactment.unlock,
    writes: {
      closes: enactment.payload.repair.closes,
      new_rows: enactment.payload.assignmentRows
        .filter((r) => r.assigned_via === 'recommendation')
        .map((r) => ({
          team_id: r.team_id,
          practice_slot_id: r.practice_slot_id,
          effective_date_range: r.effective_date_range,
        })),
      exceptions: enactment.payload.repair.exceptions.length,
    },
    base_fingerprint: baseFingerprint,
    result_fingerprint: null,
    fingerprint_covers: PRACTICE_ENACT_FINGERPRINT_COVERS,
    solver: {
      strategy: fresh.stats.strategy,
      proven_optimal:
        fresh.stats.provenOptimal && fresh.recommendationSearch.provenOptimal && !local,
      daylight_supplied: adapted.declared.daylight.supplied,
      closures_supplied: adapted.declared.closures.blackoutsSupplied,
    },
  });
}
