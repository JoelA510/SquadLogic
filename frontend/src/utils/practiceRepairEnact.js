/**
 * Enacting ONE practice repair recommendation, the client half (8.6 3b PR 11c;
 * `docs/PHASE_8_6_PR11_ENACT_PLAN.md` §1, §2, §4). A blackout enact is 3b PR
 * 11d-3 (`docs/PHASE_8_6_PR11D_BLACKOUT_ENACT_PLAN.md` §2.5-§2.7): one
 * temporary exception on the series, its range kept, nothing unlocked.
 *
 * The chain is core's, reused and never restated (`practice/enact.js`,
 * `practice/recommendations.js`, `practice/repairAdapter.js`):
 *
 * 1. **Fresh read, fingerprint first** (`loadPracticeRepairSnapshot`).
 * 2. **The commit gate on the fresh rows** (`causeCommitOf`, Q3 and 11d Q5):
 *    the field's STORED `effective_to`, or the STORED blackout row, decides,
 *    never the `loss` prop.
 * 3. Adapt, **re-base** the session state (`rebaseRecommendationState`) and
 *    **re-judge** the one recommendation against what the admin was shown
 *    (`judgeEnact`). Stale: nothing is sent.
 * 4. **Plan the one-entry write** (`buildEnactPayload`), and check that the
 *    override prompt it needs is the one the admin answered. A refusal, or a
 *    different prompt: nothing is sent.
 * 5. **Send once** (`persistPracticeEnact`). A 409 stale is shown after a
 *    fresh re-judge; the write is NEVER retried here. A second write needs a
 *    second click and a new enact key.
 * 6. **Read again and re-base** with the enacted series, which releases
 *    whatever is now inadmissible (the chain rule, in core).
 *
 * @module utils/practiceRepairEnact
 */

import {
  PRACTICE_ENACT_BLACKOUT_EFFECT,
  PRACTICE_ENACT_REFUSAL,
  PRACTICE_REPAIR_CAUSE_KIND,
  buildEnactPayload,
  buildEnactRecord,
  buildPracticeRepairPayload,
  causeCommitOf,
  judgeEnact,
  rebaseRecommendationState,
} from '@squadlogic/core/practice/index.js';
import { practiceRangeBounds } from '@squadlogic/core/utils/practiceOccurrences.js';
import { applyPracticeExceptions } from '@squadlogic/core/utils/practiceExceptions.js';
import { canonicalJson } from '@squadlogic/core/scenario/inputs.js';
import { loadPracticeRepairSnapshot } from '../hooks/usePracticeRepairSnapshot.js';
import { openPracticeRepair } from './practiceRepairPanel.js';
import { PERSISTENCE_INVALID_PAYLOAD } from '../lib/persistenceRequest.js';

/** Why an Enact button is disabled. */
export const ENACT_GATE = Object.freeze({
  NOT_ADMIN: 'not-admin',
  PREVIEW: 'preview',
  RETIREMENT_CHANGED: 'retirement-changed',
  BLACKOUT_CHANGED: 'blackout-changed',
  REFUSED: 'refused',
  /** A saved temporary move on the lost ground (11d Q8): never enactable here. */
  CANNOT_REPAIR: 'cannot-repair',
});

/** The preview's visible reason (plan §1, "The commit gate"). */
export const ENACT_PREVIEW_TEXT =
  'Save the retirement first: enacting moves practices, and the retirement date is not saved yet.';

/**
 * The blackout editor's visible reason: its launcher is always a preview
 * (11d Q5), whether the dialog adds a blackout or edits a saved one, so it
 * names where a saved blackout IS enacted.
 */
export const ENACT_BLACKOUT_PREVIEW_TEXT =
  'Save the blackout first, then enact from its row on Blackout Dates: enacting moves practices, and this editor shows an unsaved draft.';

/** A blackout the fresh read does not hold as saved (11d Q5, the plan's wording). */
export const ENACT_BLACKOUT_UNSAVED_TEXT =
  'Save the blackout first: enacting moves practices, and this blackout is not saved yet.';

/** Why a saved temporary move on the lost ground has no Enact (11d Q8). */
export const ENACT_TARGET_LOST_TEXT =
  'Cannot be repaired here: its temporary move lands on the closed ground; withdrawing a saved change is not available yet.';

