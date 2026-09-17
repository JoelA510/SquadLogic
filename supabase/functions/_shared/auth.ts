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

export interface AuditParams {
  organizationId: string;
  action: string;
  resourceType?: string;
  resourceId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * The audit write, **awaitable**.
 *
 * `recordAudit` below returns `void`, so `await recordAudit(...)` is a no-op
 * that reads exactly like a wait. That is harmless where the handler keeps
 * working for seconds afterwards and the insert lands anyway, and it is not
 * harmless immediately before a `return`: on the Supabase edge runtime the
 * isolate can be frozen once the response is sent, so the row is lost. A
 * handler refusing a request is precisely the case CLAUDE.md's audit
 * immutability rule most wants recorded, so the refusal paths await this.
 *
 * Never rejects: an audit failure must not turn into a 500.
 */
export async function recordAuditNow(
  serviceClient: SupabaseClient,
  params: AuditParams
): Promise<void> {
  try {
    const { error } = await serviceClient.rpc('record_audit_event', {
      p_organization_id: params.organizationId,
      p_action: params.action,
      p_resource_type: params.resourceType ?? null,
      p_resource_id: params.resourceId ?? null,
      p_metadata: params.metadata ?? {},
    });
    if (error) console.error('Audit log write failed:', error.message);
  } catch (err) {
    console.error('Audit log write failed:', (err as Error).message);
  }
}

/**
 * Fire-and-forget audit log entry via the record_audit_event RPC (Phase 4, 4.6).
 * Failures are logged but never block the response to the client.
 *
 * Returns `void` deliberately and historically. Use {@link recordAuditNow}
 * anywhere the handler is about to return.
 */
export function recordAudit(serviceClient: SupabaseClient, params: AuditParams): void {
  void recordAuditNow(serviceClient, params);
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
