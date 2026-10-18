/**
 * Shared authentication and authorization utilities for Edge Functions.
 * Phase 1 Security Remediation (C-1): Ensures every Edge Function validates
 * organization membership before performing data operations.
 */

import {
  createClient as _createClient,
  type SupabaseClient,
  type User,
} from 'https://esm.sh/@supabase/supabase-js@2.45.3';
import { type FailureContext, logFailure } from './logtail.ts';

/**
 * Extract and validate user from the Authorization header.
 * Uses the service-role client ONLY for auth.getUser() — never for data queries.
 */
export async function getUserFromRequest(
  request: Request,
  serviceClient: SupabaseClient
): Promise<User | null> {
  const authHeader = request.headers.get('authorization') ?? '';
  const token = authHeader.toLowerCase().startsWith('bearer ')
    ? authHeader.slice('bearer '.length)
    : null;

  if (!token) {
    return null;
  }

  const { data, error } = await serviceClient.auth.getUser(token);

  if (error) {
    console.error('Failed to retrieve user from access token', error.message ?? error);
    return null;
  }

  return data?.user ?? null;
}

declare const userScoped: unique symbol;

/**
 * A Supabase client that acts AS the caller: made only by
 * {@link createUserClient}, from the request's own `Authorization` header.
 *
 * The brand exists so the audit helpers below cannot be handed the
 * service-role client. They once were, at every call site: `record_audit_event`
 * inserts `user_id = auth.uid()`, which is NULL under the service role, so
 * every Edge Function audit write failed on `audit_log.user_id NOT NULL` and was
 * only console-logged. A plain `SupabaseClient` does not satisfy this type, so
 * that mistake is now a `deno check` error rather than a silent gap in the
 * audit trail.
 */
export type UserClient = SupabaseClient & { readonly [userScoped]: true };

/**
 * A client that acts AS the caller: the anon (publishable) key plus the
 * request's own `Authorization` header, so PostgREST runs as `authenticated`,
 * `auth.uid()` is the caller, RLS applies, and `record_audit_event` can
 * attribute what it records.
 *
 * Use it for any write whose authorisation must be the database's, not only
 * this function's. The service-role client bypasses every RLS policy and every
 * `service_role` exemption in an RPC, so a write made through it is authorised
 * by nothing but the Edge Function's own checks -- which no test executes.
 * (#64: `persist_practice_schedule` deletes a season's superseded practices.)
 *
 * `SUPABASE_ANON_KEY` is injected into every Edge Function by the platform
 * (docs/operations/ENVIRONMENT.md).
 *
 * Returns a {@link UserClient}: the same client, typed so that only this
 * factory can produce one.
 */
export function createUserClient(
  request: Request,
  supabaseUrl: string,
  anonKey: string
): UserClient {
  return _createClient(supabaseUrl, anonKey, {
    global: { fetch, headers: { Authorization: request.headers.get('Authorization') ?? '' } },
    auth: { persistSession: false },
  }) as UserClient;
}

/**
 * Verify that a user is a member of a specific organization.
 * Uses the service-role client to bypass RLS on organization_members
 * (since we're checking membership itself, not accessing org data).
 */
export async function verifyOrgMembership(
  serviceClient: SupabaseClient,
  userId: string,
  organizationId: string
): Promise<boolean> {
  const { data, error } = await serviceClient
    .from('organization_members')
    .select('profile_id')
    .eq('profile_id', userId)
    .eq('organization_id', organizationId)
    .maybeSingle();

  if (error) {
    console.error('Org membership check failed:', error.message);
    return false;
  }

  return data !== null;
}

/**
 * Verify that a user can administer a specific organization.
 * Uses the service-role client to avoid recursive RLS while checking the
 * organization_members table itself.
 */
export async function verifyOrgAdmin(
  serviceClient: SupabaseClient,
  userId: string,
  organizationId: string
): Promise<boolean> {
  const { data, error } = await serviceClient
    .from('organization_members')
    .select('profile_id')
    .eq('profile_id', userId)
    .eq('organization_id', organizationId)
    .in('role', ['admin', 'tenant_admin'])
    .maybeSingle();

  if (error) {
    console.error('Org admin check failed:', error.message);
    return false;
  }

  return data !== null;
}

/**
 * Get all organization IDs a user belongs to.
 */
export async function getUserOrgIds(
  serviceClient: SupabaseClient,
  userId: string
): Promise<string[]> {
  const { data, error } = await serviceClient
    .from('organization_members')
    .select('organization_id')
    .eq('profile_id', userId);

  if (error) {
    console.error('Failed to fetch user org memberships:', error.message);
    return [];
  }

  return (data ?? []).map((row: { organization_id: string }) => row.organization_id);
}

/**
 * For persistence endpoints: resolve ALL distinct organization_ids for the given teams.
 * Returns every unique org_id so the caller can verify membership against each one.
 * This prevents IDOR when a crafted payload references teams from different orgs.
 */
