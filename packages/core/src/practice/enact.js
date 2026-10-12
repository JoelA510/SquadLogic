/**
 * Enacting ONE practice repair recommendation, the core half (8.6 3b PR 11a;
 * `docs/PHASE_8_6_PR11_ENACT_PLAN.md` §1 steps 3a, 6, 7 and 8, §2, §5).
 *
 * Pure: no DB, no clock, no randomness. The caller (3b PR 11c) reads the
 * season fresh, adapts it (`buildPracticeRepairInput`), re-bases the session
 * state onto it (`practice/recommendations.js`), and then asks this module,
 * in order:
 *
 * 1. {@link causeCommitOf}: is the cause COMMITTED? For a retirement
 *    ({@link retirementCommitOf}, operator answer Q3): enact only once
 *    `fields.effective_to` is stored, and equal to the loss's date. For a
 *    blackout (3b PR 11d, Q5): only a stored `field_blackouts` row, equal to
 *    the loss in scope, dates, minutes and reason. Each reads the FRESH row,
 *    never the `loss` prop, which a preview builds from its unsaved draft.
 * 2. {@link judgeEnact}: does the one recommendation still stand, exactly as
 *    it was shown? Its series is still displaced and not enacted, its `to` is
 *    still one of its candidates, not declined, within the change budget
 *    left, and its marginal against every other recommendation is not null;
 *    and the fresh recommendation equals the shown one field for field
 *    (`to`, `tier`, `origin`, `reason` and `objective.counts`, as the plan
 *    names, and also the price, the coach overlaps and the series' window,
 *    which reach the write and the record). Anything else is STALE and
 *    nothing is sent (the approved-option precedent,
 *    `resolve/stages.js:1011-1034`).
 * 3. {@link buildEnactPayload}: the write for that one entry only, built by
 *    the adapter's own builder from the FRESH recommendation, never from
 *    `result.rehomed` (a tier-2 move sits in `timeTbd`, `repair.js:108-113`,
 *    and is written as the move). The new row is
 *    `assigned_via = 'recommendation'`. `unlock` comes only from the prompt's
 *    accepted answer, with a GENERATED reason: ids and a date, no free text
 *    (Q4). A blackout (3b PR 11d) is one exception on S's row over the fresh
 *    recommendation's window, with no unlock, and still needs the prompt's
 *    tick.
 * 4. {@link buildEnactRecord}: the `practice.recommendation_enacted` audit
 *    metadata, validated by the strict {@link PracticeEnactRecordSchema}: one
 *    arm per cause kind (3b PR 11d-2), each held key for key against its Edge
 *    twin by `tests/practiceEnactSchemaDrift.test.js`. A blackout record's
 *    prompt rows are the ONE exception the write adds, and its `cause.stored`
 *    is the row the gate read.
 *
 * Every refusal is a `payload: null` with a named `refusal`: the caller sends
 * nothing. A refusal is never a partial write.
 *
 * **Wired** by 3b PR 11c: its production caller is
 * `frontend/src/utils/practiceRepairEnact.js`, behind the panel's Enact
 * button (`tests/unwiredLayerImporters.test.js` pins that).
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
import { canonicalJson } from '../scenario/inputs.js';
import { PRACTICE_REASON } from './reasonCodes.js';
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
  /** The fresh read holds no stored blackout of the loss's id (a draft): 3b PR 11d, Q5. */
  BLACKOUT_UNCOMMITTED: 'blackout-uncommitted',
  /** The stored blackout's scope, dates, minutes or reason differ from the loss's. */
  BLACKOUT_CHANGED: 'blackout-changed',
  /**
   * A blackout write unlocks nothing, but moves published practices of a
   * locked series: the prompt's tick is still required (3b PR 11d, Q4).
   */
  PROMPT_NOT_ACCEPTED: 'prompt-not-accepted',
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
  /** The shown shape would take the change budget past what is left of it. */
  OVER_BUDGET: 'over-budget',
  /** The series has declined the shown shape (it is in Δ). */
  DECLINED: 'declined',
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
    // The retirement arm of `causeCommitOf`: a blackout has its own gate.
    throw new TypeError(
      `enact: retirementCommitOf judges a retirement, not ${JSON.stringify(loss?.kind)}; use causeCommitOf`
    );
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

