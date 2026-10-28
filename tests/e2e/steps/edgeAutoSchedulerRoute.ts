/**
 * Answer the page's `auto-scheduler` request with the Edge Function's own solver.
 *
 * Mock mode has no Edge runtime, so a scenario that presses the practice page's
 * Run control would otherwise need a canned response -- which is how the Pillar
 * 1 practice scenario used to pass while asserting a result a step had written
 * (remediation plan M4.6). This route hands the request body the page sent to
 * the modules `supabase/functions/auto-scheduler/index.ts` calls, imported into
 * the test runner the way the Vitest witnesses do (`tests/autoSchedulerLock.test.js`),
 * and returns what the solver returns. Nothing here writes or edits a placement.
 *
 * **What is real:** the request schema (all of it: the mock seed's organization
 * and season ids are UUIDs, `frontend/src/lib/mockSeedIds.js`), the slots'
 * anchoring on the season clock, the team preparation, the lock classification,
 * the run's dating (M4.8: each slot read by `toDaylightSlot` as `index.ts`
 * reads it, here with no store row, so the body's first date and
 * `effectiveUntil` -- the page's own fallback -- and today on the season's
 * clock as `liveFrom`, returned as `index.ts` returns it) and
 * `runPracticeOptimizer`.
 *
 * **What is not exercised here** (the function's HTTP and database wrapper, which
 * the real-backend project of plan item M4.1 covers):
 * - auth, rate limiting, and the organization check;
 * - every read `index.ts` makes as the caller: the season's timezone (here the
 *   seeded season's, `SEASON_TIMEZONE`), the season lock (here the page's own
 *   `lockedAssignments`, which `index.ts` only cross-checks against its read),
 *   TIME TBD series, coach preferences, venue daylight and lighting overrides
 *   (none: the solver runs without them, as with an empty read). The one read made
 *   for real is each division's practice settings (Phase D PR B): `index.ts` reads
 *   them from the store as the caller, never from the body, so this route reads the
 *   page's own mock store the same way (`practiceSettingsFromMock`) and the
 *   division form's save is what the run then honours;
 * - the evaluation-run RPC, the audit rows and the progress channel.
 */
import type { Page, Route } from '@playwright/test';

import { AutoSchedulerInputSchema } from '../../../supabase/functions/_shared/schemas/auto-scheduler.js';
import {
  anchorWallTimes,
  describeAnchorFailure,
} from '../../../supabase/functions/_shared/timing/anchorWallTimes.js';
import { prepareTeam } from '../../../supabase/functions/_shared/engines/practice-coaches.js';
import { planTeamsForRun } from '../../../supabase/functions/_shared/engines/practice-lock.js';
import {
  applyPracticeSettings,
  parseTeamPracticeSettings,
} from '../../../supabase/functions/_shared/engines/practice-division-settings.js';
import {
  runPracticeOptimizer,
  SLOT_DATING_UNREADABLE,
  undatableSlotIds,
  unitIdOf,
} from '../../../supabase/functions/_shared/engines/auto-scheduler-solver.js';
import { toDaylightSlot } from '../../../supabase/functions/_shared/engines/practice-daylight.js';
import { seasonCalendarDate } from '../../../supabase/functions/_shared/engines/coach-preference-load.js';

/** The seeded season's clock: the value `index.ts` would read from `season_settings`. */
export const SEASON_TIMEZONE = 'America/Los_Angeles';

/** Every solver call this page made, for a scenario that needs to know it ran. */
export type EdgeSolverPage = Page & { __edgeSolverRuns?: number };

type MockRow = Record<string, unknown>;

/**
 * The settings of the run's teams, from the page's mock store: the teams of the season's latest
 * team run, each in the division of that name (or id) -- the join `index.ts` reads from `teams`.
 */
async function practiceSettingsFromMock(page: Page, teamIds: string[]) {
  const db = (await page.evaluate(() =>
    JSON.parse(sessionStorage.getItem('__MOCK_DB__') || '{}')
  )) as Record<string, MockRow[] | undefined>;
  const run = [...(db.scheduler_runs ?? [])]
    .filter((r) => r.run_type === 'team' && r.status !== 'deleted')
    .sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')))[0];
  const byDivision = ((run?.results as MockRow | undefined)?.teamsByDivision ?? {}) as Record<
    string,
    Array<{ id: string }>
  >;
  const rows: unknown[] = [];
  for (const [key, teams] of Object.entries(byDivision)) {
    const division = (db.divisions ?? []).find((d) => d.id === key || d.name === key);
    if (!division) continue;
    for (const team of teams) {
      if (teamIds.includes(team.id)) rows.push({ id: team.id, divisions: division });
    }
  }
  const parsed = parseTeamPracticeSettings(rows);
  if (!parsed.ok)
    throw new Error('message' in parsed ? parsed.message : 'practice settings unreadable');
  return parsed.byTeam;
}

