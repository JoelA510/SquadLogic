/**
 * The auto-scheduler's solver: greedy seed + hill climbing.
 *
 * Moved out of `auto-scheduler/index.ts` unchanged in its search (8.6 PR 3b
 * PR 7) so the lock witness (`tests/autoSchedulerLock.test.js`) can execute
 * it; `index.ts` imports `serve` at module load and cannot be imported by a
 * test. What changed is how locked rows are held:
 *
 * **Locked rows are a LIST, never a map keyed by team.** The old solver put
 * every assignment -- locked or not -- into one `Map<teamId, slotId>`, so a
 * team holding two rows (two weekdays, 176 of 281 pairs in the season-2026
 * corpus) collapsed to its last one and the other slot read as free. Locked
 * rows are now fixed occupancy: each row consumes one unit of its own slot's
 * capacity and blocks its team's coaches at that slot's time, and nothing in
 * the search can move, remove or re-range one. Only `placeable` teams (no row,
 * no TIME TBD series: see `practice-lock.ts`) are searched, and only their
 * placements are returned.
 *
 * Limitation (plan §3): no date model. A locked row occupies its slot for the
 * whole season, so the run never double-books but may under-use a slot.
 */
import { evaluatePracticeSchedule } from './scoring-engine.ts';
import { checkHardConstraints, type PreparedTeam, type TimeWindow } from './practice-coaches.ts';

export type SchedulerTeam = PreparedTeam & { division: string };

export interface SchedulerSlot {
  id: string;
  day?: string | null;
  start: Date;
  end: Date;
  capacity: number;
  baseSlotId?: string;
}

/** One locked row's occupancy. One entry per ROW, so a team may appear twice. */
export interface LockedOccupant {
  assignmentId: string;
  teamId: string;
  slotId: string | null;
}

export interface Placement {
  teamId: string;
  slotId: string;
  source: 'auto';
}

export interface Unplaced {
  teamId: string;
  reason: string;
}

type CoachPreferences = Record<string, { unavailableSlotIds?: string[] }>;

// ---------------------------------------------------------------------------
// Seeded PRNG (mulberry32)
// ---------------------------------------------------------------------------

