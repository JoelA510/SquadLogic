/**
 * Practice preference rules, loaded server-side for one auto-scheduler run (Phase D, C1;
 * originally 8.6 PR 3b, PR 8; plan §4 "Deno side", §5 decision 3).
 *
 * **Never from the request body.** Everything here is read by the Edge
 * Function itself, AS THE CALLER through RLS (`createUserClient`), alongside
 * the season rows `practice-lock.ts` loads:
 *
 *   * `team_coach_assignments` current on the run date (the season's calendar
 *     date) -- who coaches each team, the one coach source for rules;
 *   * `coach_practice_preferences` in force (`status = 'in_force'`): one row is one rule for one
 *     team (migration `20261112010000`). A requested must is in force as `prefer` until an admin
 *     accepts it, so the `level` read is the level to judge by. Each rule's own date window is
 *     judged against the run date by the rule's resolver, not filtered here;
 *   * `practice_slots` (+ `fields.location_id`), only when a placeable team
 *     holds a live rule condition -- each candidate's weekday, local start minutes
 *     and venue, read from the store rather than from the body's slot shape. The same reading
 *     gives the placements a team's saved practices hold, which is what "keep the current day,
 *     time or venue" keeps.
 *
 * **A failed or partial read refuses the run.** It never runs as if there
 * were no rules. The loader also counts the same rows with the service-role
 * client (a count only; no row content crosses) and refuses when the caller's
 * read saw fewer: a partial read is a failed read.
 *
 * Import-free apart from its siblings, so Vitest can execute it directly.
 */
import { practiceRangeBounds } from '../calendar/practiceExceptions.ts';
import {
  COACH_PREFERENCE_DIMENSIONS,
  isInertResolution,
  judgeCoachPreferenceCandidate,
  resolveCoachPreferences,
  type PreferenceFinding,
  type PreferencePlacement,
  type PreferenceRule,
} from './coach-preferences.ts';
import { LOCK_PAGE_SIZE, readAllPages, type QueryResult } from './practice-lock.ts';

/** One team x slot verdict, as the solver reads it. */
export interface SlotVerdict {
  mustKeepViolated: boolean;
  preferKeepBreaches: number;
  violatedDimensions: string[];
  /** The ids of the `must` rules this slot does not meet: what a TIME TBD reason names. */
  violatedRules: string[];
}

/**
 * What the solver needs: a verdict per (placeable team, run slot) for every
 * team whose preferences constrain anything. A team absent from `verdicts` is
 * unconstrained, and every slot is admissible to it at zero breaches.
 */
export interface PreferenceGate {
  verdicts: Map<string, Map<string, SlotVerdict>>;
}

export const EMPTY_PREFERENCE_GATE: PreferenceGate = Object.freeze({
  verdicts: new Map(),
}) as PreferenceGate;

export type CoachPreferenceContext =
  | {
      ok: true;
      gate: PreferenceGate;
      findings: Array<PreferenceFinding & { teamId: string }>;
      runDate: string;
      preferencesLoaded: number;
      coachAssignmentsLoaded: number;
      teamsConstrained: number;
    }
  | { ok: false; code: string; message: string };

// ---------------------------------------------------------------------------
// The run date
// ---------------------------------------------------------------------------

/**
 * The date a run reads coach assignments on: the LATER of the season's
 * calendar date and the UTC date, or `null` when the zone cannot be read.
 *
 * `set_team_coaches` stamps `effective_from` / `effective_to` with the
 * database's `current_date`, which is UTC. West of UTC the season's date lags
 * it in the evening, and a coach assigned at 18:00 in Los Angeles is written
 * as starting on tomorrow's UTC date; reading on the season's date alone would
 * leave the team uncoached (and its preferences unapplied) until midnight.
 * East of UTC the season's date is the later one, and every row the writers
 * stamped is already on or before it.
 */
export function seasonRunDate(instantMs: number, timeZone: string | null): string | null {
  const seasonDate = seasonCalendarDate(instantMs, timeZone);
  if (!seasonDate) return null;
  const utcDate = new Date(instantMs).toISOString().slice(0, 10);
  return seasonDate > utcDate ? seasonDate : utcDate;
}

