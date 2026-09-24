/**
 * Practice Persistence Edge Function
 * Self-contained handler — all logic inlined for Deno Edge runtime compatibility.
 * Security: org membership validation (C-1), rate limiting (M-4), payload validation.
 */
import { serve } from 'https://deno.land/std@0.223.0/http/server.ts';
import { z } from 'https://deno.land/x/zod@v3.22.4/mod.ts';
import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.3';
import {
  getUserFromRequest,
  getUserOrgIds,
  resolveOrgIdsFromTeamIds,
  verifyOrgAdmin,
  recordAudit,
  corsHeaders,
  jsonResponse,
} from '../_shared/auth.ts';
import { checkRateLimit, rateLimitExceededResponse } from '../_shared/rateLimit.ts';

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
      assignmentRows: z.array(
        z.object({ team_id: z.string(), practice_slot_id: z.string() }).passthrough()
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
  seasonSettingsId?: string;
  parameters?: Record<string, unknown>;
  metrics?: Record<string, unknown>;
  results?: Record<string, unknown>;
  createdBy?: string;
  startedAt?: string;
  completedAt?: string;
}

async function resolveOrgIdFromSeasonSettingsId(
  supabaseClient: SupabaseClient,
  seasonSettingsId: string
): Promise<string | null> {
  const { data, error } = await supabaseClient
    .from('season_settings')
    .select('organization_id')
    .eq('id', seasonSettingsId)
    .single();

  if (error) {
    throw error;
  }

  return (data as { organization_id?: string } | null)?.organization_id ?? null;
}

async function persistPracticeSnapshot(
  supabaseClient: SupabaseClient,
  snapshot: {
    payload: { assignmentRows: Record<string, unknown>[] };
    lastRunId?: string | null;
    runId?: string | null;
  },
  runMetadata: RunMetadata = {},
  now: Date = new Date()
) {
  const { assignmentRows } = snapshot.payload;
  const effectiveRunId = runMetadata.runId ?? snapshot.lastRunId ?? snapshot.runId;

  // R3 Follow-up: Fetch season settings for timezone/schoolDayEnd
  if (runMetadata.seasonSettingsId) {
    const { data: settings } = await supabaseClient
      .from('season_settings')
      .select('timezone, school_day_end')
      .eq('id', runMetadata.seasonSettingsId)
      .single();

    if (settings) {
      runMetadata.parameters = {
        ...(runMetadata.parameters || {}),
        timezone: (settings as Record<string, unknown>).timezone,
        schoolDayEnd: (settings as Record<string, unknown>).school_day_end,
      };
    }
  }

  const runData = effectiveRunId
    ? {
        id: effectiveRunId,
        run_type: 'practice',
        season_settings_id: runMetadata.seasonSettingsId,
        status: 'completed',
        parameters: runMetadata.parameters ?? {},
        metrics: runMetadata.metrics ?? {},
        results: runMetadata.results ?? {},
        created_by: runMetadata.createdBy ?? 'system',
        started_at: runMetadata.startedAt ?? now.toISOString(),
        completed_at: runMetadata.completedAt ?? now.toISOString(),
        updated_at: now.toISOString(),
      }
    : {
        run_type: 'practice',
        // #64: the RPC scopes its prune to this season and refuses without it.
        season_settings_id: runMetadata.seasonSettingsId,
        status: 'completed',
        updated_at: now.toISOString(),
      };

  const { data, error } = await supabaseClient.rpc('persist_practice_schedule', {
    run_data: runData,
    assignments: assignmentRows,
  });

  if (error) throw error;

  // #64: the RPC returns jsonb -- the run id, the rows this save superseded,
  // the manual rows it deliberately kept, and whether it could audit.
  // A bare uuid is what the RPC returned before 20260924000000; read either,
  // so this function and the migration need not deploy in the same instant.
  const report = (typeof data === 'string' ? { run_id: data } : (data ?? {})) as {
    run_id?: string;
    superseded_count?: number;
    retained_manual?: unknown[];
    retained_manual_count?: number;
    audited?: boolean;
    audit_gap?: string | null;
  };

  return {
    status: 'success',
    runId: effectiveRunId ?? report.run_id ?? null,
    supersededCount: report.superseded_count ?? 0,
    retainedManualCount: report.retained_manual_count ?? 0,
    retainedManual: report.retained_manual ?? [],
    audited: report.audited ?? false,
    auditGap: report.audit_gap ?? null,
    message: 'Persistence successful.',
    syncedAt: now.toISOString(),
  };
}

// ── Handler setup ───────────────────────────────────────────────────────────

