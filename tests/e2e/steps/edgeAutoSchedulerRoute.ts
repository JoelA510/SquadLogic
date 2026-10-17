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
 * anchoring on the season clock, the team preparation, the lock classification
 * and `runPracticeOptimizer`.
 *
 * **What is not exercised here** (the function's HTTP and database wrapper, which
 * the real-backend project of plan item M4.1 covers):
 * - auth, rate limiting, and the organization check;
 * - every read `index.ts` makes as the caller: the season's timezone (here the
 *   seeded season's, `SEASON_TIMEZONE`), the season lock (here the page's own
 *   `lockedAssignments`, which `index.ts` only cross-checks against its read),
 *   TIME TBD series, coach preferences, venue daylight and lighting overrides
 *   (none: the solver runs without them, as with an empty read);
 * - the evaluation-run RPC, the audit rows and the progress channel.
 */
import type { Page, Route } from '@playwright/test';

import { AutoSchedulerInputSchema } from '../../../supabase/functions/_shared/schemas/auto-scheduler.js';
import {
  anchorWallTimes,
  describeAnchorFailure,
} from '../../../supabase/functions/_shared/timing/anchorWallTimes.js';
import { prepareTeam } from '../../../supabase/functions/_shared/engines/practice-coaches.js';
import { classifyTeamsForRun } from '../../../supabase/functions/_shared/engines/practice-lock.js';
import { runPracticeOptimizer } from '../../../supabase/functions/_shared/engines/auto-scheduler-solver.js';

/** The seeded season's clock: the value `index.ts` would read from `season_settings`. */
export const SEASON_TIMEZONE = 'America/Los_Angeles';

/** Every solver call this page made, for a scenario that needs to know it ran. */
export type EdgeSolverPage = Page & { __edgeSolverRuns?: number };

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

    // index.ts step 5c, with the page's list standing in for the lock read.
    const lockRows = input.lockedAssignments.map((row) => ({
      id: row.id ?? '',
      teamId: row.teamId,
      slotId: row.slotId,
      effectiveDateRange: row.effectiveDateRange ?? null,
    }));
    const classification = classifyTeamsForRun(
      input.teams.map((t) => t.id),
      // The loader's row type carries more columns than the solver reads.
      lockRows as Parameters<typeof classifyTeamsForRun>[1],
      []
    );

    // index.ts steps 7-9.
    const run = await runPracticeOptimizer({
      teams: input.teams.map((t) => prepareTeam(t)),
      slots,
      locked: lockRows.map((row) => ({
        assignmentId: row.id,
        teamId: row.teamId,
        slotId: row.slotId,
        effectiveDateRange: row.effectiveDateRange,
      })),
      placeableTeamIds: classification.placeable,
      config: input.config,
    });
    (page as EdgeSolverPage).__edgeSolverRuns =
      ((page as EdgeSolverPage).__edgeSolverRuns ?? 0) + 1;

    // index.ts step 13, the fields the solver produced.
    await fulfillJson(route, {
      runId: null,
      assignments: run.placements,
      unassigned: run.unassigned,
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
