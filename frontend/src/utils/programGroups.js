/**
 * Groups a season's divisions under the program each is in (Phase E2; plan
 * `docs/changes/2026-10-22-phase-e-seasons.md`, "Programs (E2)").
 *
 * **Programs are optional.** A league that runs on divisions alone has one program per season, the
 * default ("No program"), and its pages show a flat list with no program heading at all: this
 * returns `null` unless at least one program of the league's own holds a division the page lists.
 * Only then is there anything to group by, and only then does "No program" appear, as the last
 * heading, for the divisions in none.
 */

export const NO_PROGRAM_LABEL = 'No program';

/**
 * @param {{
 *   items: Array<{ id: string }>,
 *   programIdOf: (item: { id: string }) => string | null | undefined,
 *   programs: Array<{ id: string, name: string, is_default?: boolean }> | null | undefined,
 * }} input `items` are the divisions the page lists (any shape with an id); `programIdOf` is the
 *   `program_id` of the division stored for one, or nothing for a division not stored yet.
 * @returns {Array<{ key: string, label: string, ids: string[] }> | null} headings in display order
 *   (programs by name, then "No program"), or `null` when nothing is in a program of its own.
 */
export function groupByProgram({ items, programIdOf, programs }) {
  const list = programs ?? [];
  const own = new Map(list.filter((program) => !program.is_default).map((p) => [String(p.id), p]));
  /** @type {Map<string, string[]>} */
  const byProgram = new Map();
  /** @type {string[]} */
  const inNone = [];
  for (const item of items ?? []) {
    const programId = programIdOf(item);
    if (programId && own.has(String(programId))) {
      const ids = byProgram.get(String(programId)) ?? [];
      ids.push(item.id);
      byProgram.set(String(programId), ids);
    } else {
      inNone.push(item.id);
    }
  }
  if (byProgram.size === 0) return null;
  const groups = [...byProgram.entries()]
    .map(([programId, ids]) => ({ key: programId, label: own.get(programId).name, ids }))
    .sort((a, b) => a.label.localeCompare(b.label));
  if (inNone.length > 0) groups.push({ key: 'none', label: NO_PROGRAM_LABEL, ids: inNone });
  return groups;
}
