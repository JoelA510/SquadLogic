import { buildPracticeAssignmentRows } from '@squadlogic/core/practiceSupabase.js';

/**
 * The daylight TIME TBD exceptions an Apply records (8.9 PR 6b, plan D13 a).
 *
 * The auto-scheduler's daylight post-pass ends a new placement the day before
 * its first date past sunset, D, and reports the remainder `[D, until]` in
 * `daylight.timeTbd`. The staged row keeps its truncated range `[from, D-1]`;
 * the remainder is recorded as a `time_tbd` exception on that row --
 * `past-sunset`, cause `daylight`, no cause id. The row does not exist until
 * this save inserts it, so the exception names it by the (team, slot, range)
 * key it will be inserted under (`new_assignment`), computed by the same
 * `buildPracticeAssignmentRows` the snapshot uses, so the two cannot differ.
 *
 * Enumerated from the REPORT, never from the saved output: one exception per
 * `timeTbd` entry that is not `withdrawn`. A withdrawn placement had no date
 * before D, has no row, and records nothing (D13 b is deferred); its team is
 * named by the writer's `teams_without_practice` instead.
 *
 * An entry whose truncated placement is not staged exactly once -- the review
 * was edited, or the report and the placements disagree -- is returned in
 * `unmatched`, never dropped: the caller refuses the Apply.
 *
 * @param {{
 *   daylight?: { timeTbd?: Array<{ teamId: string, slotId: string, from: string,
 *     until: string, withdrawn?: boolean }> } | null,
 *   assignments: Array<{ id?: string | null, teamId: string, slotId: string,
 *     effectiveFrom?: string, effectiveUntil?: string }>,
 *   slots: Array<{ id: string, effectiveFrom: string, effectiveUntil: string }>,
 * }} input - `assignments` are the persistence assignments being applied
 * @returns {{ exceptions: object[], unmatched: object[] }}
 */
export function buildDaylightExceptions({ daylight, assignments, slots }) {
  const exceptions = [];
  const unmatched = [];
  const entries = Array.isArray(daylight?.timeTbd) ? daylight.timeTbd : [];
  for (const entry of entries) {
    if (entry.withdrawn) continue;
    const lastDay = dayBefore(entry.from);
    const staged = assignments.filter(
      (assignment) =>
        !assignment.id &&
        assignment.teamId === entry.teamId &&
        assignment.slotId === entry.slotId &&
        assignment.effectiveUntil === lastDay
    );
    if (staged.length !== 1 || !lastDay || !ISO_DATE.test(entry.until ?? '')) {
      unmatched.push(entry);
      continue;
    }
    const [row] = buildPracticeAssignmentRows({ assignments: staged, slots });
    exceptions.push({
      new_assignment: {
        team_id: row.team_id,
        practice_slot_id: row.practice_slot_id,
        effective_date_range: row.effective_date_range,
      },
      window: `[${entry.from},${entry.until}]`,
      kind: 'time_tbd',
      tbd_reason: 'past-sunset',
      cause_kind: 'daylight',
    });
  }
  return { exceptions, unmatched };
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** `YYYY-MM-DD` minus one day, on the calendar (no clock), or null. */
function dayBefore(isoDate) {
  if (typeof isoDate !== 'string' || !ISO_DATE.test(isoDate)) return null;
  const date = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}
