/**
 * The practice lock, as the auto-scheduler sees it (8.6 PR 3b plan §3, PR 7).
 *
 * Operator ruling 2: everything already assigned -- auto, manual, repair or an
 * enacted recommendation -- is locked unless an admin accepts an override
 * prompt. `persist_practice_schedule` v3 (20260929000000) enforces that in the
 * database. This module makes the auto-scheduler honour it as well, instead of
 * proposing moves the writer would refuse:
 *
 *   * the season's current `practice_assignments` are loaded SERVER-SIDE, as
 *     the calling user through RLS (`loadSeasonPracticeLock`), and every row
 *     is locked;
 *   * the client's `lockedAssignments` is a cross-check only
 *     (`crossCheckLockedAssignments`); a mismatch in either direction refuses
 *     the run;
 *   * an ordinary run places only teams with no row at all, and never a team
 *     whose series is TIME TBD (decision 4: those are resolved only in the
 *     repair panel) -- `classifyTeamsForRun`.
 *
 * **Stated limitation.** The Edge Function has no date model. A locked row
 * consumes its slot for the whole season, whatever its `effective_date_range`
 * says, so the run never double-books but may under-use a slot that a locked
 * row holds for only part of the season.
 *
 * Import-free (no Deno std, no esm.sh), so Vitest can execute it directly.
 */

/** One `practice_assignments` row, as loaded for the lock. */
export interface LoadedPracticeRow {
  id: string;
  teamId: string;
  slotId: string | null;
  effectiveDateRange: string | null;
  assignedVia: string | null;
}

/** One row of the client's `lockedAssignments` cross-check. */
export interface ClientLockedRow {
  id?: string | null;
  teamId: string;
  slotId: string | null;
  effectiveDateRange?: string | null;
  assignedVia?: string | null;
}

export interface LockCrossCheck {
  ok: boolean;
  /** Loaded server-side, absent from the client's list. */
  missingFromClient: string[];
  /** Named by the client, not loaded server-side (stale, or another season). */
  unknownToServer: string[];
  /** Same id on both sides, but a different team, slot, range or provenance. */
  differing: string[];
  /** Client rows that carry no assignment id at all (a client older than PR 7). */
  withoutId: number;
}

/** Why a roster team is not offered to an ordinary run. */
export const TIME_TBD_EXCLUDED_REASON = 'time-tbd-series';

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

/**
 * Compare the client's view of the locked rows with the rows loaded server-side.
 *
 * Keyed by assignment id, both directions, and every field the page carries
 * (team, slot, range, provenance) is compared: a field sent for the check and
 * not compared would be parsed and unread.
 */
export function crossCheckLockedAssignments(
  loaded: LoadedPracticeRow[],
  client: ClientLockedRow[]
): LockCrossCheck {
  const loadedById = new Map(loaded.map((row) => [row.id, row]));
  const clientById = new Map<string, ClientLockedRow>();
  let withoutId = 0;
  for (const row of client) {
    if (!row.id) {
      withoutId += 1;
      continue;
    }
    clientById.set(row.id, row);
  }

  const missingFromClient: string[] = [];
  const differing: string[] = [];
  for (const row of loaded) {
    const theirs = clientById.get(row.id);
    if (!theirs) {
      missingFromClient.push(row.id);
      continue;
    }
    if (
      theirs.teamId !== row.teamId ||
      theirs.slotId !== row.slotId ||
      (theirs.effectiveDateRange ?? null) !== row.effectiveDateRange ||
      (theirs.assignedVia ?? null) !== row.assignedVia
    ) {
      differing.push(row.id);
    }
  }
  const unknownToServer = [...clientById.keys()].filter((id) => !loadedById.has(id));

  return {
    ok:
      missingFromClient.length === 0 &&
      unknownToServer.length === 0 &&
      differing.length === 0 &&
      withoutId === 0,
    missingFromClient: sortedUnique(missingFromClient),
    unknownToServer: sortedUnique(unknownToServer),
    differing: sortedUnique(differing),
    withoutId,
  };
}

/** The refusal text for a failed cross-check, naming every differing id. */
export function describeLockMismatch(check: LockCrossCheck): string {
  const parts: string[] = [];
  if (check.missingFromClient.length > 0) {
    parts.push(`not sent by the page: ${check.missingFromClient.join(', ')}`);
  }
  if (check.unknownToServer.length > 0) {
    parts.push(`sent by the page but not in the season: ${check.unknownToServer.join(', ')}`);
  }
  if (check.differing.length > 0) {
    parts.push(`changed since the page read them: ${check.differing.join(', ')}`);
  }
  if (check.withoutId > 0) {
    parts.push(`${check.withoutId} sent without an assignment id`);
  }
  return (
    "The page's practice assignments do not match the season's current ones, so the run " +
    `was refused rather than scheduled around a stale view (${parts.join('; ')}). ` +
    'Reload the page and run again.'
  );
}

export interface TeamClassification {
  /** No row and no TIME TBD series: the only teams an ordinary run may place. */
  placeable: string[];
  /** At least one current row: locked, never placed again. */
  locked: string[];
  /** A live TIME TBD series: excluded, resolved only in the repair panel. */
  timeTbd: string[];
}

/**
 * Classify every roster team for an ordinary run. The subject set is the
 * roster (`teamIds`), never the solver's output, so a team cannot go missing
 * by being absent from a result: each lands in exactly one list.
 *
 * TIME TBD takes precedence (decision 4). Its series still has a row -- the
 * exception is keyed to one -- and that row keeps occupying its slot.
 */
