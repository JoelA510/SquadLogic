/**
 * `practice-persistence`: the responses for a call that carries `repair`
 * (8.6 3b PR 11b, docs/PHASE_8_6_PR11_ENACT_PLAN.md §4), and the enact body's
 * cross-field refusals. Pure, so vitest runs it directly
 * (`tests/practiceEnactEdge.test.js`); the Edge imports it.
 *
 * **Only for repair calls.** An ordinary save (no `repair` body) keeps
 * today's 500 for every error, so its responses do not change (witness 21).
 */

export interface RepairErrorResponse {
  status: number;
  body: { status: string; message: string; code?: string };
}

/**
 * Plan §4's mapping. The RPC's message is always kept.
 *
 * | SQLSTATE             | HTTP                                       |
 * |----------------------|--------------------------------------------|
 * | 40001                | 409 `stale`, `PRACTICE_SCHEDULE_STALE`     |
 * | 22023 + "is locked"  | 409 `PRACTICE_ASSIGNMENT_LOCKED`           |
 * | 42501                | 403                                        |
 * | other 22023          | 422                                        |
 * | anything else        | 500, as for an ordinary save               |
 */
export function repairErrorResponse(error: unknown): RepairErrorResponse {
  const code = (error as { code?: unknown } | null)?.code;
  const message = (error as Error | null)?.message || 'Failed to persist practice snapshot.';
  if (code === '40001') {
    return { status: 409, body: { status: 'stale', code: 'PRACTICE_SCHEDULE_STALE', message } };
  }
  if (code === '22023' && message.includes('is locked')) {
    return { status: 409, body: { status: 'error', code: 'PRACTICE_ASSIGNMENT_LOCKED', message } };
  }
  if (code === '42501') return { status: 403, body: { status: 'error', message } };
  if (code === '22023') return { status: 422, body: { status: 'error', message } };
  return { status: 500, body: { status: 'error', message } };
}

interface EnactBody {
  enact?: {
    enact_key: string;
    season_settings_id: string;
    base_fingerprint: string;
    result_fingerprint: string | null;
  };
  repair?: { baseFingerprint?: string; withdrawExceptions: unknown[] };
  runMetadata?: Record<string, unknown>;
}

/**
 * Why an `enact` body cannot be sent, or null. Each is a 400: the request is
 * malformed, and the wrapper RPC would refuse it too (it re-checks every one).
 */
export function enactBodyRefusal(body: EnactBody): string | null {
  const { enact, repair, runMetadata } = body;
  if (!enact) return null;
  if (!repair) return 'an enact needs its repair body';
  if (!repair.baseFingerprint) {
    return 'an enact is never blind: repair.baseFingerprint is required';
  }
  if (repair.baseFingerprint !== enact.base_fingerprint) {
    return 'enact.base_fingerprint must equal repair.baseFingerprint';
  }
  if (repair.withdrawExceptions.length > 0) {
    return 'an enact withdraws no exceptions';
  }
  if (runMetadata?.runId !== enact.enact_key) {
    return 'runMetadata.runId must be the enact key';
  }
  if (runMetadata?.seasonSettingsId !== enact.season_settings_id) {
    return 'runMetadata.seasonSettingsId must be the enact record season';
  }
  if (enact.result_fingerprint !== null) {
    return 'enact.result_fingerprint is filled by the database, never sent';
  }
  return null;
}