async function fulfillJson(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

export async function routeAutoSchedulerToEdgeSolver(page: Page): Promise<void> {
  (page as EdgeSolverPage).__edgeSolverRuns = 0;
  await page.route('**/functions/v1/auto-scheduler', async (route) => {
    if (route.request().method() === 'OPTIONS') {
      await route.fulfill({ status: 204 });
      return;
    }

    const parsed = AutoSchedulerInputSchema.safeParse(
      JSON.parse(route.request().postData() || '{}')
    );
    if (!parsed.success) {
      // index.ts step 4's answer to the same body.
      await fulfillJson(route, { error: 'Validation failed', details: parsed.error.format() }, 400);
      return;
    }
    const input = parsed.data;

    // index.ts step 5b.
    // The schema's slot, as `index.ts` reads it under Deno's strict mode (this
    // repo type-checks with `strict: false`, which widens zod's inference).
    const wireSlots = input.slots as Array<{
      id: string;
      day?: string | null;
      start: unknown;
      end: unknown;
      capacity: number;
      baseSlotId?: string;
    }>;
    const anchored = anchorWallTimes(wireSlots, SEASON_TIMEZONE, 'slots');
    if (anchored.blocking.length > 0) {
      await fulfillJson(route, describeAnchorFailure(anchored.blocking), 422);
      return;
    }
    const slots = anchored.rows.map((s) => ({
      id: s.id,
      day: s.day ?? null,
      start: s.start,
      end: s.end,
      capacity: s.capacity,
      baseSlotId: s.baseSlotId,
    }));

    // index.ts step 5e-bis (M4.8): the run's dating, and its refusal.
    const liveFrom = seasonCalendarDate(Date.now(), SEASON_TIMEZONE);
    const datingSlots = new Map(
      anchored.rows.map((s) => [s.id, toDaylightSlot(s, SEASON_TIMEZONE, undefined)])
    );
    const undatable =
      liveFrom === null
        ? anchored.rows.map((s) => s.id)
        : undatableSlotIds(
            anchored.rows.map((s) => s.id),
            datingSlots
          );
    if (liveFrom === null || undatable.length > 0) {
      await fulfillJson(
        route,
        { error: 'slots could not be dated', code: SLOT_DATING_UNREADABLE, slotIds: undatable },
        422
      );
      return;
    }

    // index.ts step 5c, with the page's list standing in for the lock read.
    const lockRows = input.lockedAssignments.map((row) => ({
      id: row.id ?? '',
      teamId: row.teamId,
      slotId: row.slotId,
      effectiveDateRange: row.effectiveDateRange ?? null,
    }));
    const settings = applyPracticeSettings(
      input.teams,
      await practiceSettingsFromMock(
        page,
        input.teams.map((t) => t.id)
      )
    );
    const classification = planTeamsForRun(
      input.teams.map((t) => t.id),
      // The loader's row type carries more columns than the solver reads.
      lockRows as Parameters<typeof planTeamsForRun>[1],
      [],
      new Map(settings.teams.map((t) => [t.id, t.practicesPerWeek]))
    );

    // index.ts steps 7-9.
    const run = await runPracticeOptimizer({
      teams: settings.teams.map((t) => ({
        ...prepareTeam(t),
        practicesPerWeek: t.practicesPerWeek,
        practiceMinutes: t.practiceMinutes,
      })),
      slots,
      locked: lockRows.map((row) => ({
        assignmentId: row.id,
        teamId: row.teamId,
        slotId: row.slotId,
        effectiveDateRange: row.effectiveDateRange,
      })),
      placeableTeamIds: classification.placeable,
      unitsNeeded: classification.unitsNeeded,
      dating: { liveFrom, slots: datingSlots },
      config: input.config,
    });
    (page as EdgeSolverPage).__edgeSolverRuns =
      ((page as EdgeSolverPage).__edgeSolverRuns ?? 0) + 1;

    // index.ts step 13, the fields the solver produced.
    const placedByTeam = new Map<string, number>();
    for (const placement of run.placements) {
      placedByTeam.set(placement.teamId, (placedByTeam.get(placement.teamId) ?? 0) + 1);
    }
    await fulfillJson(route, {
      runId: null,
      assignments: run.placements.map((placement) => ({
        ...placement,
        effectiveDateRange: run.placementRanges[unitIdOf(placement)],
      })),
      lock: {
        lockedLoaded: lockRows.length,
        lockedOutsideRun: run.lockedOutsideRun.map((row) => row.assignmentId),
        endedRows: run.endedRows.map((row) => row.assignmentId),
        unreadableRange: run.unreadableRange.map((row) => row.assignmentId),
      },
      unassigned: run.unassigned.map((u) =>
        classification.targets[u.teamId] > 1
          ? { ...u, target: classification.targets[u.teamId] }
          : u
      ),
      practices: {
        teams: Object.keys(classification.targets)
          .filter((teamId) => classification.targets[teamId] > 1)
          .sort()
          .map((teamId) => {
            const placed = placedByTeam.get(teamId) ?? 0;
            const held = classification.held[teamId] ?? 0;
            return {
              teamId,
              target: classification.targets[teamId],
              held,
              placed,
              missing: Math.max(classification.targets[teamId] - held - placed, 0),
            };
          }),
        overTarget: classification.overTarget,
      },
      liveFrom: run.liveFrom,
      evaluation: run.evaluation,
      timingFindings: anchored.findings,
      optimization: {
        seedScore: run.seedScore,
        bestScore: run.bestScore,
        improvement: run.bestScore - run.seedScore,
        iterations: run.iterations,
        restarts: run.restarts,
        elapsedMs: run.elapsedMs,
        terminationReason: run.terminationReason,
      },
    });
  });
}