/** Plain words for every refusal the enact chain can return. */
export const ENACT_REFUSAL_TEXT = Object.freeze({
  [PRACTICE_ENACT_REFUSAL.RETIREMENT_UNCOMMITTED]: ENACT_PREVIEW_TEXT,
  [PRACTICE_ENACT_REFUSAL.RETIREMENT_CHANGED]:
    'The retirement is now saved with a different date. Close this panel and open it again from the field card.',
  [PRACTICE_ENACT_REFUSAL.BLACKOUT_UNCOMMITTED]: ENACT_BLACKOUT_UNSAVED_TEXT,
  [PRACTICE_ENACT_REFUSAL.BLACKOUT_CHANGED]:
    'The blackout is now saved differently. Close this panel and open it again from the saved blackout.',
  [PRACTICE_ENACT_REFUSAL.PROMPT_NOT_ACCEPTED]:
    'The change was not confirmed, so nothing was sent.',
  [PRACTICE_ENACT_REFUSAL.STALE]: 'The season changed since this was shown.',
  [PRACTICE_ENACT_REFUSAL.PAYLOAD_REFUSED]: 'This practice cannot be saved as recommended.',
  [PRACTICE_ENACT_REFUSAL.UNLOCK_NOT_ACCEPTED]:
    'The override was not accepted, so nothing was sent.',
  [PRACTICE_ENACT_REFUSAL.NO_BASE_FINGERPRINT]:
    'The schedule fingerprint could not be read, and an enact is never blind.',
});

/**
 * Whether one row's Enact button is enabled, and the visible reason when not.
 * Checked on the rows the panel opened with; the fresh read (step 2) and the
 * wrapper RPC check the commit gate again, so this is not the only gate.
 *
 * @param {{ isAdmin: boolean, preview: boolean, rows: Record<string, any[]>, loss: any,
 *   refusals: Array<{ why: string, text: string }> }} args
 * @returns {{ enabled: boolean, why: string | null, text: string | null }}
 */
export function enactGateOf({ isAdmin, preview, rows, loss, refusals }) {
  const off = (why, text) => ({ enabled: false, why, text });
  if (!isAdmin) return off(ENACT_GATE.NOT_ADMIN, 'Only an organization admin can enact.');
  const blackout = loss?.kind === PRACTICE_REPAIR_CAUSE_KIND.BLACKOUT;
  // Q3, and 11d Q5: never from a dry-run preview (the retirement dialog, the
  // blackout editor's draft), and never before the cause is stored as shown.
  if (preview) {
    return off(ENACT_GATE.PREVIEW, blackout ? ENACT_BLACKOUT_PREVIEW_TEXT : ENACT_PREVIEW_TEXT);
  }
  const commit = causeCommitOf(rows, loss);
  if (!commit.committed) {
    if (commit.refusal === PRACTICE_ENACT_REFUSAL.RETIREMENT_CHANGED) {
      return off(ENACT_GATE.RETIREMENT_CHANGED, ENACT_REFUSAL_TEXT[commit.refusal]);
    }
    if (commit.refusal === PRACTICE_ENACT_REFUSAL.BLACKOUT_CHANGED) {
      return off(ENACT_GATE.BLACKOUT_CHANGED, ENACT_REFUSAL_TEXT[commit.refusal]);
    }
    return off(ENACT_GATE.PREVIEW, blackout ? ENACT_BLACKOUT_UNSAVED_TEXT : ENACT_PREVIEW_TEXT);
  }
  if (refusals.length > 0) {
    return off(
      ENACT_GATE.REFUSED,
      `It cannot be saved: ${refusals.map((r) => r.text).join('; ')}.`
    );
  }
  return { enabled: true, why: null, text: null };
}

/**
 * The cause as the rows STORE it, by the commit gate's own read
 * (`causeCommitOf`): what the dialog's heading names (11d plan §2.5: built
 * from the stored row, never the draft).
 *
 * @param {Record<string, any[]>} rows @param {any} loss
 */
export function storedCauseOf(rows, loss) {
  return causeCommitOf(rows, loss);
}

/**
 * The one-entry write plan the prompt describes, from the adapter's own
 * builder (the entry `buildEnactPayload` builds). Used to SHOW the prompt
 * before Confirm; at Confirm the prompt is rebuilt from the enact's own plan
 * and must be equal (see {@link enactPracticeRecommendation}).
 *
 * @param {any} adapted @param {any} recommendation
 */
