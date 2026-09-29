/**
 * Edge Function: auto-scheduler
 *
 * Phase 8 — Intelligent Auto-Scheduler.
 * Runs a Hill Climbing optimization loop on the server, scoring candidates
 * via `_shared/engines/scoring-engine.ts` and persisting the best result via
 * the persist_evaluation_run RPC.
 *
 * That engine used to be described here as "the isomorphic scoring-engine",
 * which was never true and hid a real divergence for months. It is a second,
 * narrower implementation of `packages/core`'s `evaluatePracticeSchedule`
 * (core publishes thirteen top-level keys, this one six), written separately
 * because an Edge Function cannot import `packages/core`. What the two arms
 * actually promise each other is stated and enforced in
 * `tests/scoringEngineDrift.test.js`, which runs both over one vector table.
 *
 * Security: JWT auth, org membership verification, rate limiting, IDOR prevention.
 * Governance: Every run produces an evaluation_run record and audit trail.
 *
 * The lock (8.6 PR 3b PR 7, operator ruling 2): every practice already
 * assigned is locked. This function loads the season's current
 * `practice_assignments` itself, AS THE CALLER through RLS, locks every row,
 * refuses the run if the client's `lockedAssignments` disagrees, and places
 * only roster teams with no row -- never a team whose series is TIME TBD
 * (decision 4). It returns only those new placements. Limitation: there is no
 * date model here, so a locked row consumes its slot for the whole season --
 * never a double-booking, possibly an under-used slot. See
 * `_shared/engines/practice-lock.ts` and `_shared/engines/auto-scheduler-solver.ts`.
 *
 * Coach preferences (8.6 PR 3b PR 8, plan §4 and §5 decision 3): approved
 * `coach_practice_preferences`, with coaches from `team_coach_assignments`
 * current on the season's date, are loaded here -- AS THE CALLER through RLS,
 * never from the request body. `must_keep` is a hard filter on new
 * placements (a team it leaves with no legal slot is unplaced with reason
 * `coach-preference`); `prefer_keep` is a lexicographic tiebreak, fewer
 * breaches first. Locked rows are never judged. A failed or partial read
 * refuses the run. See `_shared/engines/coach-preference-load.ts`.
 *
 * Daylight (8.9 PR 6, plan §3): each venue's `lighting_available` and
 * coordinates are loaded by `fieldId` (fields -> locations) -- AS THE CALLER
 * through RLS, never from the request body; a failed read refuses the run.
 * The solver's post-pass truncates each NEW placement at its first date past
 * `floor(sunset)` on unlit ground, the remainder TIME TBD (D8); an unlit
 * venue with no coordinates is flagged and counted, not refused (D4); a
 * locked row past sunset is reported with a proposed fix, never changed.
 * See `_shared/engines/practice-daylight.ts`.
 *
 * Portable-lighting overrides (8.9 D14 PR C): approved
 * `practice_lighting_overrides` on the run's slots, loaded as the caller
 * through RLS and never from the body, exempt their dates from the daylight
 * pass. A failed read refuses the run; a partial read (a coach sees only the
 * slots they coach) only removes exemptions, so it fails safe and runs, and
 * the response and audit say whose view it was (`lightingOverrideRead`). See
 * `_shared/engines/practice-lighting-overrides.ts`.
 */

