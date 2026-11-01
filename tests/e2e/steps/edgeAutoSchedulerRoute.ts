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
 *
 * **The three modes** (Phase D PR D): a body names `solve` (the default), `prepare` or `verify`
 * exactly as `index.ts` reads it. `prepare` answers with the solver's input, encoded, and its digest;
 * the page's Web Worker -- the real one, in Chromium -- searches it; `verify` compares the digest
 * with the input this route builds again, refuses 409 `INPUT_CHANGED` when they differ, and
 * otherwise answers through the Edge function's own `verifyPracticePlacements` in `solve`'s shape.
 * So a scenario that presses the practice page's Run control now runs the search in the browser
 * and the check on the server, the way production does.
 */
import type { Page, Route } from '@playwright/test';

import {
  AutoSchedulerInputSchema,
  AutoSchedulerVerifySchema,
} from '../../../supabase/functions/_shared/schemas/auto-scheduler.js';
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
  verifyPracticePlacements,
  type OptimizerResult,
  type PracticeSolverInput,
} from '../../../supabase/functions/_shared/engines/auto-scheduler-solver.js';
import {
  checkSolverInputDigest,
  digestEncodedInput,
  encodeSolverInput,
  INPUT_CHANGED,
} from '../../../supabase/functions/_shared/engines/solver-input.js';
import { toDaylightSlot } from '../../../supabase/functions/_shared/engines/practice-daylight.js';
import { seasonCalendarDate } from '../../../supabase/functions/_shared/engines/coach-preference-load.js';

/** The seeded season's clock: the value `index.ts` would read from `season_settings`. */
export const SEASON_TIMEZONE = 'America/Los_Angeles';

/**
 * Every answer this page was given with a schedule in it -- a `solve`, or a `verify` of the browser's
 * -- for a scenario that needs to know the function ran. `__edgeSolverModes` lists the modes of every
 * request in order; `__edgeHoldPrepare`, when a scenario sets it, is awaited before `prepare` is
 * answered (to leave a run in progress long enough to cancel it).
 */
export type EdgeSolverPage = Page & {
  __edgeSolverRuns?: number;
  __edgeSolverModes?: string[];
  __edgeHoldPrepare?: Promise<void>;
};

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
  (page as EdgeSolverPage).__edgeSolverModes = [];
  await page.route('**/functions/v1/auto-scheduler', async (route) => {
    if (route.request().method() === 'OPTIONS') {
      await route.fulfill({ status: 204 });
      return;
    }

    const body = JSON.parse(route.request().postData() || '{}');
    const parsed = AutoSchedulerInputSchema.safeParse(body);
    if (!parsed.success) {
      // index.ts step 4's answer to the same body.
      await fulfillJson(route, { error: 'Validation failed', details: parsed.error.format() }, 400);
      return;
    }
    const input = parsed.data;
    (page as EdgeSolverPage).__edgeSolverModes?.push(input.mode);

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

    // index.ts step 6: the run's whole input, whichever mode uses it.
    const solverInput: PracticeSolverInput = {
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
    };
    const scope = {
      organizationId: input.organizationId,
      seasonSettingsId: input.seasonSettingsId ?? '',
    };

    // index.ts step 6a: prepare. Nothing is searched; the page's worker does that.
    if (input.mode === 'prepare') {
      const encoded = encodeSolverInput(solverInput, scope);
      await (page as EdgeSolverPage).__edgeHoldPrepare;
      await fulfillJson(route, {
        mode: 'prepare',
        digest: await digestEncodedInput(encoded),
        input: encoded,
        liveFrom,
      });
      return;
    }

    // index.ts steps 6b and 8-9: the server's own search, or its check of the worker's.
    let run: OptimizerResult;
    let verified: { digest: string; refused: unknown[] } | null = null;
    if (input.mode === 'verify') {
      const claims = AutoSchedulerVerifySchema.safeParse(body);
      if (!claims.success) {
        await fulfillJson(
          route,
          { error: 'Validation failed', details: claims.error.format() },
          400
        );
        return;
      }
      const digestCheck = await checkSolverInputDigest(
        encodeSolverInput(solverInput, scope),
        claims.data.digest
      );
      if (!digestCheck.ok) {
        await fulfillJson(route, { error: 'The season changed', code: INPUT_CHANGED }, 409);
        return;
      }
      const checked = verifyPracticePlacements({
        ...solverInput,
        placements: claims.data.placements,
      });
      verified = { digest: claims.data.digest, refused: checked.refused };
      run = {
        ...checked,
        seedScore: claims.data.browserRun.seedScore,
        iterations: claims.data.browserRun.iterations,
        restarts: claims.data.browserRun.restarts,
        elapsedMs: Math.round(claims.data.browserRun.elapsedMs),
        terminationReason: claims.data.browserRun.terminationReason,
      };
    } else {
      run = await runPracticeOptimizer({ ...solverInput, config: input.config });
    }
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
      ...(verified ? { verified } : {}),
    });
  });
}
