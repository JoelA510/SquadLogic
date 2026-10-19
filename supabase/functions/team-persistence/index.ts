/**
 * Team Persistence Edge Function
 * Self-contained handler — all logic inlined for Deno Edge runtime compatibility.
 * Security: org membership validation (C-1), rate limiting (M-4), payload validation.
 */
import { serve } from 'https://deno.land/std@0.223.0/http/server.ts';
import { z } from 'https://deno.land/x/zod@v3.22.4/mod.ts';
import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.3';
import {
  getUserFromRequest,
  getUserOrgIds,
  verifyOrgAdmin,
  createUserClient,
  isAuditWriteFailure,
  auditWriteFailedResponse,
  corsHeaders,
  jsonResponse,
} from '../_shared/auth.ts';
import { checkRateLimit, rateLimitExceededResponse } from '../_shared/rateLimit.ts';
import { logFailure, withFailureLogging } from '../_shared/logtail.ts';

// ── Inlined constants & config ──────────────────────────────────────────────
const DEFAULT_ALLOWED_ROLES = ['authenticated', 'service_role', 'admin', 'scheduler'];

function parseAllowedRolesEnv(
  value: string | undefined | null,
  { fallbackRoles = DEFAULT_ALLOWED_ROLES } = {}
): string[] {
  let roles: string[];
  if (value === undefined || value === null) {
    roles = fallbackRoles;
  } else {
    roles = value.split(',');
  }
  const normalized = roles.map((r) => r.trim().toLowerCase()).filter((r) => r.length > 0);
  if (normalized.length === 0) throw new Error('at least one allowed role is required');
  return normalized;
}

// ── Payload schema (Zod) ────────────────────────────────────────────────────
const PersistencePayloadSchema = z.object({
  snapshot: z.object({
    payload: z.object({
      teamRows: z.array(z.object({ id: z.string() }).passthrough()),
      teamPlayerRows: z.array(
        z.object({ team_id: z.string(), player_id: z.string() }).passthrough()
      ),
    }),
    lastRunId: z.string().nullish(),
    runId: z.string().nullish(),
  }),
  overrides: z.array(z.unknown()).optional(),
  runMetadata: z.record(z.unknown()).optional(),
});

// ── Inlined persistence logic ───────────────────────────────────────────────

function evaluateOverrides(overrides: unknown[] = []): { pending: number } {
  return {
    pending: overrides.reduce((count: number, entry: unknown) => {
      if (!entry || typeof entry !== 'object') return count;
      const status =
        (typeof (entry as Record<string, unknown>).status === 'string' &&
          ((entry as Record<string, unknown>).status as string).trim().toLowerCase()) ||
        'pending';
      return status === 'pending' ? count + 1 : count;
    }, 0),
  };
}

interface RunMetadata {
  runId?: string;
  organizationId?: string;
  seasonId?: string;
  seasonSettingsId?: string;
  parameters?: Record<string, unknown>;
  metrics?: Record<string, unknown>;
  results?: Record<string, unknown>;
  startedAt?: string;
  completedAt?: string;
}

async function persistTeamSnapshot(
  supabaseClient: SupabaseClient,
  snapshot: {
    payload: { teamRows: Record<string, unknown>[]; teamPlayerRows: Record<string, unknown>[] };
    lastRunId?: string | null;
    runId?: string | null;
  },
  runMetadata: RunMetadata = {},
  now: Date = new Date()
) {
  const { teamRows, teamPlayerRows } = snapshot.payload;
  const effectiveRunId = runMetadata.runId ?? snapshot.lastRunId ?? snapshot.runId;

  const runData = effectiveRunId
    ? {
        id: effectiveRunId,
        organization_id: runMetadata.organizationId,
        season_id: runMetadata.seasonId ?? runMetadata.seasonSettingsId,
        run_type: 'team',
        season_settings_id: runMetadata.seasonSettingsId,
        status: 'completed',
        parameters: runMetadata.parameters ?? {},
        metrics: runMetadata.metrics ?? {},
        results: runMetadata.results ?? {},
        started_at: runMetadata.startedAt ?? now.toISOString(),
        completed_at: runMetadata.completedAt ?? now.toISOString(),
        updated_at: now.toISOString(),
      }
    : {
        run_type: 'team',
        organization_id: runMetadata.organizationId,
        season_id: runMetadata.seasonId ?? runMetadata.seasonSettingsId,
        status: 'completed',
        updated_at: now.toISOString(),
      };

  const { data, error } = await supabaseClient.rpc('persist_team_schedule', {
    run_data: runData,
    teams: teamRows,
    team_players: teamPlayerRows,
  });

  if (error) throw error;

  return {
    status: 'success',
    runId: effectiveRunId ?? data ?? null,
    message: 'Persistence successful.',
    syncedAt: now.toISOString(),
    updatedTeams: teamRows.length,
    updatedPlayers: teamPlayerRows.length,
  };
}