export function enactPlanOf(adapted, recommendation) {
  // As `buildEnactPayload` builds it: a blackout is one exception on S over
  // the recommendation's own window, never a split.
  const blackout = adapted.context.cause.kind === PRACTICE_REPAIR_CAUSE_KIND.BLACKOUT;
  if (blackout && !recommendation.window) {
    throw new Error(
      `enact prompt: the blackout recommendation for ${recommendation.assignmentId} has no window`
    );
  }
  const entry = {
    assignmentId: recommendation.assignmentId,
    window: blackout ? { ...recommendation.window } : null,
  };
  return buildPracticeRepairPayload(
    adapted,
    {
      representation: blackout ? 'override' : 'split',
      lossDate: adapted.input.loss.from,
      rehomed: recommendation.to === null ? [] : [{ ...entry, to: recommendation.to }],
      timeTbd: recommendation.to === null ? [{ ...entry, reason: recommendation.reason }] : [],
    },
    { assignedVia: 'recommendation' }
  ).plan;
}

/**
 * The ruling-2 override prompt for one enact (plan §2): every row the write
 * re-ranges or replaces, what happens to it, and how many published
 * practices could change. `record` is exactly what the audit stores
 * (`prompt` of `PracticeEnactRecordSchema`, less `accepted`).
 *
 * The count is each row's **published** practices in `[D, until]`: its series
 * dates with the saved exceptions applied by `applyPracticeExceptions`, the
 * function the portal and the feed run (8.6 3b PR 12c, plan R8, W17). A date
 * the helper already shows as TIME TBD or relocated is not a published
 * practice the enact could change, so it is not counted; neither is a date an
 * open or unreadable window suppresses.
 *
 * A blackout (3b PR 11d-3) unlocks nothing: its prompt lists the one
 * exception the write adds, and counts inside that exception's own window
 * (`blackoutPromptOf`). `relocation` is shown, never recorded.
 *
 * @param {any} adapted - the adapter output the plan was built from
 * @param {Record<string, any[]>} rows - the same read's rows (`assigned_via`, slot days,
 *   `practiceExceptions`)
 * @param {{ unlockRequired: Array<{ assignment_id: string, why: string }>,
 *   closes: Array<{ assignment_id: string, last_day: string }> }} plan
 */
export function enactPromptOf(adapted, rows, plan) {
  const lossDate = adapted.input.loss.from;
  const lower = (v) => String(v).toLowerCase();
  const rowById = new Map(adapted.context.snapshot.map((r) => [r.id, r]));
  const readById = new Map((rows.practiceAssignments ?? []).map((r) => [lower(r.id), r]));
  const dayBySlot = new Map((rows.practiceSlots ?? []).map((s) => [lower(s.id), s.day_of_week]));
  // The snapshot always reads the table; a rows object without it was not
  // read by `loadPracticeRepairSnapshot`, and counting it as "no exceptions"
  // would be the silent over-count W17 exists to stop.
  if (!Array.isArray(rows.practiceExceptions)) {
    throw new Error('enact prompt: the practice exceptions were not read');
  }
  const exceptionsByRow = new Map();
  for (const e of rows.practiceExceptions) {
    const id = lower(e?.assignment_id);
    exceptionsByRow.set(id, [...(exceptionsByRow.get(id) ?? []), e]);
  }
  /** A snapshot row and its read `assigned_via`, or a throw: never a guessed row. */
  const readRow = (assignmentId) => {
    const row = rowById.get(assignmentId);
    const assignedVia = readById.get(assignmentId)?.assigned_via ?? null;
    if (!row || typeof assignedVia !== 'string') {
      throw new Error(`enact prompt: ${assignmentId} was not read with its assigned_via`);
    }
    return { row, assignedVia };
  };
  /** The row's dates as the readers show them, its saved exceptions (and `planned`) applied. */
  const occurrencesOf = (assignmentId, row, planned = []) =>
    applyPracticeExceptions({
      rows: [
        {
          id: assignmentId,
          effective_date_range: `[${row.range.from},${row.range.until}]`,
          slot: { day_of_week: dayBySlot.get(row.slotId) },
        },
      ],
      exceptions: [...(exceptionsByRow.get(assignmentId) ?? []), ...planned].map((e) => ({
        ...e,
        assignment_id: assignmentId,
      })),
    }).occurrences;

  if (adapted.context.cause.kind === PRACTICE_REPAIR_CAUSE_KIND.BLACKOUT) {
    return blackoutPromptOf(plan, { readRow, occurrencesOf, dayBySlot, lossDate });
  }

  let affected = 0;
  const promptRows = plan.unlockRequired.map((required) => {
    const { row, assignedVia } = readRow(required.assignment_id);
    const close = plan.closes.find((c) => c.assignment_id === required.assignment_id) ?? null;
    const from = row.range.from > lossDate ? row.range.from : lossDate;
    affected += occurrencesOf(required.assignment_id, row).filter(
      (o) => o.kind === 'series' && o.date >= from
    ).length;
    return {
      assignment_id: required.assignment_id,
      assigned_via: assignedVia,
      effect: close ? 'closed' : 'removed and replaced',
      range_after: close ? `[${row.range.from},${close.last_day}]` : null,
    };
  });
  return {
    lossDate,
    record: { rows: promptRows, published_practices_affected: affected },
    relocation: null,
  };
}