import { serve } from 'https://deno.land/std@0.223.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.3';
import { AutoSchedulerInputSchema } from '../_shared/schemas/auto-scheduler.ts';
import { prepareTeam } from '../_shared/engines/practice-coaches.ts';
import {
  loadCoachPreferenceContext,
  seasonCalendarDate,
  seasonRunDate,
} from '../_shared/engines/coach-preference-load.ts';
import { loadVenueDaylight, toDaylightSlot } from '../_shared/engines/practice-daylight.ts';
import { loadLightingOverrides } from '../_shared/engines/practice-lighting-overrides.ts';
import { runPracticeOptimizer } from '../_shared/engines/auto-scheduler-solver.ts';
import {
  classifyTeamsForRun,
  crossCheckLockedAssignments,
  describeLockMismatch,
  loadSeasonPracticeLock,
  TIME_TBD_EXCLUDED_REASON,
} from '../_shared/engines/practice-lock.ts';
import { anchorWallTimes, describeAnchorFailure } from '../_shared/timing/anchorWallTimes.ts';
import { readSeasonTimezone } from '../_shared/timing/seasonSettings.ts';
import {
  createUserClient,
  getUserFromRequest,
  getUserOrgIds,
  verifyOrgAdmin,
  verifyOrgMembership,
  corsHeaders,
  jsonResponse,
  recordAudit,
  recordAuditNow,
} from '../_shared/auth.ts';
import { checkRateLimit } from '../_shared/rateLimit.ts';
import { edgeLogger } from '../_shared/logtail.ts';

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
  // The lock is read AS THE CALLER (RLS decides), never with the service role.
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
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

    // 5a. The lock is scoped by season (the writer's scope: teams whose
    //     division belongs to it). Without a season id this function cannot
    //     know which rows are locked, so it refuses rather than guess one.
    if (!input.seasonSettingsId) {
      return jsonResponse(
        {
          error:
            'A season is required: the practices already assigned in it are locked, and ' +
            'without one they cannot be read.',
          code: 'SEASON_REQUIRED_FOR_LOCK',
        },
        422
      );
    }
    const seasonSettingsId = input.seasonSettingsId;

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
    const season = await readSeasonTimezone(supabase, input.organizationId, seasonSettingsId);
    if (season.errored) {
      edgeLogger.error('Auto-scheduler could not read the season timezone', {
        orgId: input.organizationId,
        seasonSettingsId,
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
      // `recordAuditNow`, not `recordAudit`: this path returns immediately,
      // and `recordAudit` is fire-and-forget returning `void`, so awaiting it
      // waits for nothing and the isolate can be frozen before the insert
      // lands. A refusal is the audit row most worth keeping.
      await recordAuditNow(supabase, {
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

    // 5c. THE LOCK (plan §3). Load the season's current practice_assignments
    //     as the calling user, through RLS, and lock every row.
    const lock = await loadSeasonPracticeLock(createUserClient(req, supabaseUrl, anonKey), {
      organizationId: input.organizationId,
      seasonSettingsId,
    });
    if (!lock.ok) {
      edgeLogger.error('Auto-scheduler could not read the practice lock', {
        orgId: input.organizationId,
        seasonSettingsId,
        message: lock.message,
      });
      await edgeLogger.flush();
      return jsonResponse(
        {
          error:
            "The season's current practice assignments could not be read, so the run was " +
            'refused rather than scheduled over practices that are locked.',
          code: 'PRACTICE_LOCK_UNREADABLE',
        },
        503
      );
    }

    //     The client's list is a cross-check only: a mismatch in either
    //     direction means the page is looking at a different schedule.
    const lockCheck = crossCheckLockedAssignments(lock.rows, input.lockedAssignments);
    if (!lockCheck.ok) {
      edgeLogger.error('Auto-scheduler refused: locked assignments do not match', {
        orgId: input.organizationId,
        seasonSettingsId,
        missingFromClient: lockCheck.missingFromClient,
        unknownToServer: lockCheck.unknownToServer,
        differing: lockCheck.differing,
        withoutId: lockCheck.withoutId,
      });
      await recordAuditNow(supabase, {
        organizationId: input.organizationId,
        action: 'scheduler.auto_refused',
        resourceType: 'practice_schedule',
        metadata: {
          reason: 'LOCKED_ASSIGNMENTS_MISMATCH',
          lockedLoaded: lock.rows.length,
          lockedSentByClient: input.lockedAssignments.length,
          missingFromClient: lockCheck.missingFromClient,
          unknownToServer: lockCheck.unknownToServer,
          differing: lockCheck.differing,
          withoutId: lockCheck.withoutId,
        },
      });
      await edgeLogger.flush();
      return jsonResponse(
        {
          error: describeLockMismatch(lockCheck),
          code: 'LOCKED_ASSIGNMENTS_MISMATCH',
          missingFromClient: lockCheck.missingFromClient,
          unknownToServer: lockCheck.unknownToServer,
          differing: lockCheck.differing,
          withoutId: lockCheck.withoutId,
        },
        409
      );
    }

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

    //     Every roster team lands in exactly one of: placeable (no row, no
    //     TIME TBD series), locked (has a row), TIME TBD (excluded; decision 4).
    const classification = classifyTeamsForRun(
      input.teams.map((t) => t.id),
      lock.rows,
      lock.timeTbdTeamIds
    );

    // 5d. COACH PREFERENCES (plan §4). Approved rows, and the coaches current
    //     on the season's date, loaded as the caller through RLS. A failed or
    //     partial read refuses the run: it never runs as if there were none.
    const preferences = await loadCoachPreferenceContext(
      createUserClient(req, supabaseUrl, anonKey),
      supabase,
      {
        organizationId: input.organizationId,
        runDate: seasonRunDate(Date.now(), season.timezone),
        placeableTeamIds: classification.placeable,
        slotIds: slots.map((s) => s.id),
      }
    );
    if (!preferences.ok) {
      edgeLogger.error('Auto-scheduler could not read coach preferences', {
        orgId: input.organizationId,
        seasonSettingsId,
        code: preferences.code,
        message: preferences.message,
      });
      await recordAuditNow(supabase, {
        organizationId: input.organizationId,
        action: 'scheduler.auto_refused',
        resourceType: 'practice_schedule',
        metadata: { reason: preferences.code, message: preferences.message },
      });
      await edgeLogger.flush();
      return jsonResponse(
        {
          error:
            'Approved coach preferences could not be read in full, so the run was refused ' +
            `rather than scheduled as if there were none (${preferences.message}).`,
          code: preferences.code,
        },
        // Invisible rows are a permission condition, not an outage: retrying
        // cannot help; an org admin (who reads every row) can run it.
        preferences.code === 'COACH_PREFERENCES_NOT_VISIBLE' ? 403 : 503
      );
    }

    // 5e. DAYLIGHT (8.9 PR 6). Venue lighting and coordinates, by the slots'
    //     stored field (practice_slots -> fields -> locations), loaded as the
    //     caller through RLS -- never from the body. `toDaylightSlot` reads
    //     only the slot's instants and, where the store has no end date, its
    //     `effectiveUntil`, so a venue, coordinate or lighting key on a body
    //     slot is never seen (W9).
    const venueDaylight = await loadVenueDaylight(createUserClient(req, supabaseUrl, anonKey), {
      organizationId: input.organizationId,
      slotIds: anchored.rows.map((s) => s.id),
    });
    if (!venueDaylight.ok) {
      edgeLogger.error('Auto-scheduler could not read venue lighting', {
        orgId: input.organizationId,
        seasonSettingsId,
        message: venueDaylight.message,
      });
      await recordAuditNow(supabase, {
        organizationId: input.organizationId,
        action: 'scheduler.auto_refused',
        resourceType: 'practice_schedule',
        metadata: { reason: venueDaylight.code, message: venueDaylight.message },
      });
      await edgeLogger.flush();
      return jsonResponse(
        {
          error:
            "The practice venues' lighting and coordinates could not be read, so the run was " +
            `refused rather than scheduled without a daylight check (${venueDaylight.message}).`,
          code: venueDaylight.code,
        },
        503
      );
    }

    // 5f. PORTABLE LIGHTING (8.9 D14 PR C). Approved overrides on the run's
    //     slots, loaded as the caller through RLS -- never from the body
    //     (W25). A failed read refuses (W26): it never runs as if there were
    //     none. A partial read is not refused: a row the caller cannot see
    //     only leaves its dates judged, so the run can come out stricter than
    //     the data allows, never looser.
    const lightingOverrides = await loadLightingOverrides(
      createUserClient(req, supabaseUrl, anonKey),
      { organizationId: input.organizationId, slotIds: anchored.rows.map((s) => s.id) }
    );
    if (!lightingOverrides.ok) {
      edgeLogger.error('Auto-scheduler could not read lighting overrides', {
        orgId: input.organizationId,
        seasonSettingsId,
        message: lightingOverrides.message,
      });
      await recordAuditNow(supabase, {
        organizationId: input.organizationId,
        action: 'scheduler.auto_refused',
        resourceType: 'practice_schedule',
        metadata: { reason: lightingOverrides.code, message: lightingOverrides.message },
      });
      await edgeLogger.flush();
      return jsonResponse(
        {
          error:
            'Approved portable-lighting overrides could not be read, so the run was refused ' +
            `rather than scheduled as if there were none (${lightingOverrides.message}).`,
          code: lightingOverrides.code,
        },
        503
      );
    }
    //     Disclosed, not refused: an org admin's read is every approved row;
    //     anyone else's is the rows on slots they coach, so the run may be
    //     stricter than the data. Membership only -- no override content is
    //     read with the service role.
    const lightingOverrideRead = {
      loaded: lightingOverrides.rowsLoaded,
      onRunSlots: lightingOverrides.overrides.length,
      visibility: (await verifyOrgAdmin(supabase, user.id, input.organizationId))
        ? ('organization' as const)
        : ('caller-scoped' as const),
    };

    // 6. Audit + structured logging: scheduler started
    edgeLogger.info('Auto-scheduler invoked', {
      userId: user.id,
      orgId: input.organizationId,
      teamCount: input.teams.length,
      slotCount: input.slots.length,
      lockedLoaded: lock.rows.length,
      placeableTeams: classification.placeable.length,
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
        lockedLoaded: lock.rows.length,
        placeableTeams: classification.placeable.length,
        timeTbdExcluded: classification.timeTbd.length,
        approvedPreferencesLoaded: preferences.preferencesLoaded,
        teamsConstrainedByPreferences: preferences.teamsConstrained,
        coachAssignmentsLoaded: preferences.coachAssignmentsLoaded,
        lightingOverrideRead,
        config: input.config,
      },
    });

    // 7. Prepare data (the slots were prepared at 5c-bis, before the
    //    preference load that judges them).
    const teams = input.teams.map((t) => prepareTeam(t));

    // 8-9. Greedy seed + hill climbing over the placeable teams only. Every
    //      loaded row -- a TIME TBD series' row included -- is fixed
    //      occupancy, one entry per ROW.
    const run = await runPracticeOptimizer({
      teams,
      slots,
      locked: lock.rows.map((row) => ({
        assignmentId: row.id,
        teamId: row.teamId,
        slotId: row.slotId,
        effectiveDateRange: row.effectiveDateRange,
      })),
      placeableTeamIds: classification.placeable,
      preferenceGate: preferences.gate,
      daylight: {
        slots: new Map(
          anchored.rows.map((s) => [
            s.id,
            toDaylightSlot(s, season.timezone, venueDaylight.slots.get(s.id)),
          ])
        ),
        venues: venueDaylight.venues,
        timeZone: season.timezone,
        today: seasonCalendarDate(Date.now(), season.timezone),
        lightingOverrides: lightingOverrides.overrides,
      },
      config: input.config,
      onProgress: (progress) => {
        // Emit progress audit (fire-and-forget). `recordAudit` returns `void`
        // and swallows its own failures; the `.catch` that used to trail this
        // call was a TypeError on `undefined` at every 100th iteration.
        recordAudit(supabase, {
          organizationId: input.organizationId,
          action: 'scheduler.auto_progress',
          resourceType: 'practice_schedule',
          metadata: progress,
        });
      },
    });
    const bestAssignments = run.placements;
    const bestUnassigned = run.unassigned;
    const bestScore = run.bestScore;
    const iteration = run.iterations;
    const totalElapsedMs = run.elapsedMs;
    const terminationReason = run.terminationReason;
    // Always present: the solver was given a daylight context above.
    const daylight = run.daylight!;
    const warningCount =
      bestUnassigned.length +
      daylight.timeTbd.filter((t) => !t.withdrawn).length +
      daylight.unknown.length +
      daylight.lockedPastSunset.length;
    const timeTbdExcluded = classification.timeTbd.map((teamId) => ({
      teamId,
      reason: TIME_TBD_EXCLUDED_REASON,
    }));

    // 10. Persist evaluation run via RPC
    const runData = {
      organization_id: input.organizationId,
      admin_id: user.id,
      execution_time_ms: totalElapsedMs,
      scheduler_run_type: 'practice' as const,
      season_settings_id: seasonSettingsId,
      // A daylight finding (TIME TBD remainder, unknown sunset, locked row
      // past sunset) is a warning like an unplaced team.
      status: warningCount === 0 ? 'completed' : 'completed_with_warnings',
      findings_severity: warningCount > 0 ? 'warnings' : 'none',
      metrics_summary: {
        seedScore: run.seedScore,
        bestScore,
        improvement: bestScore - run.seedScore,
        iterations: iteration,
        restarts: run.restarts,
        terminationReason,
        teamCount: teams.length,
        lockedLoaded: lock.rows.length,
        placementsProposed: bestAssignments.length,
        timeTbdExcluded: timeTbdExcluded.length,
        assignedCount: bestAssignments.length,
        unassignedCount: bestUnassigned.length,
        approvedPreferencesLoaded: preferences.preferencesLoaded,
        preferKeepBreaches: run.preferKeepBreaches,
        daylight: daylight.meta,
      },
      input_snapshot: {
        teamCount: teams.length,
        slotCount: slots.length,
        lockedCount: lock.rows.length,
        seed: input.config.seed,
      },
      created_by: user.id,
      started_at: new Date(Date.now() - totalElapsedMs).toISOString(),
      completed_at: new Date().toISOString(),
    };

    const findings = bestUnassigned.map((u) => ({
      severity: 'warning',
      finding_code: 'UNASSIGNED_TEAM',
      description:
        `Team ${u.teamId} could not be assigned: ${u.reason}` +
        (u.dimensions?.length ? ` (must_keep ${u.dimensions.join(', ')})` : ''),
      affected_entities: [{ teamId: u.teamId, reason: u.reason, dimensions: u.dimensions ?? [] }],
    }));
    // Daylight: every TIME TBD remainder, unjudged sunset and locked row past
    // sunset is a finding, so the run's record carries what the page shows.
    const daylightFindings = [
      ...daylight.timeTbd.map((tbd) => ({
        severity: 'warning',
        finding_code: 'DAYLIGHT_TIME_TBD',
        description:
          `Team ${tbd.teamId} practices past sunset in slot ${tbd.slotId} from ${tbd.from}: ` +
          `TIME TBD ${tbd.from}..${tbd.until}` +
          (tbd.withdrawn ? ' (no date before it remained)' : ''),
        affected_entities: [tbd],
      })),
      ...daylight.unknown.map((unknown) => ({
        severity: 'warning',
        finding_code: 'DAYLIGHT_UNKNOWN',
        description: `Sunset could not be judged for team ${unknown.teamId} in slot ${unknown.slotId}: ${unknown.cause}`,
        affected_entities: [unknown],
      })),
      ...daylight.lockedPastSunset.map((locked) => ({
        severity: 'warning',
        finding_code: 'LOCKED_PRACTICE_PAST_SUNSET',
        description:
          `Locked practice ${locked.assignmentId} (team ${locked.teamId}) runs past sunset from ` +
          `${locked.date}; proposed, not applied: ` +
          (locked.proposedFix.effectiveUntil
            ? `end it ${locked.proposedFix.effectiveUntil}`
            : 'make the whole row TIME TBD'),
        affected_entities: [locked],
      })),
    ];

    const metrics = [
      {
        metric_key: 'optimization_best_score',
        metric_value: bestScore,
        thresholds: { min: 0.8, target: 0.95 },
      },
      {
        metric_key: 'optimization_seed_score',
        metric_value: run.seedScore,
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
      p_findings: [...findings, ...daylightFindings],
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
        // The lock, as this run saw it: rows loaded (every one locked) and the
        // placements proposed for teams with no row.
        lockedLoaded: lock.rows.length,
        placementsProposed: bestAssignments.length,
        timeTbdExcluded: timeTbdExcluded.length,
        lockedOutsideRun: run.lockedOutsideRun.length,
        assignedCount: bestAssignments.length,
        unassignedCount: bestUnassigned.length,
        approvedPreferencesLoaded: preferences.preferencesLoaded,
        teamsConstrainedByPreferences: preferences.teamsConstrained,
        coachPreferenceTbd: bestUnassigned.filter((u) => u.reason === 'coach-preference').length,
        preferKeepBreaches: run.preferKeepBreaches,
        // The daylight post-pass, audited: its counts, every TIME TBD
        // remainder with its date, and every locked row it reported.
        daylight: daylight.meta,
        daylightTimeTbd: daylight.timeTbd.map((t) => ({
          teamId: t.teamId,
          slotId: t.slotId,
          from: t.from,
          until: t.until,
          reason: t.reason,
          withdrawn: t.withdrawn,
        })),
        daylightLockedPastSunset: daylight.lockedPastSunset.map((l) => ({
          assignmentId: l.assignmentId,
          date: l.date,
        })),
        lightingOverrideRead,
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
        // New placements ONLY, for roster teams with no current row. Locked
        // rows are never returned: the page keeps its own, unchanged.
        assignments: bestAssignments,
        unassigned: bestUnassigned,
        // Every roster team is accounted for: placed above, unplaced with a
        // reason above, locked (counted here), or TIME TBD (excluded, decision 4).
        lock: {
          lockedLoaded: lock.rows.length,
          lockedTeams: classification.locked.length,
          lockedOutsideRun: run.lockedOutsideRun.map((row) => row.assignmentId),
          timeTbdExcluded,
        },
        // The approved coach preferences this run honoured, as loaded
        // server-side: how many, the run date they were current on, the
        // prefer_keep breaches the placements carry, and every finding (a
        // conflict, or a preference with nothing to keep).
        approvedPreferences: {
          runDate: preferences.runDate,
          loaded: preferences.preferencesLoaded,
          teamsConstrained: preferences.teamsConstrained,
          preferKeepBreaches: run.preferKeepBreaches,
          findings: preferences.findings,
        },
        // The daylight post-pass (8.9 PR 6): counts, each TIME TBD remainder
        // (a truncated placement carries its new `effectiveUntil`), each
        // placement or locked row whose sunset is unknown (D4: flagged, never
        // allowed), and each locked row past sunset with its proposed,
        // unapplied fix. Always present.
        daylight,
        // The portable-lighting overrides the pass was given (8.9 D14 PR C):
        // approved rows read, those on this run's slots, and whose view.
        lightingOverrideRead,
        evaluation: run.evaluation,
        // Non-blocking timing findings -- today only WALL_TIME_AMBIGUOUS, a
        // wall time that occurs twice on a fall-back night and was resolved to
        // its first occurrence. Reported rather than swallowed: the instant is
        // real, and an operator scheduling into a repeated hour wants to know.
        // Always present (as `[]` when clean) so a consumer cannot mistake
        // "none" for "this build does not report them".
        timingFindings: anchored.findings,
        optimization: {
          seedScore: run.seedScore,
          bestScore,
          improvement: bestScore - run.seedScore,
          iterations: iteration,
          restarts: run.restarts,
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
