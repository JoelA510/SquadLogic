/**
 * Writer v3's locked refusal, told apart from every other save failure.
 *
 * Operator ruling 2: every saved practice row is locked. A save that would
 * delete, re-range or move one is refused, unless it names that row in
 * `unlock`. The writer raises SQLSTATE 22023 with one message shape at both
 * of its lock sites (`20261002000000_practice_exceptions_daylight.sql`):
 *
 *   assignment <id> is locked: <why> -- ...
 *
 * The scheduling grid never sends `unlock`, so an override of a team that
 * already has a saved practice reaches this refusal. The raw text names the
 * row only by its id, which tells an operator nothing.
 *
 * What reaches the page depends on the Edge's route (`practice-persistence`):
 *
 * - an ordinary save (no `repair` body) keeps a 500 with the RPC's message
 *   and no code (`_shared/practice-repair-errors.ts`, witness 21). The
 *   SQLSTATE is not relayed, so the message shape is the only evidence;
 * - a repair save maps 22023 + "is locked" to 409 `PRACTICE_ASSIGNMENT_LOCKED`,
 *   with the message kept;
 * - a caller holding the raw PostgREST error sees `code: '22023'`.
 *
 * Any other code is a different refusal, even if its text mentions a lock.
 */

/** The Edge's code for the writer's locked refusal on a repair save. */
export const PRACTICE_ASSIGNMENT_LOCKED = 'PRACTICE_ASSIGNMENT_LOCKED';

const LOCKED_MESSAGE = /^assignment (\S+) is locked:/;

/**
 * @param {unknown} error - what the persistence client threw
 * @returns {{ assignmentId: string|null } | null} the refused row's id (null
 *   when the refusal is certain but names no row), or null when this is not
 *   the locked refusal
 */
export function parsePracticeLockRefusal(error) {
  const err = /** @type {{ code?: unknown, message?: unknown } | null} */ (error);
  const code = err?.code ?? null;
  const match = LOCKED_MESSAGE.exec(String(err?.message ?? ''));
  if (code === PRACTICE_ASSIGNMENT_LOCKED) return { assignmentId: match?.[1] ?? null };
  if (match && (code === null || code === '22023')) return { assignmentId: match[1] };
  return null;
}

const UNSUPPORTED = "Changing a saved practice from the scheduling grid isn't supported yet.";

/**
 * The operator's sentence for a locked refusal. Never the row id: a row the
 * page cannot resolve gets an honest generic sentence instead.
 *
 * @param {{ teamName?: string|null, series?: string|null } | null} locked -
 *   the refused row as the page resolved it, or null when it could not
 * @returns {string}
 */
export function describePracticeLockRefusal(locked) {
  const teamName = locked?.teamName ?? null;
  const series = locked?.series ? ` (${locked.series})` : '';
  const subject = teamName
    ? `${teamName}'s practice${series}`
    : series
      ? `A saved practice${series}`
      : 'A saved practice in this schedule';
  return `${subject} is locked, so nothing was saved. ${UNSUPPORTED}`;
}