/** The id the prompt gives the exception it plans, so its own dates can be told apart. */
const PLANNED_EXCEPTION_ID = 'planned-by-this-enact';

/**
 * The blackout arm of {@link enactPromptOf} (11d plan §2.5, §2.7, Q4): the
 * prompt lists the ONE exception the write adds, not the rows it unlocks (it
 * unlocks none). The count is S's **published** practices inside the
 * exception's own window, `[w.from, w.until]`, never the retirement's
 * `[D, until]`: its series dates with the saved exceptions applied, by the
 * helper the readers run. With `LIVE_EXCEPTION_OVERLAP` refusing, no date in
 * the window is already changed; the helper still runs (it defends the case
 * and is not claimed as coverage). For a relocation, `relocation` also says
 * how many practices the readers will show on the new weekday in the window
 * (G1, Q6), from the same helper with the planned exception applied.
 */
function blackoutPromptOf(plan, { readRow, occurrencesOf, dayBySlot, lossDate }) {
  if (plan.unlockRequired.length > 0) {
    throw new Error('enact prompt: a blackout write asks to unlock a row');
  }
  if (plan.exceptions.length !== 1) {
    throw new Error(
      `enact prompt: a blackout write adds ${plan.exceptions.length} exceptions, not 1`
    );
  }
  const [exception] = plan.exceptions;
  // Core's own map: `buildEnactRecord` checks the prompt rows against it.
  const effect = PRACTICE_ENACT_BLACKOUT_EFFECT[exception.kind];
  const bounds = practiceRangeBounds(exception.window);
  if (!effect || bounds === null) {
    throw new Error(`enact prompt: the planned exception ${exception.window} does not read`);
  }
  const { row, assignedVia } = readRow(exception.assignment_id);
  const inWindow = (o) => o.date >= bounds.first && o.date <= bounds.last;
  const affected = occurrencesOf(exception.assignment_id, row).filter(
    (o) => o.kind === 'series' && inWindow(o)
  ).length;
  let relocation = null;
  if (exception.kind === 'relocated') {
    const toDay = dayBySlot.get(String(exception.practice_slot_id).toLowerCase());
    const moved = occurrencesOf(exception.assignment_id, row, [
      {
        id: PLANNED_EXCEPTION_ID,
        window: exception.window,
        kind: 'relocated',
        practice_slot_id: exception.practice_slot_id,
        slot: { day_of_week: toDay },
        withdrawn_at: null,
      },
    ]).filter((o) => o.kind === 'relocated' && o.exceptionId === PLANNED_EXCEPTION_ID);
    relocation = {
      from: { weekday: dayBySlot.get(row.slotId) ?? null, count: affected },
      to: { weekday: toDay ?? null, count: moved.length },
    };
  }
  return {
    lossDate,
    record: {
      rows: [
        {
          assignment_id: exception.assignment_id,
          assigned_via: assignedVia,
          effect,
          range_after: null,
          window: exception.window,
        },
      ],
      published_practices_affected: affected,
    },
    relocation,
  };
}

/** A fresh, lowercase v4 uuid: one per confirmed intent. */
export function mintEnactKey() {
  return globalThis.crypto.randomUUID().toLowerCase();
}

/**
 * The fresh read, the gate, the re-base and the re-judge (steps 1-3). Sends
 * nothing.
 */
