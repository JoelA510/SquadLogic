/**
 * Game Persistence Edge Function
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
  recordAudit,
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
    payload: z
      .object({
        gameRows: z.array(z.object({ id: z.string().optional() }).passthrough()).optional(),
        assignmentRows: z
          .array(
            z
              .object({
                home_team_id: z.string().optional(),
                homeTeamId: z.string().optional(),
                away_team_id: z.string().optional(),
                awayTeamId: z.string().optional(),
                slot_id: z.string().optional(),
                slotId: z.string().optional(),
                game_slot_id: z.string().optional(),
                gameSlotId: z.string().optional(),
              })
              .passthrough()
          )
          .optional(),
      })
      .refine(
        (payload) => Array.isArray(payload.assignmentRows) || Array.isArray(payload.gameRows),
        'snapshot.payload.assignmentRows or snapshot.payload.gameRows is required'
      ),
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

function getNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

async function resolveOrgIdFromSeasonSettings(
  supabaseClient: SupabaseClient,
  seasonSettingsId: string
): Promise<string | null> {
  const { data, error } = await supabaseClient
    .from('season_settings')
    .select('organization_id')
    .eq('id', seasonSettingsId)
    .maybeSingle();

  if (error) {
    console.error('Failed to resolve org from season settings:', error.message);
    throw new Error('Season settings lookup failed.');
  }

  return getNonEmptyString((data as Record<string, unknown> | null)?.organization_id);
}

interface RunMetadata {
  runId?: string;
  organizationId?: string;
  seasonSettingsId?: string;
  parameters?: Record<string, unknown>;
  metrics?: Record<string, unknown>;
  results?: Record<string, unknown>;
  createdBy?: string;
  startedAt?: string;
  completedAt?: string;
}

async function persistGameSnapshot(
  supabaseClient: SupabaseClient,
  snapshot: {
    payload: { assignmentRows?: Record<string, unknown>[]; gameRows?: Record<string, unknown>[] };
    lastRunId?: string | null;
    runId?: string | null;
  },
  runMetadata: RunMetadata = {},
  now: Date = new Date()
) {
  const gameRows = snapshot.payload.assignmentRows ?? snapshot.payload.gameRows ?? [];
  const effectiveRunId = runMetadata.runId ?? snapshot.lastRunId ?? snapshot.runId;

  const runData = effectiveRunId
    ? {
        id: effectiveRunId,
        organization_id: runMetadata.organizationId,
        run_type: 'game',
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
        organization_id: runMetadata.organizationId,
        season_settings_id: runMetadata.seasonSettingsId,
        run_type: 'game',
        status: 'completed',
        parameters: runMetadata.parameters ?? {},
        metrics: runMetadata.metrics ?? {},
        results: runMetadata.results ?? {},
        created_by: runMetadata.createdBy ?? 'system',
        started_at: runMetadata.startedAt ?? now.toISOString(),
        completed_at: runMetadata.completedAt ?? now.toISOString(),
        updated_at: now.toISOString(),
      };

  const { data, error } = await supabaseClient.rpc('persist_game_schedule', {
    run_data: runData,
    assignments: gameRows,
  });

  if (error) throw error;

  return {
    status: 'success',
    runId: effectiveRunId ?? data ?? null,
    message: 'Persistence successful.',
    syncedAt: now.toISOString(),
  };
}

// ── Handler setup ───────────────────────────────────────────────────────────

type HttpHandler = (request: Request) => Response | Promise<Response>;

const supabaseUrl = Deno.env.get('SUPABASE_URL');
const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const allowedRoles = parseAllowedRolesEnv(Deno.env.get('GAME_PERSISTENCE_ALLOWED_ROLES'));

let handler: HttpHandler;

if (!supabaseUrl || !serviceRoleKey) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY for game persistence function.');
  handler = () =>
    jsonResponse({ status: 'error', message: 'Supabase service configuration is missing.' }, 500);
} else {
  const serviceClient = createClient(supabaseUrl, serviceRoleKey, {
    global: { fetch },
    auth: { persistSession: false },
  });

  handler = withFailureLogging('game-persistence', async (req: Request, logCtx) => {
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

    // 3. Verify organization membership across requested run, season, and teams.
    const userOrgIds = await getUserOrgIds(serviceClient, user.id);
    if (userOrgIds.length === 0) {
      return jsonResponse(
        { status: 'error', message: 'User is not a member of any organization' },
        403
      );
    }

    const runMetadataRecord = (body.runMetadata ?? {}) as Record<string, unknown>;
    const requestedOrgId = getNonEmptyString(runMetadataRecord.organizationId);
    const requestedSeasonSettingsId = getNonEmptyString(runMetadataRecord.seasonSettingsId);
    const targetOrgIds = new Set<string>();

    if (requestedOrgId) {
      targetOrgIds.add(requestedOrgId);
    }

    if (requestedSeasonSettingsId) {
      try {
        const seasonOrgId = await resolveOrgIdFromSeasonSettings(
          serviceClient,
          requestedSeasonSettingsId
        );
        if (!seasonOrgId) {
          return jsonResponse({ status: 'error', message: 'Season settings not found.' }, 400);
        }
        targetOrgIds.add(seasonOrgId);
      } catch (error) {
        return jsonResponse(
          {
            status: 'error',
            message: (error as Error)?.message || 'Season settings lookup failed.',
          },
          500
        );
      }
    }

    const gameRows = body.snapshot.payload.assignmentRows ?? body.snapshot.payload.gameRows ?? [];
    if (gameRows.length > 0) {
      const teamIds = [
        ...new Set(
          gameRows
            .flatMap((r) => [
              (r as Record<string, unknown>).home_team_id as string | undefined,
              (r as Record<string, unknown>).homeTeamId as string | undefined,
              (r as Record<string, unknown>).away_team_id as string | undefined,
              (r as Record<string, unknown>).awayTeamId as string | undefined,
            ])
            .filter(Boolean)
        ),
      ] as string[];
      if (teamIds.length > 0) {
        const teamOrgIds = await resolveOrgIdsFromTeamIds(serviceClient, teamIds);
        for (const organizationId of teamOrgIds) {
          targetOrgIds.add(organizationId);
        }
      }
    }

    if (targetOrgIds.size === 0) {
      return jsonResponse(
        {
          status: 'error',
          message: 'organizationId or organization-scoped assignments are required.',
        },
        400
      );
    }

    if (targetOrgIds.size > 1) {
      return jsonResponse(
        { status: 'error', message: 'Game persistence payload spans multiple organizations.' },
        403
      );
    }

    const targetOrgId = Array.from(targetOrgIds)[0];
    if (!targetOrgId) {
      return jsonResponse(
        { status: 'error', message: 'Unable to resolve target organization.' },
        400
      );
    }

    if (!userOrgIds.includes(targetOrgId)) {
      return jsonResponse(
        { status: 'error', message: 'Access denied: data belongs to a different organization' },
        403
      );
    }
    logCtx.organizationId = targetOrgId;

    const effectiveRunMetadata = {
      ...runMetadataRecord,
      organizationId: requestedOrgId ?? targetOrgId,
      seasonSettingsId: requestedSeasonSettingsId ?? undefined,
    };

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
      const result = await persistGameSnapshot(
        serviceClient,
        body.snapshot as Parameters<typeof persistGameSnapshot>[1],
        effectiveRunMetadata as RunMetadata,
        new Date()
      );

      // Audit log (fire-and-forget)
      recordAudit(serviceClient, {
        organizationId: targetOrgId,
        action: 'game.saved',
        resourceType: 'game',
        metadata: { game_count: gameRows.length },
      });

      return jsonResponse(result, 200);
    } catch (error) {
      await logFailure(logCtx, 'Game persistence failed', error);
      return jsonResponse(
        {
          status: 'error',
          message: (error as Error)?.message || 'Failed to persist game snapshot.',
        },
        500
      );
    }
  });
}

serve(handler);