type HttpHandler = (request: Request) => Response | Promise<Response>;

const supabaseUrl = Deno.env.get('SUPABASE_URL');
const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const allowedRoles = parseAllowedRolesEnv(Deno.env.get('PRACTICE_PERSISTENCE_ALLOWED_ROLES'));

let handler: HttpHandler;

if (!supabaseUrl || !serviceRoleKey) {
  console.error(
    'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY for practice persistence function.'
  );
  handler = () =>
    jsonResponse({ status: 'error', message: 'Supabase service configuration is missing.' }, 500);
} else {
  const serviceClient = createClient(supabaseUrl, serviceRoleKey, {
    global: { fetch },
    auth: { persistSession: false },
  });

  handler = async (req: Request) => {
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

    // 3. Verify organization membership via assignment → team chain
    const userOrgIds = await getUserOrgIds(serviceClient, user.id);
    if (userOrgIds.length === 0) {
      return jsonResponse(
        { status: 'error', message: 'User is not a member of any organization' },
        403
      );
    }

    const assignmentRows = body.snapshot.payload.assignmentRows;
    const seasonSettingsId =
      typeof body.runMetadata?.seasonSettingsId === 'string'
        ? body.runMetadata.seasonSettingsId
        : undefined;

    // #64: a save now REPLACES the season's practice schedule, so it needs a
    // season to scope that to, and an empty one would remove every auto row
    // in it. The RPC refuses both; refusing here makes them a 400, not a 500.
    if (!seasonSettingsId) {
      return jsonResponse(
        { status: 'error', message: 'runMetadata.seasonSettingsId is required' },
        400
      );
    }
    if (assignmentRows.length === 0) {
      return jsonResponse(
        {
          status: 'error',
          message:
            'Refusing to save an empty practice schedule: it would remove every auto assignment in the season.',
        },
        400
      );
    }

    const seasonOrgId = await resolveOrgIdFromSeasonSettingsId(serviceClient, seasonSettingsId);
    if (!seasonOrgId || !userOrgIds.includes(seasonOrgId)) {
      return jsonResponse(
        { status: 'error', message: 'Access denied: season belongs to a different organization' },
        403
      );
    }

    // #64: a save now DELETES the season's superseded rows. The RPC requires an
    // org admin of any caller with a uid, but this function calls it with the
    // service-role client, which the RPC exempts -- so the same rule is
    // enforced here, or any member could erase a season's practices.
    if (!(await verifyOrgAdmin(serviceClient, user.id, seasonOrgId))) {
      return jsonResponse(
        {
          status: 'error',
          message: 'Access denied: only an organization admin can replace a practice schedule',
        },
        403
      );
    }

    const teamIds = [...new Set(assignmentRows.map((r) => r.team_id).filter(Boolean))] as string[];
    if (teamIds.length > 0) {
      const targetOrgIds = await resolveOrgIdsFromTeamIds(serviceClient, teamIds);
      const unauthorized = targetOrgIds.filter((oid) => !userOrgIds.includes(oid));
      if (unauthorized.length > 0) {
        return jsonResponse(
          { status: 'error', message: 'Access denied: data belongs to a different organization' },
          403
        );
      }
    }

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

    // 5. Persist
    try {
      const result = await persistPracticeSnapshot(
        serviceClient,
        body.snapshot as Parameters<typeof persistPracticeSnapshot>[1],
        // `createdBy` is the verified caller, never the client's claim: the
        // service-role RPC records it as the run's creator.
        { ...((body.runMetadata ?? {}) as RunMetadata), createdBy: user.id },
        new Date()
      );

      // Audit log (fire-and-forget)
      if (userOrgIds.length > 0) {
        // The season's organisation, not the caller's first one, and what the
        // save superseded. Still a no-op while audit_log.user_id is NOT NULL
        // and this client has no uid (20260726000200's KNOWN PRE-EXISTING
        // defect) -- which is why the RPC reports `audited: false`.
        recordAudit(serviceClient, {
          organizationId: seasonOrgId,
          action: 'practice.saved',
          resourceType: 'practice_assignment',
          metadata: {
            assignment_count: assignmentRows.length,
            superseded_count: result.supersededCount,
            retained_manual_count: result.retainedManualCount,
            run_id: result.runId,
          },
        });
      }

      return jsonResponse(result, 200);
    } catch (error) {
      console.error('Practice persistence error:', error);
      return jsonResponse(
        {
          status: 'error',
          message: (error as Error)?.message || 'Failed to persist practice snapshot.',
        },
        500
      );
    }
  };
}

serve(handler);