async function judgeOnFreshRead({
  client,
  organizationId,
  seasonSettingsId,
  loss,
  timeZone,
  state,
  shown,
}) {
  const fresh = await loadPracticeRepairSnapshot(client, { organizationId, seasonSettingsId });
  if (fresh.ok !== true) {
    return { ok: false, message: 'message' in fresh ? fresh.message : 'unreadable' };
  }
  const commit = causeCommitOf(fresh.rows, loss);
  const opened = openPracticeRepair(fresh.rows, loss, {
    timeZone,
    baseFingerprint: fresh.fingerprint,
  });
  const rebased = rebaseRecommendationState(state, opened.adapted.input);
  const judged = judgeEnact(rebased, shown.assignmentId, shown);
  return {
    ok: true,
    rows: fresh.rows,
    commit,
    opened,
    rebased,
    judged,
    view: { rows: fresh.rows, opened, state: rebased },
  };
}

/**
 * Enact one recommendation (plan §1 steps 2-12). Resolves to one outcome,
 * never throws:
 *
 * - `{ status: 'enacted', result, view, written }`: written; `view` is the
 *   fresh read after it, with the state re-based and the series enacted, and
 *   `written` the record's `writes` (what the panel then finds on the read).
 * - `{ status: 'enacted-unread', message, written }`: written, but the read
 *   after it failed; the panel cannot show the season and must be reopened.
 * - `{ status: 'stale', why, differences, stillStands, fresh, view }`: the
 *   fresh re-judge differs from what was shown, or the writer refused the
 *   base (`why: 'writer-stale'`). Nothing (more) was sent.
 * - `{ status: 'refused', refusal, view }`: a gate refused; nothing was sent.
 * - `{ status: 'error', message, sent }`: `sent` says whether the write
 *   went out (its outcome is then UNKNOWN), or nothing was sent.
 *
 * @param {Object} args
 * @param {any} args.client - the supabase client (the reads)
 * @param {(body: any) => Promise<any>} args.send - `persistPracticeEnact`
 * @param {string} args.organizationId
 * @param {string} args.seasonSettingsId
 * @param {any} args.loss - `{ kind: 'retirement', field: { id, effective_to } }`
 * @param {string | null} args.timeZone
 * @param {any} args.state - the panel's current recommendation state
 * @param {any} args.shown - the recommendation exactly as the admin was shown it
 * @param {{ record: any }} args.shownPrompt - the prompt the admin answered
 * @param {{ accepted: boolean }} args.answer
 * @param {string} args.enactKey - minted once for this confirmed intent
 */
export async function enactPracticeRecommendation({
  client,
  send,
  organizationId,
  seasonSettingsId,
  loss,
  timeZone,
  state,
  shown,
  shownPrompt,
  answer,
  enactKey,
}) {
  const reading = { client, organizationId, seasonSettingsId, loss, timeZone, shown };
  let sent = false;
  try {
    const j = await judgeOnFreshRead({ ...reading, state });
    if (!j.ok) return { status: 'error', message: j.message, sent };
    if (!j.commit.committed) {
      return { status: 'refused', refusal: j.commit.refusal, view: j.view };
    }
    if (!j.judged.stands) {
      return {
        status: 'stale',
        why: j.judged.why,
        differences: j.judged.differences,
        stillStands: false,
        fresh: j.judged.fresh,
        view: j.view,
      };
    }
    const { adapted } = j.opened;
    const enactment = buildEnactPayload(
      adapted,
      j.judged,
      { accepted: answer?.accepted === true, enactKey },
      j.commit
    );
    if (enactment.payload === null) {
      return { status: 'refused', refusal: enactment.refusal, view: j.view };
    }
    const prompt = enactPromptOf(adapted, j.rows, enactment.plan);
    if (canonicalJson(prompt.record) !== canonicalJson(shownPrompt.record)) {
      // The rows the write would unlock are not the ones the admin accepted.
      return {
        status: 'stale',
        why: 'prompt-changed',
        differences: ['prompt'],
        stillStands: false,
        fresh: j.judged.fresh,
        view: j.view,
      };
    }
    const record = buildEnactRecord({
      enactKey,
      seasonSettingsId,
      adapted,
      state: j.rebased,
      judged: j.judged,
      commit: j.commit,
      enactment,
      prompt: { ...prompt.record, accepted: true },
    });

    sent = true;
    const result = await send({
      payload: enactment.payload,
      enact: record,
      runMetadata: { runId: enactKey, seasonSettingsId },
    });

    if (result?.status === 'stale') {
      // Re-judge for the prompt; NEVER re-send. A second write is a second click.
      const again = await judgeOnFreshRead({ ...reading, state });
      if (!again.ok) return { status: 'stale', why: 'writer-stale', unread: again.message };
      return {
        status: 'stale',
        why: 'writer-stale',
        differences: again.judged.differences,
        stillStands: again.commit.committed && again.judged.stands,
        fresh: again.judged.fresh,
        view: again.view,
      };
    }

    // After success: read fresh again and re-base with S enacted (step 12).
    const after = await loadPracticeRepairSnapshot(client, { organizationId, seasonSettingsId });
    const written = record.writes;
    // The record's own cause, as written: the panel finds a blackout's exception by it.
    const cause = { kind: record.cause.kind, id: record.cause.id };
    if (after.ok !== true) {
      return {
        status: 'enacted-unread',
        message: 'message' in after ? after.message : 'unreadable',
        written,
        cause,
      };
    }
    const opened = openPracticeRepair(after.rows, loss, {
      timeZone,
      baseFingerprint: after.fingerprint,
    });
    const next = rebaseRecommendationState(j.rebased, opened.adapted.input, {
      enacted: [shown.assignmentId],
    });
    return {
      status: 'enacted',
      result,
      written,
      cause,
      view: { rows: after.rows, opened, state: next },
    };
  } catch (err) {
    // A body the client refused before the network call (plan M4.4) was never
    // sent, whatever `sent` says: its outcome is known, nothing was written.
    const refusedUnsent = err?.code === PERSISTENCE_INVALID_PAYLOAD;
    return { status: 'error', message: err?.message ?? String(err), sent: sent && !refusedUnsent };
  }
}

