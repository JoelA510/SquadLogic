/**
 * Each division's practice settings, loaded server-side for one auto-scheduler run (Phase D PR B;
 * plan `docs/changes/2026-10-27-phase-d-scheduling.md`, section B; migration
 * `20261105010000_practices_per_division.sql`).
 *
 * A division says how many practices a week its teams get (`practices_per_week`, 0 to 7, one until
 * set) and how long each is (`practice_minutes`, 15 to 240, or null for any slot length). The run
 * plans units from the count (`planTeamsForRun`, `practice-lock.ts`) and judges every placement by
 * the length (`checkHardConstraints`, `practice-coaches.ts`).
 *
 * ## Where it comes from
 *
 * The store, read by {@link loadTeamPracticeSettings} AS THE CALLER through RLS
 * (`createUserClient`), paged, never from the request body: a `practicesPerWeek` on a body team is
 * read by nobody. **A failed read refuses the run**, and so does a division whose settings are not
 * what the table's checks allow (an integer count from 0 to 7, a length null or an integer from 15
 * to 240): either would run the division at a count nobody set. A run team the read does not return
 * (a team of another season) keeps one practice a week and any slot length -- what a division
 * without settings did before -- and is counted, so the run's audit row says so.
 *
 * Import-free apart from its siblings, so Vitest can execute it directly.
 */
import { LOCK_PAGE_SIZE, readAllPages, type QueryResult } from './practice-lock.ts';

interface SettingsQuery {
  eq(column: string, value: unknown): SettingsQuery;
  order(column: string, options?: { ascending?: boolean }): SettingsQuery;
  range(from: number, to: number): PromiseLike<QueryResult>;
}
export interface PracticeSettingsReader {
  from(table: string): { select(columns: string): SettingsQuery };
}

/** The refusal the run answers when the settings cannot be read in full. */
export const DIVISION_PRACTICE_SETTINGS_UNREADABLE = 'DIVISION_PRACTICE_SETTINGS_UNREADABLE';

/** One team's division's settings. */
export interface PracticeSettings {
  /** Practices a week, 0 to 7. */
  practicesPerWeek: number;
  /** A practice's length in minutes, or `null` for any slot length. */
  practiceMinutes: number | null;
}

/** What a team gets when nothing says otherwise: the solver before practices per division. */
export const DEFAULT_PRACTICE_SETTINGS: Readonly<PracticeSettings> = Object.freeze({
  practicesPerWeek: 1,
  practiceMinutes: null,
});

export type TeamPracticeSettingsLoad =
  | { ok: true; byTeam: Map<string, PracticeSettings> }
  | { ok: false; code: typeof DIVISION_PRACTICE_SETTINGS_UNREADABLE; message: string };

/**
 * The settings of the teams in `rows`, each a `teams` row joined to its division
 * (`{ id, divisions: { practices_per_week, practice_minutes } }`). Refuses a division whose values
 * the table would not hold, naming it. Pure: the loader and the end-to-end route both use it.
 */
export function parseTeamPracticeSettings(rows: readonly unknown[]): TeamPracticeSettingsLoad {
  const byTeam = new Map<string, PracticeSettings>();
  for (const raw of rows as Array<Record<string, unknown>>) {
    const division = (Array.isArray(raw.divisions) ? raw.divisions[0] : raw.divisions) as
      | Record<string, unknown>
      | null
      | undefined;
    const count = division?.practices_per_week;
    const minutes = division?.practice_minutes ?? null;
    const countOk =
      typeof count === 'number' && Number.isInteger(count) && count >= 0 && count <= 7;
    const minutesOk =
      minutes === null ||
      (typeof minutes === 'number' && Number.isInteger(minutes) && minutes >= 15 && minutes <= 240);
    if (!division || !countOk || !minutesOk) {
      return {
        ok: false,
        code: DIVISION_PRACTICE_SETTINGS_UNREADABLE,
        message:
          `team ${String(raw.id)}'s division has practices_per_week ${String(count)} and ` +
          `practice_minutes ${String(minutes)}, which the table does not allow`,
      };
    }
    byTeam.set(String(raw.id), {
      practicesPerWeek: count as number,
      practiceMinutes: minutes as number | null,
    });
  }
  return { ok: true, byTeam };
}

/**
 * The settings of every team of the season, read through `client` (the user-scoped client, so RLS
 * decides), page by page.
 */
export async function loadTeamPracticeSettings(
  client: PracticeSettingsReader,
  params: { organizationId: string; seasonSettingsId: string; pageSize?: number }
): Promise<TeamPracticeSettingsLoad> {
  const { organizationId, seasonSettingsId, pageSize = LOCK_PAGE_SIZE } = params;
  const read = await readAllPages(
    () =>
      client
        .from('teams')
        .select('id, divisions!inner(season_settings_id, practices_per_week, practice_minutes)')
        .eq('organization_id', organizationId)
        .eq('divisions.season_settings_id', seasonSettingsId)
        .order('id', { ascending: true }),
    pageSize
  );
  if (read.error) {
    return {
      ok: false,
      code: DIVISION_PRACTICE_SETTINGS_UNREADABLE,
      message: `teams (practice settings): ${read.error}`,
    };
  }
  return parseTeamPracticeSettings(read.rows);
}

/** The run's teams with their settings on them; a team the read did not return gets the defaults. */
export function applyPracticeSettings<T extends { id: string }>(
  teams: readonly T[],
  settings: ReadonlyMap<string, PracticeSettings>
): {
  teams: Array<T & PracticeSettings>;
  /** Teams of the run the read did not return: run at the defaults, and counted. */
  withoutSettings: string[];
} {
  const withoutSettings: string[] = [];
  const out = teams.map((team) => {
    const found = settings.get(team.id);
    if (!found) withoutSettings.push(team.id);
    return { ...team, ...(found ?? DEFAULT_PRACTICE_SETTINGS) };
  });
  return { teams: out, withoutSettings };
}