/** A blackout's scope, dates, minutes and reason, in `field_blackouts`' own columns. */
function blackoutRecordOf(row) {
  const lower = (value) => (value == null ? null : id(value));
  return {
    field_id: lower(row.field_id),
    location_id: lower(row.location_id),
    blackout_from: row.blackout_from ?? null,
    blackout_until: row.blackout_until ?? null,
    start_minutes: row.start_minutes ?? null,
    end_minutes: row.end_minutes ?? null,
    reason: row.reason ?? null,
  };
}

/**
 * The blackout commit gate (3b PR 11d, plan §2.6, Q5), on FRESH rows: enact
 * only a SAVED blackout, and only as it is saved. It reads the fresh
 * `field_closures` row (`source = 'field_blackouts'`, the loss's id), never
 * the `loss` prop, which the editor builds from its unsaved draft (id
 * `'draft'`). The view names the scope `closes_field_id` /
 * `closes_location_id`; it is mapped back to the table's columns.
 *
 * @param {{ fieldClosures?: Array<Record<string, any>> }} freshRows
 * @param {{ kind: string, blackout?: Record<string, any> }} loss
 * @returns {{ committed: boolean, refusal: string | null, causeId: string | null,
 *   stored: ReturnType<typeof blackoutRecordOf> | null, claimed: ReturnType<typeof blackoutRecordOf> }}
 */
function blackoutCommitOf(freshRows, loss) {
  const claimed = blackoutRecordOf(loss?.blackout ?? {});
  const causeId = loss?.blackout?.id == null ? null : id(loss.blackout.id);
  const row =
    causeId === null || causeId === 'draft'
      ? null
      : ((freshRows?.fieldClosures ?? []).find(
          (closure) => closure.source === 'field_blackouts' && id(closure.id) === causeId
        ) ?? null);
  if (row === null) {
    return {
      committed: false,
      refusal: PRACTICE_ENACT_REFUSAL.BLACKOUT_UNCOMMITTED,
      causeId,
      stored: null,
      claimed,
    };
  }
  const stored = blackoutRecordOf({
    ...row,
    field_id: row.closes_field_id,
    location_id: row.closes_location_id,
  });
  if (canonicalJson(stored) !== canonicalJson(claimed)) {
    return {
      committed: false,
      refusal: PRACTICE_ENACT_REFUSAL.BLACKOUT_CHANGED,
      causeId,
      stored,
      claimed,
    };
  }
  return { committed: true, refusal: null, causeId, stored, claimed };
}

/**
 * The commit gate for the loss's own kind (3b PR 11d): one gate per kind.
 * A retirement is {@link retirementCommitOf}, unchanged; a blackout is the
 * blackout gate above.
 *
 * @param {Record<string, any>} freshRows
 * @param {{ kind: string, field?: any, blackout?: any }} loss
 */
export function causeCommitOf(freshRows, loss) {
  if (loss?.kind === PRACTICE_REPAIR_CAUSE_KIND.RETIREMENT) {
    return retirementCommitOf(freshRows, loss);
  }
  if (loss?.kind === PRACTICE_REPAIR_CAUSE_KIND.BLACKOUT) return blackoutCommitOf(freshRows, loss);
  throw new TypeError(`enact: unknown loss kind ${JSON.stringify(loss?.kind)}`);
}

/** Whether a blackout gate's STORED row is exactly the adapted loss (scope, dates, minutes, reason). */
function storedIsLoss(stored, cause) {
  const { loss, scope } = cause;
  return (
    stored !== null &&
    stored.field_id === scope.fieldId &&
    stored.location_id === scope.locationId &&
    stored.blackout_from === loss.from &&
    stored.blackout_until === loss.until &&
    stored.start_minutes === (loss.startMinutes ?? null) &&
    stored.end_minutes === (loss.endMinutes ?? null) &&
    stored.reason === loss.reason
  );
}