export function classifyTeamsForRun(
  teamIds: string[],
  rows: LoadedPracticeRow[],
  timeTbdTeamIds: Iterable<string>
): TeamClassification {
  const withRow = new Set(rows.map((row) => row.teamId));
  const tbd = new Set(timeTbdTeamIds);
  const placeable: string[] = [];
  const locked: string[] = [];
  const timeTbd: string[] = [];
  for (const teamId of new Set(teamIds)) {
    if (tbd.has(teamId)) timeTbd.push(teamId);
    else if (withRow.has(teamId)) locked.push(teamId);
    else placeable.push(teamId);
  }
  return { placeable, locked, timeTbd };
}

// ---------------------------------------------------------------------------
// Loading, as the calling user
// ---------------------------------------------------------------------------

export interface QueryResult {
  data: unknown[] | null;
  error: { message?: string } | null;
}

/**
 * The slice of a supabase-js client the loader uses. Typed structurally so the
 * module stays import-free; a real `SupabaseClient` satisfies it.
 */
interface LockTable {
  select(columns: string): LockQuery;
}
interface LockQuery {
  eq(column: string, value: unknown): LockQuery;
  is(column: string, value: null): LockQuery;
  order(column: string, options?: { ascending?: boolean }): LockQuery;
  range(from: number, to: number): PromiseLike<QueryResult>;
}
export interface LockReader {
  from(table: string): LockTable;
}

export const LOCK_PAGE_SIZE = 1000;
export const LOCK_MAX_PAGES = 1000;

/**
 * Read every row of a query, page by page. PostgREST caps a response
 * (`max-rows`, 1000 by default), and a silently truncated read here would
 * leave locked rows unlocked -- the exact failure the lock exists to prevent.
 *
 * The loop advances by the rows actually returned and stops only on an EMPTY
 * page: a short page proves nothing when the server's cap is below
 * `pageSize`, so "fewer than asked" is never read as "the end".
 */
export async function readAllPages(
  build: () => { range: (from: number, to: number) => PromiseLike<QueryResult> },
  pageSize: number
): Promise<{ rows: unknown[]; error: string | null }> {
  const rows: unknown[] = [];
  for (let pageNo = 0; ; pageNo += 1) {
    // A read that never reaches an empty page is refused, never returned partial.
    if (pageNo >= LOCK_MAX_PAGES) return { rows, error: `no end after ${LOCK_MAX_PAGES} pages` };
    const from = rows.length;
    const { data, error } = await build().range(from, from + pageSize - 1);
    if (error) return { rows, error: error.message ?? 'unknown error' };
    const page = data ?? [];
    if (page.length === 0) return { rows, error: null };
    rows.push(...page);
  }
}

export type SeasonPracticeLock =
  | { ok: true; rows: LoadedPracticeRow[]; timeTbdTeamIds: string[] }
  | { ok: false; message: string };

/**
 * Load the season's current practice assignments and its live TIME TBD
 * series, through `client` -- which must be the USER-scoped client
 * (`createUserClient`), so RLS decides what the caller may read, not this
 * function.
 *
 * Season scope is the writer's: teams whose division belongs to the season
 * (`persist_practice_schedule` v3's `scope`, and its `teams_time_tbd`, which
 * is enumerated from the roster rather than from `practice_exceptions`'s own
 * season column).
 */
export async function loadSeasonPracticeLock(
  client: LockReader,
  params: { organizationId: string; seasonSettingsId: string; pageSize?: number }
): Promise<SeasonPracticeLock> {
  const { organizationId, seasonSettingsId, pageSize = LOCK_PAGE_SIZE } = params;

  const assignments = await readAllPages(
    () =>
      client
        .from('practice_assignments')
        .select(
          'id, team_id, practice_slot_id, slot_id, effective_date_range, assigned_via, ' +
            'teams!inner(divisions!inner(season_settings_id))'
        )
        .eq('organization_id', organizationId)
        .eq('teams.divisions.season_settings_id', seasonSettingsId)
        .order('id', { ascending: true }),
    pageSize
  );
  if (assignments.error) {
    return { ok: false, message: `practice_assignments: ${assignments.error}` };
  }

  const exceptions = await readAllPages(
    () =>
      client
        .from('practice_exceptions')
        .select('id, team_id, teams!inner(divisions!inner(season_settings_id))')
        .eq('organization_id', organizationId)
        .eq('kind', 'time_tbd')
        .is('withdrawn_at', null)
        .eq('teams.divisions.season_settings_id', seasonSettingsId)
        .order('id', { ascending: true }),
    pageSize
  );
  if (exceptions.error) {
    return { ok: false, message: `practice_exceptions: ${exceptions.error}` };
  }

  const rows = (assignments.rows as Array<Record<string, unknown>>).map((row) => ({
    id: String(row.id),
    teamId: String(row.team_id),
    // The writer's own reading: COALESCE(practice_slot_id, slot_id).
    slotId:
      (row.practice_slot_id ?? row.slot_id) == null
        ? null
        : String(row.practice_slot_id ?? row.slot_id),
    effectiveDateRange: row.effective_date_range == null ? null : String(row.effective_date_range),
    assignedVia: row.assigned_via == null ? null : String(row.assigned_via),
  }));
  const timeTbdTeamIds = sortedUnique(
    (exceptions.rows as Array<Record<string, unknown>>).map((row) => String(row.team_id))
  );
  return { ok: true, rows, timeTbdTeamIds };
}
