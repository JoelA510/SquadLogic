/**
 * Edge Function: auto-scheduler
 *
 * Phase 8 — Intelligent Auto-Scheduler.
 * Runs a Hill Climbing optimization loop on the server, scoring candidates
 * via the isomorphic scoring-engine and persisting the best result via
 * the persist_evaluation_run RPC.
 *
 * Security: JWT auth, org membership verification, rate limiting, IDOR prevention.
 * Governance: Every run produces an evaluation_run record and audit trail.
 */

import { serve } from 'https://deno.land/std@0.223.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.3';
import { evaluatePracticeSchedule } from '../_shared/engines/scoring-engine.ts';
import { AutoSchedulerInputSchema } from '../_shared/schemas/auto-scheduler.ts';
import {
  checkHardConstraints,
  prepareTeam,
  type PreparedTeam,
  type TimeWindow,
} from '../_shared/engines/practice-coaches.ts';
import { anchorWallTimes, describeAnchorFailure } from '../_shared/timing/anchorWallTimes.ts';
import { readSeasonTimezone } from '../_shared/timing/seasonSettings.ts';
import {
  getUserFromRequest,
  getUserOrgIds,
  verifyOrgMembership,
  corsHeaders,
  jsonResponse,
  recordAudit,
} from '../_shared/auth.ts';
import { checkRateLimit } from '../_shared/rateLimit.ts';
import { edgeLogger } from '../_shared/logtail.ts';

// ---------------------------------------------------------------------------
// Seeded PRNG (mulberry32)
// ---------------------------------------------------------------------------