/**
 * Re-judge ONE recommendation against a re-based state (plan §1, step 6).
 *
 * @param {{ input: any, recommendations: any[], enacted: string[], declined: any[] }} rebased -
 *   the session state re-based onto the fresh input
 * @param {string} assignmentId - S
 * @param {Object} shown - S's recommendation exactly as the admin was shown it
 * @returns {{ stands: boolean, why: string | null, assignmentId: string,
 *   differences: string[], shown: any, fresh: any, basis: any }}
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
      // The fresh read this was judged on: the payload must be built from the same one.
      basis: rebased.input.plan,
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
    const declinedKey = `${assignmentId}@${shapeKey(shown.to)}`;
    if (rebased.declined.some((d) => `${d.assignmentId}@${shapeKey(d.to)}` === declinedKey)) {
      return verdict(PRACTICE_ENACT_STALE.DECLINED, fresh);
    }
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
    if (
      context.budget !== null &&
      rest.timeChanges + context.timeChangeOf(candidate) > context.budget
    ) {
      return verdict(PRACTICE_ENACT_STALE.OVER_BUDGET, fresh);
    }
    if (context.marginal(series, candidate, rest.placed, rest.coachDays) === null) {
      return verdict(PRACTICE_ENACT_STALE.CLASHES, fresh);
    }
  }

  // Everything the admin was shown, field by field: the shape, its tier and
  // origin, the reason, the price and its counts, the coach overlaps, and the
  // series' own shape and window (plan §1 step 6 names `to`, `tier`, `origin`
  // and the counts; the rest reaches the write or the record too).
  const differences = [...new Set([...Object.keys(shown), ...Object.keys(fresh)])]
    .filter((key) => canonicalJson(shown[key]) !== canonicalJson(fresh[key]))
    .sort();
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
 * @param {{ committed: boolean, refusal: string | null, fieldId?: string | null,
 *   causeId?: string | null, stored: any, claimed: any } | null | undefined} commit - the
 *   gate (`causeCommitOf`) on the same fresh read
 */
