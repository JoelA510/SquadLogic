/**
 * The waiver ledger: build it, query it, and reconcile it against the
 * constraint registry it excepts.
 *
 * `docs/MODEL_GAPS.md` GAP-26 is the "before" this module is the "after" of:
 *
 * > **Today**: no waiver, exception or override record of any kind. There is
 * > nowhere to store the subject (person / team / venue pair), the constraint
 * > being waived, the rationale, who approved it, or its validity window — and
 * > therefore no way to detect that a waiver has gone dormant.
 *
 * A ledger is **immutable**, like a registry. `withoutWaiver()` returns a new
 * ledger rather than mutating, which is what lets dormancy be answered by
 * building the alternative and comparing — the same shape
 * `whatIfConstraintType()` uses in Prompt 2.1, deliberately, because "what
 * would this schedule look like without X?" is one question and should not
 * grow two implementations.
 *
 * Phase 2 is **in-memory only**. There is no SQL home for waiver records and
 * this work deliberately does not create one: the schema belongs to the phase
 * that has real persistence requirements, not to the phase still settling the
 * model.
 *
 * @module waivers/ledger
 */

import { getConstraint } from '../constraints/registry.js';

import {
  WAIVER_REASON,
  createWaiverMeta,
  deriveWaiverStatus,
  makeWaiverFinding,
} from './reasonCodes.js';
import { WaiverLedgerInputSchema } from './schemas.js';
import { waiverDimensions } from './scope.js';

/**
 * Freeze a record and everything hanging off it.
 *
 * @param {import('./types.js').WaiverRecord} record
 * @returns {import('./types.js').WaiverRecord}
 */
function freezeRecord(record) {
  Object.freeze(record.scope);
  if (record.scope.venueIds) Object.freeze(record.scope.venueIds);
  Object.freeze(record.approval);
  Object.freeze(record.parameters);
  Object.freeze(record.reasonCodes);
  return Object.freeze(record);
}

/**
 * Build a ledger from plain records.
 *
 * Two things are checked loudly rather than trusted:
 *
 * - a **duplicate id** is `blocking`, because the loser would vanish silently
 *   and a vanished waiver is incident 9 happening again;
 * - an **empty** ledger is `info`, *not* `blocking`. This is the one place this
 *   module deliberately diverges from `buildConstraintRegistry()`, and the
 *   asymmetry is load bearing: an empty registry makes every "allowed" answer
 *   true for the wrong reason, while an empty ledger makes every "nothing was
 *   waived" answer true for the right one. Most seasons have no waivers, and a
 *   season with none must not look broken. The vacuity that matters here is a
 *   dormancy scan over nothing, and that is `WAIVER_SCAN_VACUOUS`.
 *
 * What is **not** checked here is anything about the constraint being excepted:
 * that needs a registry, the ledger stands alone, and
 * {@link reconcileWaiverLedger} is where the two meet.
 *
 * @param {Object} input - see `WaiverLedgerInputSchema`
 * @returns {import('./types.js').WaiverLedger}
 */
