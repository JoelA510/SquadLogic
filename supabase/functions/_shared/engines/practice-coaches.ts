/**
 * Every coach a team carries, and the hard-constraint check the auto-scheduler runs before
 * seating a team. Mirrors `listTeamCoachIds` in packages/core/src/practiceScheduling.js and
 * `checkHardConstraints` in packages/core/src/autoScheduler.js (Phase 8.1; the reconciled
 * `coaches` shape added in 8.2, where the core helper became a call on
 * `people/coachList.js`). Kept in _shared so a
 * Deno test can reach the check without importing the serving module.
 */

export interface TimeWindow {
  start: Date;
  end: Date;
  teamId?: string;
  slotId?: string;
}

/**
 * One coach as the reconciled 8.2 shape states them. `name`, `displayName` and
 * `email` are carried for display and are **never** clash keys — see
 * `listTeamCoachIds`. `keyKind` is what a reconciled entry read back in says
 * its `personId` is; anything but `'id'` is uncorroborated.
 */
export interface ReconciledCoach {
  personId?: string | null;
  id?: string | null;
  keyKind?: string | null;
  name?: string | null;
  displayName?: string | null;
  email?: string | null;
  slot?: number | null;
}

export interface CoachedTeam {
  id: string;
  coachId?: string | null;
  assistantCoachIds?: string[] | null;
  /** The `teams` column spelling; read when `assistantCoachIds` is absent. */
  assistant_coach_ids?: string[] | null;
  /**
   * The reconciled shape 8.2 made first class in every core artifact. Read
   * **as well as** the legacy columns, not instead of them: a team must not be
   * protected or not according to which spelling it arrived in.
   */
  coaches?: ReconciledCoach[] | null;
}

/** A team with its coach list resolved once, at input preparation. */
export interface PreparedTeam extends CoachedTeam {
  coachIds: string[];
}

/**
 * The team's **clash keys**: every coach an id corroborates, deduplicated, empty ids dropped.
 * The assistant list is read as `assistantCoachIds` first, then `assistant_coach_ids`, the
 * precedence the core helper applies. An absent or null list means no assistants (the same
 * contract `if (team.coachId)` applies to a missing head coach); a list that is present and not
 * an array is rejected rather than read as "no coaches".
 *
 * **The identity rule, mirrored from `people/coachList.js`.** A `coaches` entry is keyed by
 * `personId`, else `id`, and by nothing else: an entry carrying only a name or an address is an
 * uncorroborated coach — two rows spelling "Coach Mike" may be one person or two — and is
 * excluded here rather than folded into "same person" and refusing a slot on the strength of a
 * spelling. The core reports each such coach as `COACH_IDENTITY_UNCORROBORATED`; this mirror
 * has no findings channel and relies on that. An entry with nothing to key on is dropped, never
 * keyed by its list index. `tests/fixtures/coachIdentityParityCases.js` holds both engines to
 * one table over every branch.
 */
export function listTeamCoachIds(team: CoachedTeam): string[] {
  const assistants = team.assistantCoachIds ?? team.assistant_coach_ids;
  if (assistants !== undefined && assistants !== null && !Array.isArray(assistants)) {
    throw new TypeError(`team ${team.id} assistantCoachIds must be an array when provided`);
  }
  if (team.coaches !== undefined && team.coaches !== null && !Array.isArray(team.coaches)) {
    throw new TypeError(`team ${team.id} coaches must be an array when provided`);
  }
  const ids = new Set<string>();
  // The reconciled shape first, in slot order, so the two sources union rather
  // than one winning. The core producer sorts by slot; here the list arrives
  // sorted and unranked entries keep their position, which is the same order
  // for every input the Edge Function can actually receive.
  for (const coach of team.coaches ?? []) {
    // A reconciled entry read back in says what its key is; an address or a
    // name must not become an id by passing through a second engine.
    if (coach?.keyKind != null && coach.keyKind !== 'id') continue;
    const key = String(coach?.personId ?? '').trim() || String(coach?.id ?? '').trim();
    if (key) ids.add(key);
  }
  // Blank-normalised as the core's `blankToNull` does: a padded id is the same id.
  const head = String(team.coachId ?? '').trim();
  if (head) ids.add(head);
  for (const id of assistants ?? []) {
    const trimmed = String(id ?? '').trim();
    if (trimmed) ids.add(trimmed);
  }
  return [...ids];
}

/**
 * The narrow team the optimiser seats and the evaluator scores: request passthrough keys dropped,
 * the assistant list normalised onto the engine spelling, and the coach set resolved once.
 * `assistantCoachIds` and `coaches` must both survive the projection — the evaluator recomputes
 * the conflict set from them rather than trusting a `coachIds` key a request could supply, so
 * dropping either here would silently narrow that check back.
 */
export function prepareTeam<T extends CoachedTeam & { division: string }>(
  team: T
): PreparedTeam & { division: string } {
  return {
    id: team.id,
    division: team.division,
    coachId: team.coachId ?? null,
    assistantCoachIds: team.assistantCoachIds ?? team.assistant_coach_ids ?? null,
    coaches: team.coaches ?? null,
    coachIds: listTeamCoachIds(team),
  };
}

/**
 * Key for one overlapping pair of assignments, the same whichever side is named first, so the
 * pair merges across coaches regardless of the order each coach's list produced it.
 */
export function conflictPairKey(
  a: { teamId: string; slotId: string },
  b: { teamId: string; slotId: string }
): string {
  return [`${a.teamId}::${a.slotId}`, `${b.teamId}::${b.slotId}`].sort().join('|');
}

/**
 * Capacity, then time overlap for every coach on the team.
 *
 * A per-coach `unavailableSlotIds` used to be read here from the request body
 * (`coachPreferences`). No client ever sent one, and a coach's availability is
 * now an approved `coach_practice_preferences` row the Edge loads itself
 * (8.6 PR 3b, PR 8: `coach-preference-load.ts`), so the body path is retired
 * rather than left parsed and unread.
 */
export function checkHardConstraints(
  team: PreparedTeam,
  slot: { id: string; start: Date; end: Date },
  coachAssignments: Map<string, TimeWindow[]>,
  slotCapacity: Map<string, number>
): boolean {
  if ((slotCapacity.get(slot.id) ?? 0) <= 0) return false;
  for (const coachId of team.coachIds) {
    const existing = coachAssignments.get(coachId) ?? [];
    for (const a of existing) {
      if (slot.start < a.end && slot.end > a.start) return false;
    }
  }
  return true;
}