function createPRNG(seed: number): () => number {
  let state = seed | 0;
  return function mulberry32(): number {
    state += 0x6d2b79f5;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Hard constraint checking
// ---------------------------------------------------------------------------

type SchedulerTeam = PreparedTeam & { division: string };

// ---------------------------------------------------------------------------
// Scoring wrapper
// ---------------------------------------------------------------------------

interface ScoringResult {
  score: number;
  evaluation: ReturnType<typeof evaluatePracticeSchedule>;
}

function scoreSchedule(
  assignments: Array<{ teamId: string; slotId: string; source: string }>,
  unassigned: Array<{ teamId: string; reason: string }>,
  teams: Array<SchedulerTeam>,
  slots: Array<{ id: string; day?: string | null; start: Date; end: Date; capacity: number }>
): ScoringResult {
  const evaluation = evaluatePracticeSchedule({
    assignments,
    unassigned,
    teams: teams as unknown as Parameters<typeof evaluatePracticeSchedule>[0]['teams'],
    slots: slots as unknown as Parameters<typeof evaluatePracticeSchedule>[0]['slots'],
  });

  // Compute fitness from scoring-engine metrics
  const { summary, coachConflicts } = evaluation;
  const totalTeams = summary.totalTeams || 1;
  const coverage = summary.assignedTeams / totalTeams;
  const conflictPenalty = Math.min(1, (coachConflicts?.length ?? 0) * 0.15);
  const coveragePenalty = 1 - coverage;
  const fairnessScore = 1 - (conflictPenalty * 0.15 + coveragePenalty * 0.5);

  return { score: Math.max(0, fairnessScore), evaluation };
}

// ---------------------------------------------------------------------------
// Hill Climbing optimizer
// ---------------------------------------------------------------------------

interface OptimizerState {
  assignmentMap: Map<string, string>;
  lockedTeams: Set<string>;
  autoTeams: string[];
  slotsById: Map<
    string,
    { id: string; start: Date; end: Date; capacity: number; day?: string | null }
  >;
  teamsById: Map<string, SchedulerTeam>;
  slotCapacity: Map<string, number>;
  coachAssignments: Map<string, TimeWindow[]>;
  coachPreferences: Record<string, { unavailableSlotIds?: string[] }>;
  unassignedTeamIds: string[];
}

function buildState(
  assignments: Array<{ teamId: string; slotId: string; source: string }>,
  unassigned: Array<{ teamId: string }>,
  teams: Array<SchedulerTeam>,
  slots: Array<{ id: string; start: Date; end: Date; capacity: number; day?: string | null }>,
  coachPreferences: Record<string, { unavailableSlotIds?: string[] }>
): OptimizerState {
  const assignmentMap = new Map<string, string>();
  const lockedTeams = new Set<string>();
  const autoTeams: string[] = [];

  for (const a of assignments) {
    assignmentMap.set(a.teamId, a.slotId);
    if (a.source === 'locked') {
      lockedTeams.add(a.teamId);
    } else {
      autoTeams.push(a.teamId);
    }
  }

  const slotsById = new Map(slots.map((s) => [s.id, s]));
  const teamsById = new Map(teams.map((t) => [t.id, t]));

  const slotCapacity = new Map(slots.map((s) => [s.id, s.capacity]));
  for (const [, slotId] of assignmentMap) {
    slotCapacity.set(slotId, (slotCapacity.get(slotId) ?? 0) - 1);
  }

  const coachAssignments = new Map<string, TimeWindow[]>();
  for (const [teamId, slotId] of assignmentMap) {
    const team = teamsById.get(teamId);
    const slot = slotsById.get(slotId);
    if (!team || !slot) continue;
    for (const coachId of team.coachIds) {
      const existing = coachAssignments.get(coachId) ?? [];
      existing.push({ teamId, slotId, start: slot.start, end: slot.end });
      coachAssignments.set(coachId, existing);
    }
  }

  return {
    assignmentMap,
    lockedTeams,
    autoTeams,
    slotsById,
    teamsById,
    slotCapacity,
    coachAssignments,
    coachPreferences,
    unassignedTeamIds: unassigned.map((u) => u.teamId),
  };
}

function tryMutate(
  state: OptimizerState,
  rand: () => number
): {
  assignments: Array<{ teamId: string; slotId: string; source: string }>;
  unassigned: Array<{ teamId: string; reason: string }>;
  type: string;
} | null {
  const { autoTeams, unassignedTeamIds, slotsById, teamsById, coachPreferences } = state;
  const hasUnassigned = unassignedTeamIds.length > 0;
  const hasMultipleAuto = autoTeams.length >= 2;

  const r = rand();
  let mutationType: string;
  if (hasUnassigned && r < 0.4) mutationType = 'relocate';
  else if (hasMultipleAuto && r < 0.85) mutationType = 'swap';
  else if (hasMultipleAuto && autoTeams.length >= 3) mutationType = 'chain-swap';
  else if (hasMultipleAuto) mutationType = 'swap';
  else return null;

  const newMap = new Map(state.assignmentMap);
  const newCap = new Map(state.slotCapacity);
  const newCoach = new Map<string, TimeWindow[]>();
  for (const [k, v] of state.coachAssignments) newCoach.set(k, [...v]);

  const remove = (teamId: string) => {
    const slotId = newMap.get(teamId);
    if (!slotId) return;
    newMap.delete(teamId);
    newCap.set(slotId, (newCap.get(slotId) ?? 0) + 1);
    const team = teamsById.get(teamId);
    if (!team) return;
    for (const coachId of team.coachIds) {
      const entries = newCoach.get(coachId) ?? [];
      newCoach.set(
        coachId,
        entries.filter((e) => e.teamId !== teamId)
      );
    }
  };

  const add = (teamId: string, slotId: string): boolean => {
    const team = teamsById.get(teamId);
    const slot = slotsById.get(slotId);
    if (!team || !slot) return false;
    if (!checkHardConstraints(team, slot, newCoach, newCap, coachPreferences)) return false;
    newMap.set(teamId, slotId);
    newCap.set(slotId, (newCap.get(slotId) ?? 0) - 1);
    for (const coachId of team.coachIds) {
      const entries = newCoach.get(coachId) ?? [];
      entries.push({ teamId, slotId, start: slot.start, end: slot.end });
      newCoach.set(coachId, entries);
    }
    return true;
  };

  if (mutationType === 'swap') {
    const i = Math.floor(rand() * autoTeams.length);
    let j = Math.floor(rand() * (autoTeams.length - 1));
    if (j >= i) j++;
    const slotA = newMap.get(autoTeams[i]);
    const slotB = newMap.get(autoTeams[j]);
    if (!slotA || !slotB || slotA === slotB) return null;
    remove(autoTeams[i]);
    remove(autoTeams[j]);
    if (!add(autoTeams[i], slotB) || !add(autoTeams[j], slotA)) return null;
  } else if (mutationType === 'relocate') {
    const targetId = hasUnassigned
      ? unassignedTeamIds[Math.floor(rand() * unassignedTeamIds.length)]
      : autoTeams[Math.floor(rand() * autoTeams.length)];
    const slotIds = [...slotsById.keys()];
    const targetSlot = slotIds[Math.floor(rand() * slotIds.length)];
    const currentSlot = newMap.get(targetId);
    if (currentSlot === targetSlot) return null;
    if (currentSlot) remove(targetId);
    if (!add(targetId, targetSlot)) {
      if (currentSlot) add(targetId, currentSlot);
      return null;
    }
  } else {
    if (autoTeams.length < 3) return null;
    const indices = new Set<number>();
    while (indices.size < 3) indices.add(Math.floor(rand() * autoTeams.length));
    const [iA, iB, iC] = [...indices];
    const sA = newMap.get(autoTeams[iA]);
    const sB = newMap.get(autoTeams[iB]);
    const sC = newMap.get(autoTeams[iC]);
    if (!sA || !sB || !sC || sA === sB || sB === sC || sA === sC) return null;
    remove(autoTeams[iA]);
    remove(autoTeams[iB]);
    remove(autoTeams[iC]);
    if (!add(autoTeams[iA], sB) || !add(autoTeams[iB], sC) || !add(autoTeams[iC], sA)) return null;
  }

  const assignments = [...newMap.entries()]
    .map(([teamId, slotId]) => ({
      teamId,
      slotId,
      source: state.lockedTeams.has(teamId) ? 'locked' : 'auto',
    }))
    .sort((a, b) => a.teamId.localeCompare(b.teamId));

  const assignedSet = new Set(newMap.keys());
  const unassigned = [...teamsById.keys()]
    .filter((id) => !assignedSet.has(id))
    .map((teamId) => ({ teamId, reason: 'optimizer-unplaced' }));

  return { assignments, unassigned, type: mutationType };
}

// ---------------------------------------------------------------------------
// Greedy seed (server-side — replicate practiceScheduling.js core logic)
// ---------------------------------------------------------------------------

function generateGreedySeed(
  teams: Array<SchedulerTeam>,
  slots: Array<{ id: string; start: Date; end: Date; capacity: number; day?: string | null }>,
  lockedAssignments: Array<{ teamId: string; slotId: string }>,
  coachPreferences: Record<string, { unavailableSlotIds?: string[] }>
): {
  assignments: Array<{ teamId: string; slotId: string; source: string }>;
  unassigned: Array<{ teamId: string; reason: string }>;
} {
  const slotsById = new Map(slots.map((s) => [s.id, s]));
  const teamsById = new Map(teams.map((t) => [t.id, t]));
  const slotCapacity = new Map(slots.map((s) => [s.id, s.capacity]));
  const coachAssignments = new Map<string, TimeWindow[]>();
  const assignedTeamIds = new Set<string>();

  const assignments: Array<{ teamId: string; slotId: string; source: string }> = [];

  const assign = (teamId: string, slotId: string, source: string) => {
    const team = teamsById.get(teamId)!;
    const slot = slotsById.get(slotId)!;
    assignments.push({ teamId, slotId, source });
    assignedTeamIds.add(teamId);
    slotCapacity.set(slotId, (slotCapacity.get(slotId) ?? 0) - 1);
    for (const coachId of team.coachIds) {
      const existing = coachAssignments.get(coachId) ?? [];
      existing.push({ teamId, slotId, start: slot.start, end: slot.end });
      coachAssignments.set(coachId, existing);
    }
  };

  // 1. Lock assignments first
  for (const locked of lockedAssignments) {
    if (teamsById.has(locked.teamId) && slotsById.has(locked.slotId)) {
      assign(locked.teamId, locked.slotId, 'locked');
    }
  }

  // 2. Sort by coach load (multi-team coaches first)
  const coachTeamCounts = new Map<string, number>();
  for (const team of teams) {
    for (const coachId of team.coachIds) {
      coachTeamCounts.set(coachId, (coachTeamCounts.get(coachId) ?? 0) + 1);
    }
  }
  const busiestCoachCount = new Map(
    teams.map((team) => [
      team.id,
      Math.max(0, ...team.coachIds.map((coachId) => coachTeamCounts.get(coachId) ?? 0)),
    ])
  );
  const sorted = [...teams].sort((a, b) => {
    const ac = busiestCoachCount.get(a.id) ?? 0;
    const bc = busiestCoachCount.get(b.id) ?? 0;
    return bc - ac || a.id.localeCompare(b.id);
  });

  // 3. Greedy assignment
  for (const team of sorted) {
    if (assignedTeamIds.has(team.id)) continue;
    let bestSlot: string | null = null;
    for (const slot of slots) {
      if (checkHardConstraints(team, slot, coachAssignments, slotCapacity, coachPreferences)) {
        bestSlot = slot.id;
        break;
      }
    }
    if (bestSlot) {
      assign(team.id, bestSlot, 'auto');
    }
  }

  const unassigned = teams
    .filter((t) => !assignedTeamIds.has(t.id))
    .map((t) => ({ teamId: t.id, reason: 'no-slot-available' }));

  return { assignments, unassigned };
}

// ---------------------------------------------------------------------------
// HTTP handler
// ---------------------------------------------------------------------------

serve(async (req) => {
  // 1. CORS Preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, serviceKey);

  try {
    // 2. Auth
    const user = await getUserFromRequest(req, supabase);
    if (!user) {
      return jsonResponse({ error: 'Unauthorized' }, 401);
    }

    // 3. Rate limiting (10 req/min — optimizer is expensive)
    const {
      allowed,
      remaining: _remaining,
      retryAfterMs,
    } = checkRateLimit(user.id, {
      maxRequests: 10,
      windowMs: 60_000,
    });
    if (!allowed) {
      return jsonResponse({ error: 'Rate limit exceeded', retryAfterMs }, 429);
    }

    // 4. Parse & validate body
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return jsonResponse({ error: 'Invalid JSON body' }, 400);
    }

    const parseResult = AutoSchedulerInputSchema.safeParse(body);
    if (!parseResult.success) {
      return jsonResponse({ error: 'Validation failed', details: parseResult.error.format() }, 400);
    }

    const input = parseResult.data;

    // 5. Organization membership check (IDOR prevention)
    const isMember = await verifyOrgMembership(supabase, user.id, input.organizationId);
    if (!isMember) {
      return jsonResponse({ error: 'Not authorized for this organization' }, 403);
    }

    // 5b. Place every slot on the SEASON's clock, before anything calls
    //     `new Date()` on it (LIVE-7).
    //
    // The zone is read from `season_settings` here rather than taken from the
    // request body. The body used to carry `timezone` and this file contained
    // zero occurrences of the string, so every practice instant was a function
    // of the Deno runtime's zone -- UTC on the edge -- instead of the season's.
    // Reading it server-side makes it authoritative as well as read; see
    // `_shared/timing/seasonSettings.ts`.
    //
    // This runs AFTER the membership check, so a caller cannot probe another
    // organization's season by sending its id.
    const season = await readSeasonTimezone(
      supabase,
      input.organizationId,
      input.seasonSettingsId ?? null
    );
    if (season.errored) {
      edgeLogger.error('Auto-scheduler could not read the season timezone', {
        orgId: input.organizationId,
        seasonSettingsId: input.seasonSettingsId ?? null,
        message: season.message,
      });
      await edgeLogger.flush();
      return jsonResponse(
        {
          error: "The season's timezone could not be read, so practice times cannot be placed.",
          code: 'SEASON_SETTINGS_UNREADABLE',
        },
        503
      );
    }

    const anchored = anchorWallTimes(input.slots, season.timezone, 'slots');
    if (anchored.blocking.length > 0) {
      // A season with no timezone makes every slot unplaceable, so this is the
      // normal shape of the failure rather than an edge case. It is refused
      // with a reason code, never scheduled against a guessed zone.
      const failure = describeAnchorFailure(anchored.blocking);
      edgeLogger.error('Auto-scheduler refused: slots could not be placed', {
        orgId: input.organizationId,
        timezone: season.timezone,
        slotCount: input.slots.length,
        refusedCount: anchored.blocking.length,
        byCode: failure.byCode,
      });
      await recordAudit(supabase, {
        organizationId: input.organizationId,
        action: 'scheduler.auto_refused',
        resourceType: 'practice_schedule',
        metadata: {
          reason: failure.code,
          byCode: failure.byCode,
          refusedCount: anchored.blocking.length,
          slotCount: input.slots.length,
        },
      });
      await edgeLogger.flush();
      return jsonResponse(failure, 422);
    }

    // 6. Audit + structured logging: scheduler started
    edgeLogger.info('Auto-scheduler invoked', {
      userId: user.id,
      orgId: input.organizationId,
      teamCount: input.teams.length,
      slotCount: input.slots.length,
      maxIterations: input.config.maxIterations,
      timeBudgetMs: input.config.timeBudgetMs,
    });
    await recordAudit(supabase, {
      organizationId: input.organizationId,
      action: 'scheduler.auto_started',
      resourceType: 'practice_schedule',
      metadata: {
        teamCount: input.teams.length,
        slotCount: input.slots.length,
        config: input.config,
      },
    });

    const startTime = Date.now();

    // 7. Prepare data
    const teams = input.teams.map((t) => prepareTeam(t));

    // `anchored.rows` already carries `start`/`end` as instants on the season's
    // clock. `new Date(s.start)` here is what LIVE-7 was: a host-zone read of a
    // naive string.
    const slots = anchored.rows.map((s) => ({
      id: s.id,
      day: s.day ?? null,
      start: s.start,
      end: s.end,
      capacity: s.capacity,
      baseSlotId: s.baseSlotId,
    }));

    const cfg = input.config;
    const rand = createPRNG(cfg.seed);

    // --- Phase 9: Production hardening constants ---
    // Yield every N iterations to avoid 2s CPU limit on Supabase free tier.
    // The free tier enforces a 2s CPU ceiling per isolate burst but allows
    // up to 150s wall-clock time; yielding lets the event loop breathe.
    const YIELD_EVERY = 100;
    // Safety wall-clock cutoff (140s) — leave 10s headroom before the
    // hard 150s isolate timeout on the free tier.
    const WALL_CLOCK_LIMIT_MS = 140_000;

    // 8. Generate greedy seed
    const seed = generateGreedySeed(teams, slots, input.lockedAssignments, input.coachPreferences);
    const seedScoring = scoreSchedule(seed.assignments, seed.unassigned, teams, slots);
    let bestAssignments = seed.assignments;
    let bestUnassigned = seed.unassigned;
    let bestScore = seedScoring.score;
    let bestEvaluation = seedScoring.evaluation;

    let currentAssignments = seed.assignments;
    let currentUnassigned = seed.unassigned;
    let currentScore = bestScore;

    let iteration = 0;
    let stallCount = 0;
    let restartCount = 0;
    const stallLimit = 80;
    const maxRestarts = 5;

    // 9. Hill Climbing loop (with CPU yield + wall-clock guard)
    while (iteration < cfg.maxIterations) {
      const elapsed = Date.now() - startTime;

      // Phase 9: Wall-clock safety cutoff (140s)
      if (elapsed >= WALL_CLOCK_LIMIT_MS) {
        console.warn(
          `[auto-scheduler] Wall-clock safety cutoff at ${elapsed}ms / ${iteration} iterations`
        );
        break;
      }

      // Original time-budget check (user-configurable, shorter)
      if (elapsed >= cfg.timeBudgetMs) break;

      iteration++;

      const state = buildState(
        currentAssignments,
        currentUnassigned,
        teams,
        slots,
        input.coachPreferences
      );
      const mutated = tryMutate(state, rand);

      if (!mutated) {
        stallCount++;
        if (stallCount >= stallLimit && restartCount < maxRestarts) {
          restartCount++;
          stallCount = 0;
          const restart = generateGreedySeed(
            teams,
            slots,
            input.lockedAssignments,
            input.coachPreferences
          );
          currentAssignments = restart.assignments;
          currentUnassigned = restart.unassigned;
          currentScore = scoreSchedule(currentAssignments, currentUnassigned, teams, slots).score;
        }
        // Phase 9: yield on stall iterations too (every YIELD_EVERY)
        if (iteration % YIELD_EVERY === 0) {
          await new Promise((r) => setTimeout(r, 0));
        }
        continue;
      }

      const candidateScoring = scoreSchedule(mutated.assignments, mutated.unassigned, teams, slots);

      if (candidateScoring.score > currentScore) {
        currentAssignments = mutated.assignments;
        currentUnassigned = mutated.unassigned;
        currentScore = candidateScoring.score;
        stallCount = 0;

        if (candidateScoring.score > bestScore) {
          bestAssignments = mutated.assignments;
          bestUnassigned = mutated.unassigned;
          bestScore = candidateScoring.score;
          bestEvaluation = candidateScoring.evaluation;
        }
      } else {
        stallCount++;
        if (stallCount >= stallLimit && restartCount < maxRestarts) {
          restartCount++;
          stallCount = 0;
          currentAssignments = seed.assignments;
          currentUnassigned = seed.unassigned;
          currentScore = seedScoring.score;
        }
      }

      // Phase 9: Yield CPU every YIELD_EVERY iterations to stay under
      // the Supabase free-tier 2s CPU burst limit while using up to
      // 140s of wall-clock time. The yield also allows the progress
      // audit promise to flush.
      if (iteration % YIELD_EVERY === 0) {
        await new Promise((r) => setTimeout(r, 0));

        // Emit progress audit (fire-and-forget)
        recordAudit(supabase, {
          organizationId: input.organizationId,
          action: 'scheduler.auto_progress',
          resourceType: 'practice_schedule',
          metadata: {
            iteration,
            bestScore,
            elapsedMs: Date.now() - startTime,
            restartCount,
          },
        }).catch(() => {});
      }
    }

    const totalElapsedMs = Date.now() - startTime;
    const terminationReason =
      totalElapsedMs >= WALL_CLOCK_LIMIT_MS
        ? 'wall-clock-safety'
        : totalElapsedMs >= cfg.timeBudgetMs
          ? 'time-budget'
          : iteration >= cfg.maxIterations
            ? 'max-iterations'
            : 'converged';

    // 10. Persist evaluation run via RPC
    const runData = {
      organization_id: input.organizationId,
      admin_id: user.id,
      execution_time_ms: totalElapsedMs,
      scheduler_run_type: 'practice' as const,
      season_settings_id: input.seasonSettingsId ?? null,
      status: bestUnassigned.length === 0 ? 'completed' : 'completed_with_warnings',
      findings_severity: bestUnassigned.length > 0 ? 'warnings' : 'none',
      metrics_summary: {
        seedScore: seedScoring.score,
        bestScore,
        improvement: bestScore - seedScoring.score,
        iterations: iteration,
        restarts: restartCount,
        terminationReason,
        teamCount: teams.length,
        assignedCount: bestAssignments.length,
        unassignedCount: bestUnassigned.length,
      },
      input_snapshot: {
        teamCount: teams.length,
        slotCount: slots.length,
        lockedCount: input.lockedAssignments.length,
        seed: cfg.seed,
      },
      created_by: user.id,
      started_at: new Date(startTime).toISOString(),
      completed_at: new Date().toISOString(),
    };

    const findings = bestUnassigned.map((u) => ({
      severity: 'warning',
      finding_code: 'UNASSIGNED_TEAM',
      description: `Team ${u.teamId} could not be assigned: ${u.reason}`,
      affected_entities: [{ teamId: u.teamId }],
    }));

    const metrics = [
      {
        metric_key: 'optimization_best_score',
        metric_value: bestScore,
        thresholds: { min: 0.8, target: 0.95 },
      },
      {
        metric_key: 'optimization_seed_score',
        metric_value: seedScoring.score,
        thresholds: {},
      },
      {
        metric_key: 'execution_latency',
        metric_value: totalElapsedMs,
        thresholds: { max: 30000, target: 15000 },
      },
    ];

    const { data: runId, error: persistError } = await supabase.rpc('persist_evaluation_run', {
      p_run_data: runData,
      p_findings: findings,
      p_metrics: metrics,
    });

    if (persistError) {
      console.error('Persistence failed:', persistError);
    }

    // 11. Audit: scheduler completed
    await recordAudit(supabase, {
      organizationId: input.organizationId,
      action: 'scheduler.auto_completed',
      resourceType: 'evaluation_run',
      resourceId: runId,
      metadata: {
        bestScore,
        iterations: iteration,
        elapsedMs: totalElapsedMs,
        terminationReason,
        teamCount: teams.length,
        assignedCount: bestAssignments.length,
        unassignedCount: bestUnassigned.length,
      },
    });

    // 12. Structured logging: completion
    edgeLogger.info('Auto-scheduler completed', {
      bestScore,
      iterations: iteration,
      elapsedMs: totalElapsedMs,
      terminationReason,
      assignedCount: bestAssignments.length,
      unassignedCount: bestUnassigned.length,
      runId,
    });
    await edgeLogger.flush();

    // 13. Response
    return jsonResponse(
      {
        runId,
        assignments: bestAssignments,
        unassigned: bestUnassigned,
        evaluation: bestEvaluation,
        // Non-blocking timing findings -- today only WALL_TIME_AMBIGUOUS, a
        // wall time that occurs twice on a fall-back night and was resolved to
        // its first occurrence. Reported rather than swallowed: the instant is
        // real, and an operator scheduling into a repeated hour wants to know.
        // Always present (as `[]` when clean) so a consumer cannot mistake
        // "none" for "this build does not report them".
        timingFindings: anchored.findings,
        optimization: {
          seedScore: seedScoring.score,
          bestScore,
          improvement: bestScore - seedScoring.score,
          iterations: iteration,
          restarts: restartCount,
          elapsedMs: totalElapsedMs,
          terminationReason,
        },
      },
      200
    );
  } catch (error) {
    edgeLogger.error('Auto-scheduler failed', {
      error: (error as Error).message,
      stack: (error as Error).stack,
    });
    await edgeLogger.flush();

    // Attempt to audit the failure
    try {
      const user = await getUserFromRequest(req, supabase);
      if (user) {
        const orgIds = await getUserOrgIds(supabase, user.id);
        if (orgIds.length > 0) {
          await recordAudit(supabase, {
            organizationId: orgIds[0],
            action: 'scheduler.auto_failed',
            metadata: { error: (error as Error).message },
          });
        }
      }
    } catch {
      // Swallow — best effort audit on failure
    }

    return jsonResponse({ error: 'Internal server error', message: (error as Error).message }, 500);
  }
});
