/**
 * Division reservations on practice slots, loaded server-side for one
 * auto-scheduler run (plan `docs/changes/2026-10-22-demo-mode.md`, D2;
 * migration `20261029010000_practice_only_divisions.sql`).
 *
 * ## The rule
 *
 * A slot with a division (`practice_slots.division_id`) is used only by that
 * division's teams, and a division with a reserved slot among the run's slots
 * uses only its reserved slots. Teams and slots are matched by division id
 * (`teams.division_id`). A team the store holds no division for is refused
 * every reserved slot and is never held to one. `checkHardConstraints`
 * (`practice-coaches.ts`) applies it to every new placement, so the greedy
 * seed, every mutation and the unplaced re-derivation all read one rule;
 * locked rows are occupancy and are never judged (maximum freeze: a
 * reservation set after a practice was saved does not move it). Core
 * `practiceScheduling.js` (`reservationRefusal`) is the twin;
 * `tests/autoSchedulerReservations.test.js` runs both over one table.
 *
 * ## Where it comes from
 *
 * The store, read by {@link loadSlotReservations} AS THE CALLER through RLS
 * (`createUserClient`), paged, never from the request body: a `divisionId` on
 * a body slot or team is read by nobody. **A failed read refuses the run**,
 * and so does a run slot the read does not return: either would run as if the
 * slot were open, handing a reserved session to any division. A run team the
 * read does not return keeps no division, which only takes reserved slots
 * away from it (stricter, never looser), so it does not refuse.
 *
 * Import-free apart from its siblings, so Vitest can execute it directly.
 */
import { LOCK_PAGE_SIZE, readAllPages, type QueryResult } from './practice-lock.ts';

interface ReservationQuery {
  eq(column: string, value: unknown): ReservationQuery;
  order(column: string, options?: { ascending?: boolean }): ReservationQuery;
  range(from: number, to: number): PromiseLike<QueryResult>;
}
export interface ReservationReader {
  from(table: string): { select(columns: string): ReservationQuery };
}

/** The refusal the run answers when the reservations cannot be read in full. */
export const SLOT_RESERVATIONS_UNREADABLE = 'SLOT_RESERVATIONS_UNREADABLE';

export interface SlotReservations {
  /** Every run slot's reservation: a division id, or `null` (open). */
  slotDivision: Map<string, string | null>;
  /** Every run team's division id, or `null` when the store holds none for it. */
  teamDivision: Map<string, string | null>;
  /** The divisions holding a reserved slot among the run's slots. */
  reservedDivisionIds: Set<string>;
}

export type SlotReservationLoad =
  | ({ ok: true } & SlotReservations)
  | { ok: false; code: typeof SLOT_RESERVATIONS_UNREADABLE; message: string };

/** A division id trimmed and lower-cased, blank as none (core's `blankToNull`). */
export const idOrNull = (value: unknown): string | null => {
  const text = value === undefined || value === null ? '' : String(value).trim().toLowerCase();
  return text === '' ? null : text;
};

/**
 * The run's slots' reservations and its teams' divisions, read through
 * `client` (the user-scoped client, so RLS decides), page by page.
 */
export async function loadSlotReservations(
  client: ReservationReader,
  params: {
    organizationId: string;
    slotIds: readonly string[];
    teamIds: readonly string[];
    pageSize?: number;
  }
): Promise<SlotReservationLoad> {
  const { organizationId, pageSize = LOCK_PAGE_SIZE } = params;
  const slotRead = await readAllPages(
    () =>
      client
        .from('practice_slots')
        .select('id, division_id')
        .eq('organization_id', organizationId)
        .order('id', { ascending: true }),
    pageSize
  );
  if (slotRead.error) {
    return {
      ok: false,
      code: SLOT_RESERVATIONS_UNREADABLE,
      message: `practice_slots: ${slotRead.error}`,
    };
  }
  const stored = new Map<string, string | null>();
  for (const row of slotRead.rows as Array<Record<string, unknown>>) {
    stored.set(String(row.id), idOrNull(row.division_id));
  }
  const unread = params.slotIds.filter((id) => !stored.has(id));
  if (unread.length > 0) {
    return {
      ok: false,
      code: SLOT_RESERVATIONS_UNREADABLE,
      message: `${unread.length} run slot(s) are not among the practice slots this caller can read: ${unread.slice(0, 5).join(', ')}`,
    };
  }

  const teamRead = await readAllPages(
    () =>
      client
        .from('teams')
        .select('id, division_id')
        .eq('organization_id', organizationId)
        .order('id', { ascending: true }),
    pageSize
  );
  if (teamRead.error) {
    return { ok: false, code: SLOT_RESERVATIONS_UNREADABLE, message: `teams: ${teamRead.error}` };
  }
  const storedTeams = new Map<string, string | null>();
  for (const row of teamRead.rows as Array<Record<string, unknown>>) {
    storedTeams.set(String(row.id), idOrNull(row.division_id));
  }

  const slotDivision = new Map<string, string | null>();
  const reservedDivisionIds = new Set<string>();
  for (const id of params.slotIds) {
    const division = stored.get(id) ?? null;
    slotDivision.set(id, division);
    if (division) reservedDivisionIds.add(division);
  }
  const teamDivision = new Map<string, string | null>();
  for (const id of params.teamIds) teamDivision.set(id, storedTeams.get(id) ?? null);
  return { ok: true, slotDivision, teamDivision, reservedDivisionIds };
}

/**
 * The run's teams and slots with the store's reservations on them, for
 * `checkHardConstraints`. A body's own `divisionId` is overwritten, never read.
 */
export function applySlotReservations<T extends { id: string }, S extends { id: string }>(
  teams: readonly T[],
  slots: readonly S[],
  reservations: SlotReservations
): {
  teams: Array<T & { divisionId: string | null; reservedDivisionIds: ReadonlySet<string> }>;
  slots: Array<S & { divisionId: string | null }>;
} {
  return {
    teams: teams.map((team) => ({
      ...team,
      divisionId: reservations.teamDivision.get(team.id) ?? null,
      reservedDivisionIds: reservations.reservedDivisionIds,
    })),
    slots: slots.map((slot) => ({
      ...slot,
      divisionId: reservations.slotDivision.get(slot.id) ?? null,
    })),
  };
}
