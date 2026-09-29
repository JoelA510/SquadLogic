/**
 * Enacting ONE practice repair recommendation, the client half (8.6 3b PR 11c;
 * `docs/PHASE_8_6_PR11_ENACT_PLAN.md` §1, §2, §4). Retirements only (operator
 * answer Q1); blackout enact is 3b PR 11d.
 *
 * The chain is core's, reused and never restated (`practice/enact.js`,
 * `practice/recommendations.js`, `practice/repairAdapter.js`):
 *
 * 1. **Fresh read, fingerprint first** (`loadPracticeRepairSnapshot`).
 * 2. **The commit gate on the fresh rows** (`retirementCommitOf`, Q3): the
 *    field's STORED `effective_to` decides, never the `loss` prop.
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
  PRACTICE_ENACT_REFUSAL,
  PRACTICE_REPAIR_CAUSE_KIND,
  buildEnactPayload,
  buildEnactRecord,
  buildPracticeRepairPayload,
  judgeEnact,
  rebaseRecommendationState,
  retirementCommitOf,
} from '@squadlogic/core/practice/index.js';
import {
  practiceOccurrenceDates,
  practiceRangeBounds,
} from '@squadlogic/core/utils/practiceOccurrences.js';
import { canonicalJson } from '@squadlogic/core/scenario/inputs.js';
import { loadPracticeRepairSnapshot } from '../hooks/usePracticeRepairSnapshot.js';
import { openPracticeRepair } from './practiceRepairPanel.js';

/** Why an Enact button is disabled. */
export const ENACT_GATE = Object.freeze({
  NOT_ADMIN: 'not-admin',
  BLACKOUT: 'blackout',
  PREVIEW: 'preview',
  RETIREMENT_CHANGED: 'retirement-changed',
  REFUSED: 'refused',
});

/** The preview's visible reason (plan §1, "The commit gate"). */
export const ENACT_PREVIEW_TEXT =
  'Save the retirement first: enacting moves practices, and the retirement date is not saved yet.';

/** Plain words for every refusal the enact chain can return. */
export const ENACT_REFUSAL_TEXT = Object.freeze({
  [PRACTICE_ENACT_REFUSAL.RETIREMENT_UNCOMMITTED]: ENACT_PREVIEW_TEXT,
  [PRACTICE_ENACT_REFUSAL.RETIREMENT_CHANGED]:
    'The retirement is now saved with a different date. Close this panel and open it again from the field card.',
  [PRACTICE_ENACT_REFUSAL.BLACKOUT_NOT_ENACTABLE]:
    'Enacting a blackout recommendation is not available yet.',
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
  if (loss?.kind !== PRACTICE_REPAIR_CAUSE_KIND.RETIREMENT) {
    // Q1: the refusal the panel already computes is the reason.
    const why = refusals.map((r) => r.text).join('; ');
    return off(
      ENACT_GATE.BLACKOUT,
      `Enacting a blackout recommendation is not available yet${why ? `: ${why}` : ''}.`
    );
  }
  // Q3: never from the dry-run preview, and never before the date is stored.
  if (preview) return off(ENACT_GATE.PREVIEW, ENACT_PREVIEW_TEXT);
  const commit = retirementCommitOf(rows, loss);
  if (!commit.committed) {
    return commit.refusal === PRACTICE_ENACT_REFUSAL.RETIREMENT_CHANGED
      ? off(ENACT_GATE.RETIREMENT_CHANGED, ENACT_REFUSAL_TEXT[commit.refusal])
      : off(ENACT_GATE.PREVIEW, ENACT_PREVIEW_TEXT);
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
 * The one-entry write plan the prompt describes, from the adapter's own
 * builder (the entry `buildEnactPayload` builds). Used to SHOW the prompt
 * before Confirm; at Confirm the prompt is rebuilt from the enact's own plan
 * and must be equal (see {@link enactPracticeRecommendation}).
 *
 * @param {any} adapted @param {any} recommendation
 */
export function enactPlanOf(adapted, recommendation) {
  const entry = { assignmentId: recommendation.assignmentId, window: null };
  return buildPracticeRepairPayload(
    adapted,
    {
      representation: 'split',
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
 * The count is the weekday occurrences of each row in `[D, until]`, from the
 * core occurrence expander the feed uses.
 *
 * @param {any} adapted - the adapter output the plan was built from
 * @param {Record<string, any[]>} rows - the same read's rows (`assigned_via`, slot days)
 * @param {{ unlockRequired: Array<{ assignment_id: string, why: string }>,
 *   closes: Array<{ assignment_id: string, last_day: string }> }} plan
 */
export function enactPromptOf(adapted, rows, plan) {
  const lossDate = adapted.input.loss.from;
  const lower = (v) => String(v).toLowerCase();
  const rowById = new Map(adapted.context.snapshot.map((r) => [r.id, r]));
  const readById = new Map((rows.practiceAssignments ?? []).map((r) => [lower(r.id), r]));
  const dayBySlot = new Map((rows.practiceSlots ?? []).map((s) => [lower(s.id), s.day_of_week]));
  let affected = 0;
  const promptRows = plan.unlockRequired.map((required) => {
    const row = rowById.get(required.assignment_id);
    const read = readById.get(required.assignment_id);
    const assignedVia = read?.assigned_via ?? null;
    if (!row || typeof assignedVia !== 'string') {
      throw new Error(`enact prompt: ${required.assignment_id} was not read with its assigned_via`);
    }
    const close = plan.closes.find((c) => c.assignment_id === required.assignment_id) ?? null;
    const from = row.range.from > lossDate ? row.range.from : lossDate;
    affected += practiceOccurrenceDates({
      range: `[${from},${row.range.until}]`,
      dayOfWeek: dayBySlot.get(row.slotId),
    }).dates.length;
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
  const commit = retirementCommitOf(fresh.rows, loss);
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
    if (after.ok !== true) {
      return {
        status: 'enacted-unread',
        message: 'message' in after ? after.message : 'unreadable',
        written,
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
      view: { rows: after.rows, opened, state: next },
    };
  } catch (err) {
    return { status: 'error', message: err?.message ?? String(err), sent };
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
 * @param {Record<string, any[]>} rows
 * @param {Array<{ assignmentId: string, teamId: string, written: any }>} log
 * @param {{ team: (id: string) => string }} names
 */
export function enactedRowsOf(rows, log, names) {
  const lower = (v) => String(v).toLowerCase();
  const bounds = (range) => JSON.stringify(practiceRangeBounds(range));
  const assignments = rows.practiceAssignments ?? [];
  return log.map(({ assignmentId, teamId, written }) => {
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
      missing: missing.length,
    };
  });
}