export function buildEnactPayload(adapted, judged, answer, commit) {
  const refuse = (refusal, extra = {}) =>
    Object.freeze({ refusal, payload: null, plan: null, refused: [], unlock: [], ...extra });
  const { cause, baseFingerprint } = adapted.context;
  const blackout = cause.kind === PRACTICE_REPAIR_CAUSE_KIND.BLACKOUT;
  const lossDate = adapted.input.loss.from;
  if (blackout) {
    if (!commit?.committed) {
      return refuse(commit?.refusal ?? PRACTICE_ENACT_REFUSAL.BLACKOUT_UNCOMMITTED);
    }
    // The gate must have judged THIS loss: its row, stored exactly as adapted.
    if (commit.causeId !== cause.causeId || !storedIsLoss(commit.stored, cause)) {
      return refuse(PRACTICE_ENACT_REFUSAL.BLACKOUT_CHANGED);
    }
  } else {
    if (!commit?.committed) {
      return refuse(commit?.refusal ?? PRACTICE_ENACT_REFUSAL.RETIREMENT_UNCOMMITTED);
    }
    // The gate must have judged THIS loss: its field, and D-1 stored.
    if (commit.fieldId !== cause.causeId || commit.stored !== shiftDate(lossDate, -1)) {
      return refuse(PRACTICE_ENACT_REFUSAL.RETIREMENT_CHANGED);
    }
  }
  if (judged.basis !== adapted.input.plan) {
    throw new Error('enact: the recommendation was judged on another read than the one adapted');
  }
  if (!judged.stands) return refuse(PRACTICE_ENACT_REFUSAL.STALE);
  if (typeof baseFingerprint !== 'string' || baseFingerprint === '') {
    return refuse(PRACTICE_ENACT_REFUSAL.NO_BASE_FINGERPRINT);
  }

  // Built from the FRESH recommendation, so a tier-2 move is written as the move.
  const recommendation = judged.fresh;
  // A blackout never splits: one exception on S's row over the FRESH
  // recommendation's own window (S ∩ the loss), never the loss's.
  if (blackout && !recommendation.window) {
    throw new Error(
      `enact: the blackout recommendation for ${recommendation.assignmentId} has no window`
    );
  }
  const entry = {
    assignmentId: recommendation.assignmentId,
    window: blackout ? { ...recommendation.window } : null,
  };
  const built = buildPracticeRepairPayload(
    adapted,
    {
      representation: blackout ? 'override' : 'split',
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
  if (blackout) {
    // An exception on a locked row re-ranges nothing: no unlock is sent, and
    // sending one would audit a lock break that never happened (Q4).
    if (unlockRequired.length > 0) {
      throw new Error(`enact: a blackout write for ${s} asks to unlock a row`);
    }
    if (!accepted) return refuse(PRACTICE_ENACT_REFUSAL.PROMPT_NOT_ACCEPTED, { plan: built.plan });
    return Object.freeze({
      refusal: null,
      plan: built.plan,
      refused: [],
      unlock: [],
      payload: {
        assignmentRows: built.payload.assignmentRows,
        repair: { ...built.payload.repair, unlock: [] },
      },
    });
  }
  if (unlockRequired.length > 0 && !accepted) {
    return refuse(PRACTICE_ENACT_REFUSAL.UNLOCK_NOT_ACCEPTED, { plan: built.plan });
  }
  let unlock = [];
  if (accepted && unlockRequired.length > 0) {
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
/** `field_blackouts.reason`'s CHECK (`20260906000100`): the enum, never the note. */
const BlackoutReason = z.enum(['maintenance', 'weather', 'event', 'permit', 'closed', 'other']);
/** Minutes are both or neither, and ordered when present (`field_blackouts`' own CHECKs). */
const MINUTES_PAIRED = {
  message: 'start_minutes and end_minutes are both set, with end after start, or both null',
};
/** @param {any} value - `{ start_minutes, end_minutes }` */
const minutesPaired = (value) =>
  value.start_minutes === null
    ? value.end_minutes === null
    : value.end_minutes !== null && value.end_minutes > value.start_minutes;
/** Exactly one scope column is set (`field_blackouts_scope_check`). */
const ONE_SCOPE = { message: 'exactly one of field_id and location_id is set' };
/** @param {any} value - `{ field_id, location_id }` */
const oneScope = (value) => (value.field_id === null) !== (value.location_id === null);

/** The keys both arms share, unchanged from the retirement-only record (3b PR 11b). */
const RECORD_COMMON = {
  schema_version: z.literal(1),
  enact_key: Uuid,
  run_id: Uuid,
  season_settings_id: Uuid,
  series: z.strictObject({
    assignment_id: Uuid,
    team_id: Uuid,
    from: Shape,
    window: z.strictObject({ from: IsoDate, until: IsoDate }),
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
  base_fingerprint: Fingerprint,
  result_fingerprint: Fingerprint.nullable(),
  fingerprint_covers: z.literal(PRACTICE_ENACT_FINGERPRINT_COVERS),
  solver: z.strictObject({
    strategy: z.enum(['exact', 'greedy']),
    proven_optimal: z.boolean(),
    daylight_supplied: z.boolean(),
    closures_supplied: z.boolean(),
  }),
};

/** The decision, by its kind's enum: `rehome` is retirement-only, `relocate` blackout-only. */
const decisionOf = (kinds) =>
  z.strictObject({
    kind: z.enum(kinds),
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
  });

/** A retirement enact (3b PR 11b): S closed or replaced, under a generated unlock. */
const RetirementEnactRecordSchema = z.strictObject({
  ...RECORD_COMMON,
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
  decision: decisionOf(['rehome', 'time_tbd']),
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
});

/**
 * A blackout enact (3b PR 11d-2, plan §2.3): ONE exception on S over its
 * window, S's range kept, nothing unlocked, closed or created. `cause.stored`
 * is the `field_blackouts` row as the wrapper's gate read it; `cause.loss`
 * may carry minutes (Q1).
 */
const BlackoutEnactRecordSchema = z.strictObject({
  ...RECORD_COMMON,
  cause: z.strictObject({
    kind: z.literal(PRACTICE_REPAIR_CAUSE_KIND.BLACKOUT),
    id: Uuid,
    loss: z
      .strictObject({
        from: IsoDate,
        until: IsoDate,
        surface_ids: z.array(Uuid).min(1),
        start_minutes: Minutes.nullable(),
        end_minutes: Minutes.nullable(),
        reason: BlackoutReason,
      })
      .refine(minutesPaired, MINUTES_PAIRED),
    stored: z
      .strictObject({
        field_id: Uuid.nullable(),
        location_id: Uuid.nullable(),
        blackout_from: IsoDate,
        blackout_until: IsoDate,
        start_minutes: Minutes.nullable(),
        end_minutes: Minutes.nullable(),
        reason: BlackoutReason,
      })
      .refine(minutesPaired, MINUTES_PAIRED)
      .refine(oneScope, ONE_SCOPE),
  }),
  decision: decisionOf(['relocate', 'time_tbd']),
  prompt: z.strictObject({
    rows: z
      .array(
        z.strictObject({
          assignment_id: Uuid,
          assigned_via: z.enum(['auto', 'manual', 'repair', 'recommendation', 'override']),
          effect: z.enum(['temporarily moved', 'temporarily TIME TBD']),
          range_after: z.null(),
          window: Range,
        })
      )
      .length(1),
    published_practices_affected: z.number().int().nonnegative(),
    accepted: z.literal(true),
  }),
  unlock: z.array(z.never()),
  writes: z.strictObject({
    closes: z.array(z.never()),
    new_rows: z.array(z.never()),
    exceptions: z.literal(1),
  }),
});

/**
 * The `practice.recommendation_enacted` metadata (plan §5), strict: ids,
 * enums, dates and numbers only; the one free-text field is the generated
 * unlock reason. One arm per `cause.kind` (3b PR 11d-2), with the same
 * top-level keys, so the wrapper's key-set check is unchanged. The Edge
 * holds a strict twin (3b PR 11b), held key for key by
 * `tests/practiceEnactSchemaDrift.test.js`.
 */
export const PracticeEnactRecordSchema = z.union([
  RetirementEnactRecordSchema,
  BlackoutEnactRecordSchema,
]);

/** The prompt row's effect for a blackout exception's kind. */
const BLACKOUT_EFFECT = Object.freeze({
  relocated: 'temporarily moved',
  time_tbd: 'temporarily TIME TBD',
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
 * @param {{ committed: boolean, refusal: string | null, stored: any, causeId?: string | null }} args.commit -
 *   the gate (`causeCommitOf`) the payload passed
 * @param {ReturnType<typeof buildEnactPayload>} args.enactment
 * @param {{ rows: Array<{ assignment_id: string, assigned_via: string, effect: string,
 *   range_after: string | null, window?: string }>, published_practices_affected: number,
 *   accepted: boolean }} args.prompt - the override prompt as it was shown and answered (a
 *   blackout's rows carry the exception's `window`)
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
  const { cause, snapshot, slots, baseFingerprint } = adapted.context;
  const blackout = cause.kind === PRACTICE_REPAIR_CAUSE_KIND.BLACKOUT;
  if (blackout) {
    // A blackout unlocks nothing (Q4): the prompt lists the ONE exception
    // the write adds, over its own window, with its effect.
    const shown = prompt.rows.map((row) => ({
      assignment_id: row.assignment_id,
      window: row.window,
      effect: row.effect,
    }));
    const written = enactment.plan.exceptions.map((exception) => ({
      assignment_id: exception.assignment_id,
      window: exception.window,
      effect: BLACKOUT_EFFECT[exception.kind],
    }));
    if (canonicalJson(shown) !== canonicalJson(written)) {
      throw new Error('enact: the prompt shown does not list the exception the write adds');
    }
    // The record carries the row the gate READ; it must be this loss's.
    if (commit?.causeId !== cause.causeId || !storedIsLoss(commit?.stored ?? null, cause)) {
      throw new Error('enact: the blackout record needs the gate that judged this loss');
    }
  } else {
    const promptIds = prompt.rows.map((row) => row.assignment_id).sort();
    const requiredIds = enactment.plan.unlockRequired.map((row) => row.assignment_id).sort();
    if (canonicalJson(promptIds) !== canonicalJson(requiredIds)) {
      throw new Error('enact: the prompt shown does not list the rows the write unlocks');
    }
  }
  const recommendation = judged.fresh;
  const row = snapshot.find((r) => r.id === recommendation.assignmentId);
  const loss = adapted.input.loss;
  const fresh = repairPracticeLoss(state.input);
  // Locally repaired: any chain, or a reopen, stamped the state LOCAL.
  const local =
    state.chains.length > 0 ||
    state.findings.some((f) => f.code === PRACTICE_REASON.REPAIR_RECOMMENDATION_LOCAL);
  // Proven optimal only when the session's recommendations ARE the fresh
  // repair's own, and it proved them: a carried placement is not.
  const provenOptimal =
    fresh.stats.provenOptimal &&
    fresh.recommendationSearch.provenOptimal &&
    !local &&
    canonicalJson(state.recommendations) === canonicalJson(fresh.recommendations);
  const overlaps = [...new Set(recommendation.coachOverlaps.map((o) => o.coach))].sort();
  return PracticeEnactRecordSchema.parse({
    schema_version: 1,
    enact_key: enactKey,
    run_id: enactKey,
    season_settings_id: seasonSettingsId,
    cause: blackout
      ? {
          kind: cause.kind,
          id: cause.causeId,
          loss: {
            from: loss.from,
            until: loss.until,
            surface_ids: [...loss.surfaceIds],
            start_minutes: loss.startMinutes ?? null,
            end_minutes: loss.endMinutes ?? null,
            reason: loss.reason,
          },
          stored: { ...commit.stored },
        }
      : {
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
      kind: recommendation.to === null ? 'time_tbd' : blackout ? 'relocate' : 'rehome',
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
      proven_optimal: provenOptimal,
      daylight_supplied: adapted.declared.daylight.supplied,
      closures_supplied: adapted.declared.closures.blackoutsSupplied,
    },
  });
}