export function buildWaiverLedger(input) {
  const parsed = WaiverLedgerInputSchema.parse(input);
  const meta = createWaiverMeta();
  /** @type {import('./types.js').WaiverFinding[]} */
  const findings = [];

  // Null-prototype, for the same reason `buildConstraintRegistry()` uses one: a
  // waiver whose id is `constructor` must be storable rather than read as a
  // duplicate, and `getWaiver(ledger, 'toString')` must answer `null` rather
  // than a function off `Object.prototype`.
  /** @type {Record<string, import('./types.js').WaiverRecord>} */
  const byId = Object.create(null);
  /** @type {Record<string, string[]>} */
  const idsByConstraint = Object.create(null);

  const waivers = [...parsed.waivers].sort((a, b) => a.id.localeCompare(b.id));

  for (const record of waivers) {
    meta.waiversConsidered += 1;

    if (Object.hasOwn(byId, record.id)) {
      findings.push(
        makeWaiverFinding(
          WAIVER_REASON.WAIVER_ID_DUPLICATE,
          `two waivers claim the id "${record.id}"`,
          { waiverId: record.id, constraintId: record.constraintId }
        )
      );
      continue;
    }

    byId[record.id] = freezeRecord(/** @type {import('./types.js').WaiverRecord} */ (record));
    if (!Object.hasOwn(idsByConstraint, record.constraintId)) {
      idsByConstraint[record.constraintId] = [];
    }
    idsByConstraint[record.constraintId].push(record.id);
  }

  if (waivers.length === 0) {
    findings.push(
      makeWaiverFinding(
        WAIVER_REASON.WAIVER_LEDGER_EMPTY,
        'the waiver ledger holds no waivers; nothing will be excepted and nothing can go dormant',
        { name: parsed.name }
      )
    );
  }

  const kept = Object.values(byId);
  const stats = {
    waiverCount: kept.length,
    constraintCount: Object.keys(idsByConstraint).length,
    expiringCount: kept.filter((record) => record.effectiveTo !== null).length,
    openEndedCount: kept.filter((record) => record.effectiveTo === null).length,
    datedApprovalCount: kept.filter((record) => record.approval.approvedAt !== null).length,
    scopeDimensionCount: kept.reduce((total, record) => total + waiverDimensions(record).length, 0),
    codeNarrowedCount: kept.filter((record) => record.reasonCodes.length > 0).length,
  };

  for (const ids of Object.values(idsByConstraint)) ids.sort();

  /** @type {import('./types.js').WaiverLedger} */
  const ledger = {
    name: parsed.name,
    source: parsed.source,
    waivers: /** @type {import('./types.js').WaiverRecord[]} */ (Object.freeze(kept)),
    waiverIds: /** @type {string[]} */ (Object.freeze(kept.map((record) => record.id))),
    byId: Object.freeze(byId),
    idsByConstraint: Object.freeze(idsByConstraint),
    constraintIds: /** @type {string[]} */ (Object.freeze(Object.keys(idsByConstraint).sort())),
    status: deriveWaiverStatus(findings),
    findings: /** @type {import('./types.js').WaiverFinding[]} */ (Object.freeze(findings)),
    meta,
    stats: Object.freeze(stats),
  };
  return Object.freeze(ledger);
}

/**
 * One waiver by id, or `null`.
 *
 * @param {import('./types.js').WaiverLedger} ledger
 * @param {string} id
 * @returns {import('./types.js').WaiverRecord|null}
 */
export function getWaiver(ledger, id) {
  return ledger.byId[id] ?? null;
}

/**
 * One waiver by id, or a thrown error naming what is actually there.
 *
 * @param {import('./types.js').WaiverLedger} ledger
 * @param {string} id
 * @returns {import('./types.js').WaiverRecord}
 */
export function requireWaiver(ledger, id) {
  const record = getWaiver(ledger, id);
  if (!record) {
    throw new Error(
      `waivers: no waiver "${id}" in the ledger (it holds ${ledger.waiverIds.length}: ${ledger.waiverIds.join(', ')})`
    );
  }
  return record;
}

/**
 * Every waiver excepting one constraint, in id order.
 *
 * @param {import('./types.js').WaiverLedger} ledger
 * @param {string} constraintId
 * @returns {import('./types.js').WaiverRecord[]}
 */
export function waiversForConstraint(ledger, constraintId) {
  return (ledger.idsByConstraint[constraintId] ?? []).map((id) => ledger.byId[id]);
}

/**
 * The same ledger without one waiver.
 *
 * The counterfactual half of dormancy detection. Returns a **new** ledger; the
 * original is untouched, so "would this schedule pass without waiver X?" never
 * risks answering "yes" by having quietly removed it.
 *
 * @param {import('./types.js').WaiverLedger} ledger
 * @param {string} id
 * @returns {import('./types.js').WaiverLedger}
 */
export function withoutWaiver(ledger, id) {
  requireWaiver(ledger, id);
  return buildWaiverLedger({
    name: ledger.name,
    source: ledger.source,
    waivers: ledger.waivers.filter((record) => record.id !== id),
  });
}

