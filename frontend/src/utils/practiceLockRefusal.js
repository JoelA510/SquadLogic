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

const LOCKED_MESSAGE = /^assignment (\S+) is locked: (.*?)(?: -- |$)/;

/**
 * The writer's reasons (`<why>` above), in the operator's words. A reason not
 * listed here gets no clause rather than a guess.
 */
const CAUSE_TEXT = Object.freeze({
  'the payload no longer carries its (team, slot, range) key': 'this save would replace it',
  'it is an auto row of a season team absent from the payload': 'this save leaves it out',
  'closes re-ranges it': 'this save would shorten it',
  'an exception on it is withdrawn': 'this save withdraws an exception on it',
  'a new row for its team overlaps it in time': 'a new practice for the team overlaps it',
});

/**
 * @param {unknown} error - what the persistence client threw
 * @returns {{ assignmentId: string|null, cause: string|null } | null} the
 *   refused row's id (null when the refusal is certain but names no row) and
 *   the writer's reason, or null when this is not the locked refusal
 */
export function parsePracticeLockRefusal(error) {
  const err = /** @type {{ code?: unknown, message?: unknown, status?: unknown } | null} */ (error);
  const code = err?.code ?? null;
  const match = LOCKED_MESSAGE.exec(String(err?.message ?? ''));
  const found = { assignmentId: match?.[1] ?? null, cause: match?.[2] ?? null };
  if (code === PRACTICE_ASSIGNMENT_LOCKED) return found;
  if (!match) return null;
  if (code === '22023') return found;
  // No code: only the ordinary save's 500 (or an error with no HTTP status).
  const status = err?.status ?? null;
  return code === null && (status === null || status === 500) ? found : null;
}

const UNSUPPORTED = "Changing a saved practice from the scheduling grid isn't supported yet.";

/**
 * The operator's sentence for a locked refusal. Never the row id: a row the
 * page cannot resolve gets an honest generic sentence instead.
 *
 * @param {{ teamName?: string|null, series?: string|null } | null} locked -
 *   the refused row as the page resolved it, or null when it could not
 * @param {string|null} [cause] - the writer's reason, from {@link parsePracticeLockRefusal}
 * @returns {string}
 */
export function describePracticeLockRefusal(locked, cause = null) {
  const teamName = locked?.teamName ?? null;
  const series = locked?.series ? ` (${locked.series})` : '';
  const subject = teamName
    ? `${teamName}'s practice${series}`
    : series
      ? `A saved practice${series}`
      : 'A saved practice in this schedule';
  const because = CAUSE_TEXT[cause] ? `, and ${CAUSE_TEXT[cause]}` : '';
  return `${subject} is locked${because}, so nothing was saved. ${UNSUPPORTED}`;
}