export async function resolveOrgIdsFromTeamIds(
  serviceClient: SupabaseClient,
  teamIds: string[]
): Promise<string[]> {
  if (teamIds.length === 0) return [];

  const { data, error } = await serviceClient
    .from('teams')
    .select('organization_id')
    .in('id', teamIds);

  if (error || !data) {
    console.error('Failed to resolve orgs from team IDs:', error?.message);
    return [];
  }

  return [...new Set(data.map((row: { organization_id: string }) => row.organization_id))];
}

/**
 * The longest error text an audit row may carry. `audit_log` is append-only and
 * kept for 180 days, so what a failure writes there is minimised (owner
 * decision, 2026-10-14): the error's own message, bounded, and nothing from
 * the request.
 */
export const AUDIT_ERROR_MAX_CHARS = 200;

/** `error`'s message, cut to {@link AUDIT_ERROR_MAX_CHARS}, for an audit row's metadata. */
export function auditErrorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length <= AUDIT_ERROR_MAX_CHARS
    ? text
    : `${text.slice(0, AUDIT_ERROR_MAX_CHARS - 1)}\u2026`;
}

export interface AuditParams {
  organizationId: string;
  action: string;
  resourceType?: string;
  resourceId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * The audit write, **awaitable**, made AS THE CALLER.
 *
 * `userClient` must be the caller's client ({@link createUserClient}), never
 * the service role: `record_audit_event` attributes the row to `auth.uid()`
 * and checks the caller is a member of `organizationId`, so the actor is the
 * JWT's subject and cannot be supplied, or forged, by this function.
 *
 * `recordAudit` below returns `void`, so `await recordAudit(...)` is a no-op
 * that reads exactly like a wait. That is harmless where the handler keeps
 * working for seconds afterwards and the insert lands anyway, and it is not
 * harmless immediately before a `return`: on the Supabase edge runtime the
 * isolate can be frozen once the response is sent, so the row is lost. A
 * handler refusing a request is precisely the case CLAUDE.md's audit
 * immutability rule most wants recorded, so the refusal paths await this.
 *
 * Never rejects: an audit failure must not turn into a 500 (owner decision,
 * 2026-10-14: these writes follow work that has already happened). A failure
 * is reported through `logFailure` with the handler's own `failure` context,
 * so it reaches BetterStack with the function, request and organization, not
 * only the console (docs/PLAN_AUDIT_IN_TRANSACTION.md section 3.3). The
 * context is required, so no call site can leave a failure unreported.
 */
export async function recordAuditNow(
  userClient: UserClient,
  failure: FailureContext,
  params: AuditParams
): Promise<void> {
  const what = `Audit write failed: ${params.action}`;
  try {
    const { error } = await userClient.rpc('record_audit_event', {
      p_organization_id: params.organizationId,
      p_action: params.action,
      p_resource_type: params.resourceType ?? null,
      p_resource_id: params.resourceId ?? null,
      p_metadata: params.metadata ?? {},
    });
    if (error) await logFailure(failure, what, error);
  } catch (err) {
    await logFailure(failure, what, err);
  }
}

/**
 * Fire-and-forget audit log entry via the record_audit_event RPC (Phase 4, 4.6),
 * made as the caller (see {@link recordAuditNow}). Failures are logged but
 * never block the response to the client.
 *
 * Returns `void` deliberately and historically. Use {@link recordAuditNow}
 * anywhere the handler is about to return.
 */
export function recordAudit(
  userClient: UserClient,
  failure: FailureContext,
  params: AuditParams
): void {
  void recordAuditNow(userClient, failure, params);
}

/**
 * The SQLSTATE `persist_team_schedule` and `persist_game_schedule` raise when
 * their own audit row could not be written (20261018060000). The RPC has
 * rolled the whole save back by then, so the outcome is known: nothing was
 * saved. A custom class nothing else raises, so it cannot be mistaken for
 * another refusal.
 */
export const AUDIT_WRITE_FAILED_SQLSTATE = 'SLA01';

/** What the caller is told when a save was rolled back for its audit row. */
export const AUDIT_WRITE_FAILED_MESSAGE =
  'Nothing was saved: the audit record could not be written. Try again; if it keeps failing, report it.';

/** Whether an RPC error is a save rolled back because its audit row failed. */
export function isAuditWriteFailure(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === AUDIT_WRITE_FAILED_SQLSTATE
  );
}

/**
 * The 500 for a save whose audit row could not be written, logged through
 * `logFailure` first (plan section 3.2). `save` names it in the log: "Team
 * save", "Game save".
 */
export async function auditWriteFailedResponse(
  failure: FailureContext,
  save: string,
  error: unknown
): Promise<Response> {
  await logFailure(failure, `${save} rolled back: its audit row could not be written`, error);
  return jsonResponse(
    { status: 'error', code: 'AUDIT_WRITE_FAILED', message: AUDIT_WRITE_FAILED_MESSAGE },
    500
  );
}

/**
 * Standard CORS headers for Edge Functions.
 *
 * Access-Control-Allow-Methods is listed explicitly because some browsers
 * abort the main request after a successful preflight if the method isn't
 * in the allow-list, even though POST is technically CORS-safelisted — the
 * guarantee only holds when no preflight fires, and our JSON Content-Type
 * always triggers one.
 */
export const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
};

/**
 * JSON response helper.
 */
export function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders,
    },
  });
}