/**
 * The practices enacted this session, found on the FRESH rows: each enact's
 * team (from the recommendation it enacted, so a series whose row was
 * replaced is still named), its original row's range now (null when the row
 * was replaced), and the rows the fresh read holds that match the enact's
 * own `writes.new_rows` by team, slot and range bounds (a stored daterange is
 * canonicalised, so the bounds are compared, not the text). A row the enact
 * wrote that the read does not hold is `missing`: shown, never hidden.
 *
 * A blackout enact (3b PR 11d-3) writes no row: its `temporary` is the live
 * exception the read holds on S with this blackout as its cause (`null` for
 * a retirement), and one the record says it wrote that the read does not
 * hold is `missing` too.
 *
 * @param {Record<string, any[]>} rows
 * @param {Array<{ assignmentId: string, teamId: string, written: any,
 *   cause?: { kind: string, id: string } }>} log
 * @param {{ team: (id: string) => string }} names
 */
export function enactedRowsOf(rows, log, names) {
  const lower = (v) => String(v).toLowerCase();
  const bounds = (range) => JSON.stringify(practiceRangeBounds(range));
  const assignments = rows.practiceAssignments ?? [];
  return log.map(({ assignmentId, teamId, written, cause = null }) => {
    if (cause?.kind === PRACTICE_REPAIR_CAUSE_KIND.BLACKOUT) {
      const temporary = (rows.practiceExceptions ?? [])
        .filter(
          (e) =>
            lower(e.assignment_id) === assignmentId &&
            e.withdrawn_at == null &&
            e.cause_kind === cause.kind &&
            lower(e.cause_id) === lower(cause.id)
        )
        .map((e) => ({
          id: lower(e.id),
          window: e.window,
          kind: e.kind,
          slotId: e.practice_slot_id == null ? null : lower(e.practice_slot_id),
        }));
      return {
        assignmentId,
        team: names.team(teamId),
        closedRange: null,
        timeTbd: false,
        locked: [],
        temporary,
        missing: Math.max(0, written.exceptions - temporary.length),
      };
    }
    const original = assignments.find((a) => lower(a.id) === assignmentId) ?? null;
    const found = [];
    const missing = [];
    for (const row of written.new_rows) {
      const match = assignments.find(
        (a) =>
          lower(a.team_id) === lower(row.team_id) &&
          lower(a.practice_slot_id) === lower(row.practice_slot_id) &&
          a.assigned_via === 'recommendation' &&
          bounds(a.effective_date_range) === bounds(row.effective_date_range)
      );
      if (match) {
        found.push({
          id: lower(match.id),
          slotId: lower(match.practice_slot_id),
          range: match.effective_date_range,
        });
      } else missing.push(row);
    }
    return {
      assignmentId,
      team: names.team(teamId),
      closedRange: original?.effective_date_range ?? null,
      timeTbd: written.new_rows.length === 0,
      locked: found,
      temporary: null,
      missing: missing.length,
    };
  });
}