export function createPRNG(seed: number): () => number {
  let state = seed | 0;
  return function mulberry32(): number {
    state += 0x6d2b79f5;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Locked occupancy
// ---------------------------------------------------------------------------

export interface BaseOccupancy {
  /** Remaining capacity per slot after every locked row took its unit. */
  slotCapacity: Map<string, number>;
  /** Coach windows held by locked rows. */
  coachAssignments: Map<string, TimeWindow[]>;
  /** Locked rows that occupy a slot of this run (scored as `locked`). */
  inRun: LockedOccupant[];
  /**
   * Locked rows whose slot is not among this run's slots: still locked, but
   * this run holds no time for that slot, so neither its capacity nor its
   * coaches' window can be counted. Reported (`lock.lockedOutsideRun`), never
   * silently treated as free or as clashing.
   */
  outsideRun: LockedOccupant[];
}

/**
 * Every locked row, one at a time. Iterating the list -- not a team-keyed
 * collection -- is what keeps a two-row team's both slots occupied.
 */
export function buildLockedOccupancy(
  locked: LockedOccupant[],
  teamsById: Map<string, SchedulerTeam>,
  slotsById: Map<string, SchedulerSlot>
): BaseOccupancy {
  const slotCapacity = new Map([...slotsById.values()].map((s) => [s.id, s.capacity]));
  const coachAssignments = new Map<string, TimeWindow[]>();
  const inRun: LockedOccupant[] = [];
  const outsideRun: LockedOccupant[] = [];
  for (const row of locked) {
    const slot = row.slotId ? slotsById.get(row.slotId) : undefined;
    if (!slot) {
      outsideRun.push(row);
      continue;
    }
    inRun.push(row);
    slotCapacity.set(slot.id, (slotCapacity.get(slot.id) ?? 0) - 1);
    const team = teamsById.get(row.teamId);
    if (!team) continue;
    for (const coachId of team.coachIds) {
      const existing = coachAssignments.get(coachId) ?? [];
      existing.push({ teamId: row.teamId, slotId: slot.id, start: slot.start, end: slot.end });
      coachAssignments.set(coachId, existing);
    }
  }
  return { slotCapacity, coachAssignments, inRun, outsideRun };
}

// ---------------------------------------------------------------------------
// Scoring wrapper
// ---------------------------------------------------------------------------

interface ScoringResult {
  score: number;
  evaluation: ReturnType<typeof evaluatePracticeSchedule>;
}

function scoreSchedule(
  base: BaseOccupancy,
  placements: Placement[],
  unassigned: Unplaced[],
  teams: SchedulerTeam[],
  slots: SchedulerSlot[]
): ScoringResult {
  // The whole schedule is measured -- locked rows and new placements -- so
  // coverage and coach conflicts are the season's, not the proposal's alone.
  const assignments = [
    ...base.inRun.map((row) => ({
      teamId: row.teamId,
      slotId: row.slotId as string,
      source: 'locked',
    })),
    ...placements,
  ];
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
  /** Placeable teams only. A locked team is never a key here. */
  assignmentMap: Map<string, string>;
  autoTeams: string[];
  slotsById: Map<string, SchedulerSlot>;
  teamsById: Map<string, SchedulerTeam>;
  slotCapacity: Map<string, number>;
  coachAssignments: Map<string, TimeWindow[]>;
  coachPreferences: CoachPreferences;
  placeableTeamIds: string[];
  unassignedTeamIds: string[];
}

function cloneWindows(source: Map<string, TimeWindow[]>): Map<string, TimeWindow[]> {
  const copy = new Map<string, TimeWindow[]>();
  for (const [k, v] of source) copy.set(k, [...v]);
  return copy;
}

function buildState(
  base: BaseOccupancy,
  placements: Placement[],
  placeableTeamIds: string[],
  teamsById: Map<string, SchedulerTeam>,
  slotsById: Map<string, SchedulerSlot>,
  coachPreferences: CoachPreferences
): OptimizerState {
  const assignmentMap = new Map<string, string>();
  const autoTeams: string[] = [];
  for (const a of placements) {
    assignmentMap.set(a.teamId, a.slotId);
    autoTeams.push(a.teamId);
  }

  const slotCapacity = new Map(base.slotCapacity);
  const coachAssignments = cloneWindows(base.coachAssignments);
  for (const [teamId, slotId] of assignmentMap) {
    slotCapacity.set(slotId, (slotCapacity.get(slotId) ?? 0) - 1);
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
    autoTeams,
    slotsById,
    teamsById,
    slotCapacity,
    coachAssignments,
    coachPreferences,
    placeableTeamIds,
    unassignedTeamIds: placeableTeamIds.filter((id) => !assignmentMap.has(id)),
  };
}

function tryMutate(
  state: OptimizerState,
  rand: () => number
): { placements: Placement[]; unassigned: Unplaced[]; type: string } | null {
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
  const newCoach = cloneWindows(state.coachAssignments);

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

  const placements = [...newMap.entries()]
    .map(([teamId, slotId]) => ({ teamId, slotId, source: 'auto' as const }))
    .sort((a, b) => a.teamId.localeCompare(b.teamId));

  const unassigned = state.placeableTeamIds
    .filter((id) => !newMap.has(id))
    .map((teamId) => ({ teamId, reason: 'optimizer-unplaced' }));

  return { placements, unassigned, type: mutationType };
}

// ---------------------------------------------------------------------------
// Greedy seed (server-side — replicate practiceScheduling.js core logic)
// ---------------------------------------------------------------------------

function generateGreedySeed(
  base: BaseOccupancy,
  teams: SchedulerTeam[],
  placeableTeamIds: string[],
  slots: SchedulerSlot[],
  coachPreferences: CoachPreferences
): { placements: Placement[]; unassigned: Unplaced[] } {
  const slotsById = new Map(slots.map((s) => [s.id, s]));
  const slotCapacity = new Map(base.slotCapacity);
  const coachAssignments = cloneWindows(base.coachAssignments);
  const assignedTeamIds = new Set<string>();
  const placements: Placement[] = [];

  const assign = (team: SchedulerTeam, slotId: string) => {
    const slot = slotsById.get(slotId)!;
    placements.push({ teamId: team.id, slotId, source: 'auto' });
    assignedTeamIds.add(team.id);
    slotCapacity.set(slotId, (slotCapacity.get(slotId) ?? 0) - 1);
    for (const coachId of team.coachIds) {
      const existing = coachAssignments.get(coachId) ?? [];
      existing.push({ teamId: team.id, slotId, start: slot.start, end: slot.end });
      coachAssignments.set(coachId, existing);
    }
  };

  // 1. Locked rows are already in `base` -- one unit per row.

  // 2. Sort by coach load (multi-team coaches first), counted over the whole
  //    roster, as before.
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
  const placeable = new Set(placeableTeamIds);
  const sorted = teams
    .filter((team) => placeable.has(team.id))
    .sort((a, b) => {
      const ac = busiestCoachCount.get(a.id) ?? 0;
      const bc = busiestCoachCount.get(b.id) ?? 0;
      return bc - ac || a.id.localeCompare(b.id);
    });

  // 3. Greedy assignment, placeable teams only
  for (const team of sorted) {
    if (assignedTeamIds.has(team.id)) continue;
    const bestSlot = slots.find((slot) =>
      checkHardConstraints(team, slot, coachAssignments, slotCapacity, coachPreferences)
    );
    if (bestSlot) assign(team, bestSlot.id);
  }

  const unassigned = sorted
    .filter((t) => !assignedTeamIds.has(t.id))
    .map((t) => ({ teamId: t.id, reason: 'no-slot-available' }));

  return { placements, unassigned };
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

export interface OptimizerConfig {
  timeBudgetMs: number;
  maxIterations: number;
  seed: number;
}

export interface OptimizerResult {
  /** New placements for placeable teams ONLY. Never a locked team. */
  placements: Placement[];
  /** Placeable teams the run could not place, each with its reason. */
  unassigned: Unplaced[];
  /** Locked rows whose slot is not in this run (still locked). */
  lockedOutsideRun: LockedOccupant[];
  evaluation: ReturnType<typeof evaluatePracticeSchedule>;
  seedScore: number;
  bestScore: number;
  iterations: number;
  restarts: number;
  elapsedMs: number;
  terminationReason: string;
}

// Yield every N iterations to avoid 2s CPU limit on Supabase free tier.
// The free tier enforces a 2s CPU ceiling per isolate burst but allows
// up to 150s wall-clock time; yielding lets the event loop breathe.
const YIELD_EVERY = 100;
// Safety wall-clock cutoff (140s) — leave 10s headroom before the
// hard 150s isolate timeout on the free tier.
const WALL_CLOCK_LIMIT_MS = 140_000;

export async function runPracticeOptimizer(params: {
  teams: SchedulerTeam[];
  slots: SchedulerSlot[];
  locked: LockedOccupant[];
  placeableTeamIds: string[];
  coachPreferences: CoachPreferences;
  config: OptimizerConfig;
  /** Called at each CPU yield, e.g. for a progress audit. */
  onProgress?: (progress: {
    iteration: number;
    bestScore: number;
    elapsedMs: number;
    restartCount: number;
  }) => void;
}): Promise<OptimizerResult> {
  const { teams, slots, locked, placeableTeamIds, coachPreferences, config: cfg } = params;
  const startTime = Date.now();
  const teamsById = new Map(teams.map((t) => [t.id, t]));
  const slotsById = new Map(slots.map((s) => [s.id, s]));
  const base = buildLockedOccupancy(locked, teamsById, slotsById);
  const rand = createPRNG(cfg.seed);

  const seed = generateGreedySeed(base, teams, placeableTeamIds, slots, coachPreferences);
  const seedScoring = scoreSchedule(base, seed.placements, seed.unassigned, teams, slots);
  let bestPlacements = seed.placements;
  let bestUnassigned = seed.unassigned;
  let bestScore = seedScoring.score;
  let bestEvaluation = seedScoring.evaluation;

  let currentPlacements = seed.placements;
  let currentScore = bestScore;

  let iteration = 0;
  let stallCount = 0;
  let restartCount = 0;
  const stallLimit = 80;
  const maxRestarts = 5;

  // Hill Climbing loop (with CPU yield + wall-clock guard)
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
      base,
      currentPlacements,
      placeableTeamIds,
      teamsById,
      slotsById,
      coachPreferences
    );
    const mutated = tryMutate(state, rand);

    if (!mutated) {
      stallCount++;
      if (stallCount >= stallLimit && restartCount < maxRestarts) {
        restartCount++;
        stallCount = 0;
        const restart = generateGreedySeed(base, teams, placeableTeamIds, slots, coachPreferences);
        currentPlacements = restart.placements;
        currentScore = scoreSchedule(
          base,
          currentPlacements,
          restart.unassigned,
          teams,
          slots
        ).score;
      }
      // Phase 9: yield on stall iterations too (every YIELD_EVERY)
      if (iteration % YIELD_EVERY === 0) {
        await new Promise((r) => setTimeout(r, 0));
      }
      continue;
    }

    const candidateScoring = scoreSchedule(
      base,
      mutated.placements,
      mutated.unassigned,
      teams,
      slots
    );

    if (candidateScoring.score > currentScore) {
      currentPlacements = mutated.placements;
      currentScore = candidateScoring.score;
      stallCount = 0;

      if (candidateScoring.score > bestScore) {
        bestPlacements = mutated.placements;
        bestUnassigned = mutated.unassigned;
        bestScore = candidateScoring.score;
        bestEvaluation = candidateScoring.evaluation;
      }
    } else {
      stallCount++;
      if (stallCount >= stallLimit && restartCount < maxRestarts) {
        restartCount++;
        stallCount = 0;
        currentPlacements = seed.placements;
        currentScore = seedScoring.score;
      }
    }

    // Phase 9: Yield CPU every YIELD_EVERY iterations to stay under
    // the Supabase free-tier 2s CPU burst limit while using up to
    // 140s of wall-clock time.
    if (iteration % YIELD_EVERY === 0) {
      await new Promise((r) => setTimeout(r, 0));
      params.onProgress?.({
        iteration,
        bestScore,
        elapsedMs: Date.now() - startTime,
        restartCount,
      });
    }
  }

  const elapsedMs = Date.now() - startTime;
  const terminationReason =
    elapsedMs >= WALL_CLOCK_LIMIT_MS
      ? 'wall-clock-safety'
      : elapsedMs >= cfg.timeBudgetMs
        ? 'time-budget'
        : iteration >= cfg.maxIterations
          ? 'max-iterations'
          : 'converged';

  return {
    placements: bestPlacements,
    unassigned: bestUnassigned,
    lockedOutsideRun: base.outsideRun,
    evaluation: bestEvaluation,
    seedScore: seedScoring.score,
    bestScore,
    iterations: iteration,
    restarts: restartCount,
    elapsedMs,
    terminationReason,
  };
}
