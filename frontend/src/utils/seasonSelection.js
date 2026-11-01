/**
 * Which season an organization's pages are showing (Phase E1; plan
 * docs/changes/2026-10-22-phase-e-seasons.md, point 1 and the "Current-season readers" table).
 *
 * Nothing is live before activation: the organization's current season is its one `active`
 * season. A draft is shown only when an admin chose it, a stored choice is a season's **id** (a
 * name is free text, and one season's name may be another's label), and "the newest season" is
 * never the answer. Pure: no storage, no React, so the context's rule is testable on its own.
 */

/** The localStorage key of the chosen season's id. The old `squadlogic-current-season` key held a
 *  name and is shared with the free-text season label, so it is no longer read here. */
export const CURRENT_SEASON_ID_KEY = 'squadlogic-current-season-id';

const STATUS_RANK = { active: 0, draft: 1, completed: 2 };

/** @param {any} row */
const createdAt = (row) => Date.parse(row?.created_at ?? '') || 0;

/**
 * The seasons the caller may see in the switcher: every season for an admin or staff member,
 * and everything but drafts for anyone else (a draft is work in progress).
 * @param {any[] | null | undefined} seasons
 * @param {boolean} canSeeDrafts
 * @returns {any[]}
 */
export function visibleSeasons(seasons, canSeeDrafts) {
  return (seasons ?? []).filter((season) => canSeeDrafts || season?.status !== 'draft');
}

/**
 * Active first, then drafts, then completed seasons; each group newest first.
 * @param {any[] | null | undefined} seasons
 * @returns {any[]}
 */
export function orderSeasons(seasons) {
  return [...(seasons ?? [])].sort(
    (a, b) =>
      (STATUS_RANK[a?.status] ?? 3) - (STATUS_RANK[b?.status] ?? 3) ||
      createdAt(b) - createdAt(a) ||
      String(a?.id ?? '').localeCompare(String(b?.id ?? ''))
  );
}

/**
 * The season to show: the stored one when it is a season of this organization that the caller
 * may open (the active one, a completed one chosen to look back at, or a draft for an admin or
 * staff member), otherwise the active season,
 * otherwise none. Never the newest.
 * @param {any[] | null | undefined} seasons the organization's seasons
 * @param {string | null | undefined} storedId the id chosen earlier
 * @param {boolean} canSeeDrafts
 * @returns {any | null}
 */
export function chooseCurrentSeason(seasons, storedId, canSeeDrafts) {
  const rows = seasons ?? [];
  if (storedId) {
    const stored = rows.find((season) => season?.id === storedId);
    // A completed season is history (read-only since E3b): shown when it was chosen, never by default.
    if (
      stored &&
      (stored.status === 'active' ||
        stored.status === 'completed' ||
        (stored.status === 'draft' && canSeeDrafts))
    ) {
      return stored;
    }
  }
  return rows.find((season) => season?.status === 'active') ?? null;
}

/** @returns {string | null} The stored season id, or null when storage is unavailable or empty. */
export function readStoredSeasonId() {
  try {
    return localStorage.getItem(CURRENT_SEASON_ID_KEY) || null;
  } catch {
    // Private mode or blocked site data: the choice is a convenience, the active season is the default.
    return null;
  }
}

/** @param {string | null | undefined} id */
export function writeStoredSeasonId(id) {
  try {
    if (id) localStorage.setItem(CURRENT_SEASON_ID_KEY, id);
    else localStorage.removeItem(CURRENT_SEASON_ID_KEY);
  } catch {
    // As above: not being able to remember the choice must not break the page.
  }
}
