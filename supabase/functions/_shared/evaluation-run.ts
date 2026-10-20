/**
 * The one way an Edge Function writes an evaluation run: `persist_evaluation_run`, as the
 * caller, with an idempotency key, retried once when the first answer cannot say whether the
 * run committed (migration 20261020010000, plan
 * docs/changes/2026-10-20-evaluation-run-idempotency.md).
 *
 * **As the caller.** The RPC refuses anyone who is not a member of the run's organization by
 * `auth.uid()`, and the service-role client has none (#621). Taking a {@link UserClient}, which
 * only `createUserClient` makes, keeps a service-role client from being passed here.
 *
 * **Retried once, with the same key.** A transport failure (supabase-js resolves it with
 * `status: 0`) or a gateway 502/503/504 can arrive after PostgREST ran the call, so the run may
 * or may not exist. The key makes the retry safe: if the first call committed, the RPC returns
 * that run's id and writes nothing more. Any other error (a refusal, a bad payload, a 500 from
 * the function itself) is the answer and is returned as it came. A second failure is returned
 * too; the caller throws it.
 */
import type { UserClient } from './auth.ts';

export interface EvaluationRunPayload {
  p_run_data: Record<string, unknown>;
  p_findings: unknown[];
  p_metrics: unknown[];
}

/** Statuses after which the first call may have committed. */
export const RETRYABLE_PERSIST_STATUSES: ReadonlySet<number> = new Set([0, 502, 503, 504]);

export async function persistEvaluationRun(
  client: UserClient,
  payload: EvaluationRunPayload,
  idempotencyKey: string = crypto.randomUUID()
) {
  const args = {
    ...payload,
    p_run_data: { ...payload.p_run_data, idempotency_key: idempotencyKey },
  };
  const first = await client.rpc('persist_evaluation_run', args);
  if (!first.error || !RETRYABLE_PERSIST_STATUSES.has(first.status)) return first;
  return await client.rpc('persist_evaluation_run', args);
}