/**
 * Check every waiver against the registry it excepts.
 *
 * Three failures, all of them the shape of incident 9 — a waiver that has come
 * loose from the thing it was written about:
 *
 * - the constraint is **not in the registry** (`blocking`). A rename or a
 *   rebuild leaves the record on disk governing nothing at all, which is
 *   exactly how the original waiver was lost;
 * - the constraint says **`waivable: false`** (`blocking`). Permit windows are
 *   not anybody's to sign away (a sunset margin is a compromise since the owner's
 *   decision of 2026-11-02, so there is nothing to waive);
 * - the waiver names **reason codes the constraint does not govern**
 *   (`compromise`). It would cover nothing while looking specific.
 *
 * This runs on demand rather than inside `buildWaiverLedger()` because a ledger
 * is meaningful without a registry — it is a list of decisions somebody made —
 * while this check is only meaningful with one. `applyWaivers()` repeats the
 * two `blocking` checks per subject, because a waiver that must not apply must
 * not apply even when nobody ran the audit.
 *
 * @param {import('./types.js').WaiverLedger} ledger
 * @param {import('../constraints/types.js').ConstraintRegistry} registry
 * The two id lists are **waiver** ids, and are named for it: what is unknown or
 * unwaivable is the constraint each waiver points at, and a list of constraint
 * ids would not tell a caller which waiver to go and look at.
 *
 * @returns {{ findings: import('./types.js').WaiverFinding[], meta: import('./types.js').WaiverMeta, status: string, waiverIdsWithUnknownConstraint: string[], waiverIdsNotWaivable: string[] }}
 */
export function reconcileWaiverLedger(ledger, registry) {
  const meta = createWaiverMeta();
  /** @type {import('./types.js').WaiverFinding[]} */
  const findings = [];
  /** @type {string[]} */
  const waiverIdsWithUnknownConstraint = [];
  /** @type {string[]} */
  const waiverIdsNotWaivable = [];

  for (const record of ledger.waivers) {
    meta.waiversConsidered += 1;
    const constraint = getConstraint(registry, record.constraintId);

    if (!constraint) {
      waiverIdsWithUnknownConstraint.push(record.id);
      findings.push(
        makeWaiverFinding(
          WAIVER_REASON.WAIVER_CONSTRAINT_UNKNOWN,
          `waiver "${record.id}" excepts constraint "${record.constraintId}", which the registry does not hold; the waiver governs nothing`,
          {
            waiverId: record.id,
            constraintId: record.constraintId,
            registryConstraintCount: registry.constraintIds.length,
          }
        )
      );
      continue;
    }

    meta.constraintsLinked += 1;

    if (!constraint.waivable) {
      waiverIdsNotWaivable.push(record.id);
      findings.push(
        makeWaiverFinding(
          WAIVER_REASON.WAIVER_CONSTRAINT_NOT_WAIVABLE,
          `waiver "${record.id}" excepts constraint "${constraint.id}", whose record says it may not be waived`,
          { waiverId: record.id, constraintId: constraint.id, constraintType: constraint.type }
        )
      );
    }

    const unclaimed = record.reasonCodes.filter((code) => !constraint.reasonCodes.includes(code));
    if (unclaimed.length > 0) {
      findings.push(
        makeWaiverFinding(
          WAIVER_REASON.WAIVER_REASON_CODE_UNCLAIMED,
          `waiver "${record.id}" names reason code(s) ${unclaimed.join(', ')} that constraint "${constraint.id}" does not govern, so it would cover nothing`,
          {
            waiverId: record.id,
            constraintId: constraint.id,
            unclaimed: [...unclaimed].sort(),
            governed: [...constraint.reasonCodes].sort(),
          }
        )
      );
    }
  }

  return {
    findings,
    meta,
    status: deriveWaiverStatus(findings),
    waiverIdsWithUnknownConstraint: waiverIdsWithUnknownConstraint.sort(),
    waiverIdsNotWaivable: waiverIdsNotWaivable.sort(),
  };
}