/**
 * The season's calendar date at `instantMs`, or `null` when the zone cannot be
 * read. Exported for the daylight pass (8.9 PR 6), whose "today" is this date
 * -- the page's `seasonCalendarDate`, where a new placement starts.
 */
export function seasonCalendarDate(instantMs: number, timeZone: string | null): string | null {
  if (!timeZone) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date(instantMs));
    const get = (type: string) => parts.find((part) => part.type === type)?.value;
    const [y, m, d] = [get('year'), get('month'), get('day')];
    return y && m && d ? `${y}-${m}-${d}` : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

const WEEKDAY_CODES = new Set(['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']);

/** `practice_slots.day_of_week` ('mon') -> the preference code ('MON'). */
export function weekdayCode(dayOfWeek: unknown): string | null {
  const code = String(dayOfWeek ?? '')
    .trim()
    .slice(0, 3)
    .toUpperCase();
  return WEEKDAY_CODES.has(code) ? code : null;
}

/** `HH:MM[:SS]` -> minutes past local midnight, or `null`. */
export function startMinutesOf(time: unknown): number | null {
  const match = /^(\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(String(time ?? '').trim());
  if (!match) return null;
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  return minutes >= 0 && minutes <= 1439 ? minutes : null;
}

function isCurrentOn(runDate: string, from: unknown, to: unknown): boolean {
  if (from == null || String(from) > runDate) return false;
  return to == null || String(to) >= runDate;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/** The slice of a supabase-js query builder the loader uses. */
interface PrefQuery extends PromiseLike<QueryResult & { count?: number | null }> {
  eq(column: string, value: unknown): PrefQuery;
  lte(column: string, value: unknown): PrefQuery;
  or(filter: string): PrefQuery;
  order(column: string, options?: { ascending?: boolean }): PrefQuery;
  range(from: number, to: number): PromiseLike<QueryResult>;
}
export interface PreferenceReader {
  from(table: string): {
    select(columns: string, options?: { count?: 'exact'; head?: boolean }): PrefQuery;
  };
}

/**
 * Load everything one run's preferences need and turn it into a
 * {@link PreferenceGate}.
 *
 * @param userClient    the CALLER's client (RLS decides every row read)
 * @param serviceClient used for one count only: the completeness check
 */
export async function loadCoachPreferenceContext(
  userClient: PreferenceReader,
  serviceClient: PreferenceReader,
  params: {
    organizationId: string;
    runDate: string | null;
    placeableTeamIds: readonly string[];
    slotIds: readonly string[];
    /**
     * The practice rows the season already holds (`practice-lock.ts`, `LoadedPracticeRow`): what
     * keep-current rules keep. A row that has ended before the run date holds nothing.
     */
    heldRows?: ReadonlyArray<{
      teamId: string;
      slotId: string | null;
      effectiveDateRange: string | null;
    }>;
    pageSize?: number;
  }
): Promise<CoachPreferenceContext> {
  const {
    organizationId,
    runDate,
    placeableTeamIds,
    slotIds,
    heldRows = [],
    pageSize = LOCK_PAGE_SIZE,
  } = params;
  if (!runDate) {
    return {
      ok: false,
      code: 'COACH_PREFERENCES_UNREADABLE',
      message: "the season's calendar date could not be read, so no preference is known current",
    };
  }
  const inForce = `effective_to.is.null,effective_to.gte.${runDate}`;
  const ruleColumns =
    'id, coach_id, team_id, level, weekdays, start_minutes, venue_ids, keep_weekday, keep_start, ' +
    'keep_venue, coach_priority, effective_from, effective_to';

  const assignments = await readAllPages(
    () =>
      userClient
        .from('team_coach_assignments')
        .select('id, team_id, coach_id, effective_from, effective_to')
        .eq('organization_id', organizationId)
        .lte('effective_from', runDate)
        .or(inForce)
        .order('id', { ascending: true }),
    pageSize
  );
  if (assignments.error) {
    return {
      ok: false,
      code: 'COACH_PREFERENCES_UNREADABLE',
      message: `team_coach_assignments: ${assignments.error}`,
    };
  }

  const preferenceRows = await readAllPages(
    () =>
      userClient
        .from('coach_practice_preferences')
        .select(ruleColumns)
        .eq('organization_id', organizationId)
        .eq('status', 'in_force')
        .order('id', { ascending: true }),
    pageSize
  );
  if (preferenceRows.error) {
    return {
      ok: false,
      code: 'COACH_PREFERENCES_UNREADABLE',
      message: `coach_practice_preferences: ${preferenceRows.error}`,
    };
  }

  // Completeness: the same filter, counted without RLS. A caller who can see
  // fewer rows than exist would otherwise run as if the rest did not exist.
  const counted = await serviceClient
    .from('coach_practice_preferences')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', organizationId)
    .eq('status', 'in_force');
  if (counted.error || typeof counted.count !== 'number') {
    return {
      ok: false,
      code: 'COACH_PREFERENCES_UNREADABLE',
      message: `coach_practice_preferences count: ${counted.error?.message ?? 'no count returned'}`,
    };
  }
  if (counted.count !== preferenceRows.rows.length) {
    return {
      ok: false,
      code: 'COACH_PREFERENCES_NOT_VISIBLE',
      message:
        `the caller can read ${preferenceRows.rows.length} of the ${counted.count} practice ` +
        'preference rules in force, so the run would ignore the rest',
    };
  }

  // Coaches per team, current on the run date (filtered again here: the
  // query's filter is the store's, this is the rule's).
  const coachesByTeam = new Map<string, Set<string>>();
  for (const row of assignments.rows as Array<Record<string, unknown>>) {
    if (!isCurrentOn(runDate, row.effective_from, row.effective_to)) continue;
    const teamId = String(row.team_id);
    const set = coachesByTeam.get(teamId) ?? new Set<string>();
    set.add(String(row.coach_id));
    coachesByTeam.set(teamId, set);
  }

  const rules: PreferenceRule[] = [];
  for (const row of preferenceRows.rows as Array<Record<string, unknown>>) {
    rules.push({
      id: String(row.id),
      coachId: String(row.coach_id),
      teamId: String(row.team_id),
      level: String(row.level),
      weekdays: row.weekdays == null ? null : (row.weekdays as string[]),
      startMinutes: row.start_minutes == null ? null : (row.start_minutes as number[]),
      venueIds:
        row.venue_ids == null
          ? null
          : (row.venue_ids as unknown[]).map((v) => String(v).toLowerCase()),
      keepWeekday: row.keep_weekday === true,
      keepStart: row.keep_start === true,
      keepVenue: row.keep_venue === true,
      coachPriority: row.coach_priority == null ? null : String(row.coach_priority),
      effectiveFrom: row.effective_from == null ? null : String(row.effective_from),
      effectiveTo: row.effective_to == null ? null : String(row.effective_to),
    });
  }
  const rulesByTeam = new Map<string, PreferenceRule[]>();
  for (const rule of rules) {
    const list = rulesByTeam.get(rule.teamId) ?? [];
    list.push(rule);
    rulesByTeam.set(rule.teamId, list);
  }
  const teamsWithRules = placeableTeamIds.filter((teamId) => rulesByTeam.has(teamId));
  const noneConstrained = {
    ok: true as const,
    findings: [] as Array<PreferenceFinding & { teamId: string }>,
    runDate,
    preferencesLoaded: rules.length,
    coachAssignmentsLoaded: assignments.rows.length,
    teamsConstrained: 0,
    gate: { verdicts: new Map<string, Map<string, SlotVerdict>>() },
  };
  if (teamsWithRules.length === 0) return noneConstrained;

  // Slot attributes, from the store. Every run slot must be found and readable: a slot that
  // cannot be judged is never assumed to keep anything. They also give what a team's saved
  // practices hold, which is what a keep-current rule keeps.
  const slotRows = await readAllPages(
    () =>
      userClient
        .from('practice_slots')
        .select('id, day_of_week, start_time, fields!inner(location_id)')
        .eq('organization_id', organizationId)
        .order('id', { ascending: true }),
    pageSize
  );
  if (slotRows.error) {
    return {
      ok: false,
      code: 'COACH_PREFERENCES_UNREADABLE',
      message: `practice_slots: ${slotRows.error}`,
    };
  }
  const placementBySlot = new Map<string, PreferencePlacement>();
  for (const row of slotRows.rows as Array<Record<string, unknown>>) {
    const weekday = weekdayCode(row.day_of_week);
    const startMinutes = startMinutesOf(row.start_time);
    const field = row.fields as { location_id?: unknown } | null;
    const locationId = field?.location_id == null ? null : String(field.location_id).toLowerCase();
    if (weekday && startMinutes !== null && locationId) {
      placementBySlot.set(String(row.id), { weekday, startMinutes, locationId });
    }
  }

  // What each team's saved practices hold: its rows that have not ended before the run date and
  // that sit on a slot (a TIME TBD series' row has none, so it holds nothing to keep). A row on
  // a slot that cannot be read refuses the run when the team has a keep-current rule.
  const heldByTeam = new Map<string, PreferencePlacement[]>();
  const heldUnreadable: string[] = [];
  const keepsCurrent = (teamId: string) =>
    (rulesByTeam.get(teamId) ?? []).some((r) => r.keepWeekday || r.keepStart || r.keepVenue);
  for (const row of heldRows) {
    if (row.slotId === null || !keepsCurrent(row.teamId)) continue;
    const bounds =
      row.effectiveDateRange === null ? null : practiceRangeBounds(row.effectiveDateRange);
    // A range that has ended before the run date holds nothing; an open or unreadable one holds.
    if (bounds !== null && bounds.last < runDate) continue;
    const placement = placementBySlot.get(row.slotId);
    if (!placement) {
      heldUnreadable.push(row.slotId);
      continue;
    }
    const list = heldByTeam.get(row.teamId) ?? [];
    list.push(placement);
    heldByTeam.set(row.teamId, list);
  }
  if (heldUnreadable.length > 0) {
    return {
      ok: false,
      code: 'COACH_PREFERENCES_UNREADABLE',
      message:
        `${heldUnreadable.length} saved practice slot(s) could not be read with a weekday, start and ` +
        `venue, so a keep-current rule cannot be judged: ${[...new Set(heldUnreadable)].slice(0, 5).join(', ')}`,
    };
  }

  let resolutions: Array<{
    teamId: string;
    resolution: ReturnType<typeof resolveCoachPreferences>;
  }>;
  try {
    resolutions = teamsWithRules.map((teamId) => ({
      teamId,
      resolution: resolveCoachPreferences({
        teamId,
        coachIds: [...(coachesByTeam.get(teamId) ?? [])],
        rules: rulesByTeam.get(teamId) ?? [],
        current: heldByTeam.get(teamId) ?? [],
        date: runDate,
      }),
    }));
  } catch (error) {
    return {
      ok: false,
      code: 'COACH_PREFERENCES_UNREADABLE',
      message: `coach_practice_preferences: ${(error as Error).message}`,
    };
  }

  const findings = resolutions.flatMap(({ teamId, resolution }) =>
    resolution.findings.map((finding) => ({ ...finding, teamId }))
  );
  const constrained = resolutions.filter(({ resolution }) => !isInertResolution(resolution));
  const base = { ...noneConstrained, findings, teamsConstrained: constrained.length };
  if (constrained.length === 0) return base;

  const unjudgeable = slotIds.filter((id) => !placementBySlot.has(id));
  if (unjudgeable.length > 0) {
    return {
      ok: false,
      code: 'COACH_PREFERENCES_UNREADABLE',
      message:
        `${unjudgeable.length} practice slot(s) could not be read with a weekday, start and ` +
        `venue, so no preference can be judged against them: ${unjudgeable.slice(0, 5).join(', ')}`,
    };
  }

  const verdicts = new Map<string, Map<string, SlotVerdict>>();
  for (const { teamId, resolution } of constrained) {
    const bySlot = new Map<string, SlotVerdict>();
    for (const slotId of slotIds) {
      const verdict = judgeCoachPreferenceCandidate(
        resolution,
        placementBySlot.get(slotId) as PreferencePlacement
      );
      bySlot.set(slotId, {
        mustKeepViolated: verdict.mustKeepViolated,
        preferKeepBreaches: verdict.preferKeepBreaches,
        violatedDimensions: verdict.violatedDimensions,
        violatedRules: verdict.violatedRules,
      });
    }
    verdicts.set(teamId, bySlot);
  }
  return { ...base, gate: { verdicts } };
}

/** The dimensions, re-exported for callers that report them. */
export { COACH_PREFERENCE_DIMENSIONS };