type PersistencePayload = z.infer<typeof PersistencePayloadSchema>;

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function firstStringValue(record: Record<string, unknown> | undefined, keys: string[]) {
  if (!record) return undefined;
  for (const key of keys) {
    const value = stringValue(record[key]);
    if (value) return value;
  }
  return undefined;
}

function uniqueStrings(values: Array<string | undefined>) {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

async function addOrgIdsFromTable(
  serviceClient: SupabaseClient,
  tableName: string,
  ids: string[],
  candidateOrgIds: Set<string>
) {
  if (ids.length === 0) return undefined;

  const { data, error } = await serviceClient
    .from(tableName)
    .select('organization_id')
    .in('id', ids);

  if (error) {
    console.error(`Failed to resolve organization ids from ${tableName}:`, error.message);
    return 'Unable to verify organization scope for team persistence.';
  }

  for (const row of data ?? []) {
    const orgId = stringValue((row as Record<string, unknown>).organization_id);
    if (orgId) candidateOrgIds.add(orgId);
  }

  return undefined;
}

async function resolveTargetOrgId(
  serviceClient: SupabaseClient,
  body: PersistencePayload
): Promise<{ organizationId?: string; status?: number; message?: string }> {
  const candidateOrgIds = new Set<string>();
  const runMetadata = (body.runMetadata ?? {}) as Record<string, unknown>;
  const metadataOrgId = firstStringValue(runMetadata, ['organizationId', 'organization_id']);
  const seasonSettingsId = firstStringValue(runMetadata, [
    'seasonSettingsId',
    'season_settings_id',
    'seasonId',
    'season_id',
  ]);

  if (metadataOrgId) candidateOrgIds.add(metadataOrgId);

  if (seasonSettingsId) {
    const { data, error } = await serviceClient
      .from('season_settings')
      .select('organization_id')
      .eq('id', seasonSettingsId)
      .maybeSingle();

    if (error) {
      console.error('Failed to resolve season settings organization:', error.message);
      return { status: 500, message: 'Unable to verify season organization.' };
    }

    const seasonOrgId = stringValue((data as Record<string, unknown> | null)?.organization_id);
    if (seasonOrgId) candidateOrgIds.add(seasonOrgId);
  }

  const teamRows = body.snapshot.payload.teamRows as Array<Record<string, unknown>>;
  const teamPlayerRows = body.snapshot.payload.teamPlayerRows as Array<Record<string, unknown>>;

  for (const row of teamRows) {
    const rowOrgId = firstStringValue(row, ['organizationId', 'organization_id']);
    if (rowOrgId) candidateOrgIds.add(rowOrgId);
  }

  const divisionIds = uniqueStrings(
    teamRows.map((row) => firstStringValue(row, ['divisionId', 'division_id']))
  );
  const teamIds = uniqueStrings([
    ...teamRows.map((row) => stringValue(row.id)),
    ...teamPlayerRows.map((row) => firstStringValue(row, ['teamId', 'team_id'])),
  ]);
  const playerIds = uniqueStrings(
    teamPlayerRows.map((row) => firstStringValue(row, ['playerId', 'player_id']))
  );
  const resolutionErrors = await Promise.all([
    addOrgIdsFromTable(serviceClient, 'divisions', divisionIds, candidateOrgIds),
    addOrgIdsFromTable(serviceClient, 'teams', teamIds, candidateOrgIds),
    addOrgIdsFromTable(serviceClient, 'players', playerIds, candidateOrgIds),
  ]);
  const resolutionError = resolutionErrors.find(Boolean);

  if (resolutionError) return { status: 500, message: resolutionError };

  if (candidateOrgIds.size === 0) {
    return {
      status: 400,
      message: 'Unable to resolve organization for team persistence payload.',
    };
  }

  if (candidateOrgIds.size > 1) {
    return {
      status: 403,
      message: 'Access denied: team persistence payload spans multiple organizations.',
    };
  }

  return { organizationId: [...candidateOrgIds][0] };
}

// ── Handler setup ───────────────────────────────────────────────────────────

type HttpHandler = (request: Request) => Response | Promise<Response>;

const supabaseUrl = Deno.env.get('SUPABASE_URL');
const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
// The save is made AS THE CALLER, which needs the anon key: the RPC's admin
// check, its `created_by` and its audit row all read auth.uid().
const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
const allowedRoles = parseAllowedRolesEnv(Deno.env.get('TEAM_PERSISTENCE_ALLOWED_ROLES'));

let handler: HttpHandler;

if (!supabaseUrl || !serviceRoleKey || !anonKey) {
  console.error(
    'Missing SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY or SUPABASE_ANON_KEY for team persistence function.'
  );
  // Wrapped like the real handler, so every request this misconfigured
  // function refuses reaches BetterStack with a request ID (the console line
  // above prints once, at boot).
  handler = withFailureLogging('team-persistence', async (req: Request, logCtx) => {
    // A CORS preflight is not a call; log the requests that are.
    if (req.method !== 'OPTIONS') {
      await logFailure(
        logCtx,
        'Supabase service configuration is missing',
        new Error('Missing SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY or SUPABASE_ANON_KEY.')
      );
    }
    return jsonResponse(
      { status: 'error', message: 'Supabase service configuration is missing.' },
      500
    );
  });
} else {
  const serviceClient = createClient(supabaseUrl, serviceRoleKey, {
    global: { fetch },
    auth: { persistSession: false },
  });

  handler = withFailureLogging('team-persistence', async (req: Request, logCtx) => {
    // CORS preflight
    if (req.method === 'OPTIONS') {
      return new Response('ok', { headers: corsHeaders });
    }
    if (req.method !== 'POST') {
      return jsonResponse({ status: 'error', message: 'Method not allowed' }, 405);
    }

    // 1. Authenticate user
    const user = await getUserFromRequest(req, serviceClient);
    if (!user) {
      return jsonResponse({ status: 'error', message: 'Unauthorized' }, 401);
    }

    // 1b. Rate limit
    const rateCheck = checkRateLimit(user.id);
    if (!rateCheck.allowed) {
      return rateLimitExceededResponse(rateCheck);
    }

    // 1c. Role check
    const userRole =
      ((user as unknown as Record<string, unknown>).role as string) ?? 'authenticated';
    const effectiveRole =
      (((user as unknown as Record<string, unknown>).app_metadata as Record<string, unknown>)
        ?.role as string) ?? userRole;
    if (!allowedRoles.includes(effectiveRole)) {
      return jsonResponse(
        { status: 'error', message: `Role "${effectiveRole}" is not authorized.` },
        403
      );
    }

    // 2. Validate payload
    let body: z.infer<typeof PersistencePayloadSchema>;
    try {
      const clone = req.clone();
      const raw = await clone.json();
      const parsed = PersistencePayloadSchema.safeParse(raw);
      if (!parsed.success) {
        return jsonResponse(
          { status: 'error', message: 'Invalid payload', issues: parsed.error.issues },
          400
        );
      }
      body = parsed.data;
    } catch {
      return jsonResponse({ status: 'error', message: 'Invalid JSON' }, 400);
    }

    // 3. Verify organization membership and admin authority for the target org.
    const userOrgIds = await getUserOrgIds(serviceClient, user.id);
    if (userOrgIds.length === 0) {
      return jsonResponse(
        { status: 'error', message: 'User is not a member of any organization' },
        403
      );
    }

    const targetOrg = await resolveTargetOrgId(serviceClient, body);
    if (!targetOrg.organizationId) {
      return jsonResponse(
        { status: 'error', message: targetOrg.message ?? 'Unable to verify organization scope.' },
        targetOrg.status ?? 403
      );
    }

    if (!userOrgIds.includes(targetOrg.organizationId)) {
      return jsonResponse(
        { status: 'error', message: 'Access denied: data belongs to a different organization' },
        403
      );
    }
    logCtx.organizationId = targetOrg.organizationId;

    const isOrgAdmin = await verifyOrgAdmin(serviceClient, user.id, targetOrg.organizationId);
    if (!isOrgAdmin) {
      return jsonResponse(
        { status: 'error', message: 'Admin team-management permission is required.' },
        403
      );
    }

    body.runMetadata = body.runMetadata ?? {};
    body.runMetadata.organizationId = targetOrg.organizationId;

    // 4. Check for pending overrides
    const { pending } = evaluateOverrides(body.overrides ?? []);
    if (pending > 0) {
      return jsonResponse(
        {
          status: 'blocked',
          message: `${pending} manual override${pending === 1 ? ' is' : 's are'} still pending review.`,
          pendingOverrides: pending,
        },
        409
      );
    }

    // 5. Persist -- AS THE CALLER (docs/PLAN_AUDIT_IN_TRANSACTION.md, 3.2),
    // as practice-persistence does. `persist_team_schedule` checks the caller
    // is an admin of the organization, records them as the run's creator and
    // writes the `team.saved` audit row in the save's own transaction, so a
    // save cannot land without its audit row; a service-role client has no
    // user and is refused. `verifyOrgAdmin` above stays as the early 403.
    const userClient = createUserClient(req, supabaseUrl, anonKey);
    try {
      const result = await persistTeamSnapshot(
        userClient,
        body.snapshot as Parameters<typeof persistTeamSnapshot>[1],
        (body.runMetadata ?? {}) as RunMetadata,
        new Date()
      );

      return jsonResponse(result, 200);
    } catch (error) {
      // The audit row could not be written, so the RPC rolled the save back:
      // the outcome is known, and the caller is told nothing was saved.
      if (isAuditWriteFailure(error)) {
        return await auditWriteFailedResponse(logCtx, 'Team save', error);
      }
      await logFailure(logCtx, 'Team persistence failed', error);
      return jsonResponse(
        {
          status: 'error',
          message: (error as Error)?.message || 'Failed to persist team snapshot.',
        },
        500
      );
    }
  });
}

serve(handler);
