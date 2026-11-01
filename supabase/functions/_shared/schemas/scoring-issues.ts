/**
 * The two input checks the scoring engine and `fairness-scoring` share, in a module with NO zod
 * (Phase D PR D). They lived in `./scoring.ts` beside the request schemas, which import zod at module
 * load; the scoring engine imports them, the auto-scheduler's solver imports the engine, and the
 * browser's optimizer worker bundles the solver -- so keeping them there bundled zod (about 25 KB
 * gzip) into a worker that never parses a request. Moved here unchanged; `./scoring.ts` re-exports
 * them, so no caller's import changed but the engine's.
 */
import { calendarDayNumber, wallSeconds } from '../engines/practice-live-dates.ts';

/**
 * Why a slot list cannot be scored dated, or `null` (M4.7, plan §3.3, Q8):
 * every slot carries `firstDate` and `lastDate` or none does, and a dated slot
 * also carries `startTime` and `endTime`, ending after it starts. A mix would
 * score half a calendar as a whole one, so `fairness-scoring` refuses it with
 * a 422 rather than guess. `startTime`/`endTime` alone do not date a slot.
 * The engine (`scoring-engine.ts` `resolveDateModel`) and core refuse the same
 * inputs -- the engine by calling this, with the same readers
 * (`calendarDayNumber`, `wallSeconds` in `practice-live-dates.ts`), so the gate
 * and the engine cannot disagree on what reads; `fairness-scoring` calls it right
 * after parsing, so the refusal is a 422 naming the reason rather than the
 * engine's throw becoming a 500.
 */
export function datedSlotsIssue(
  slots: Array<{
    id: string;
    firstDate?: string | null;
    lastDate?: string | null;
    startTime?: string | null;
    endTime?: string | null;
  }>
): string | null {
  const isDated = (s: (typeof slots)[number]) =>
    (s.firstDate !== undefined && s.firstDate !== null) ||
    (s.lastDate !== undefined && s.lastDate !== null);
  const dated = slots.filter(isDated).length;
  if (dated === 0) return null;
  if (dated !== slots.length) {
    return `practice slots must all carry firstDate and lastDate, or none: ${dated} of ${slots.length} do`;
  }
  for (const s of slots) {
    const startSec = wallSeconds(s.startTime);
    const endSec = wallSeconds(s.endTime);
    if (
      calendarDayNumber(s.firstDate) === null ||
      calendarDayNumber(s.lastDate) === null ||
      startSec === null ||
      endSec === null
    ) {
      return `dated slot ${s.id} needs firstDate and lastDate (YYYY-MM-DD) and startTime and endTime (HH:MM[:SS])`;
    }
    if (startSec >= endSec) return `dated slot ${s.id} must end after it starts`;
  }
  return null;
}

/**
 * Why a call's exceptions cannot be honoured, or `null`: a non-empty
 * `exceptions` with undated slots. An exception is dated, and the undated
 * comparison (first-occurrence instants) has no date to apply it to, so it is
 * refused rather than read and ignored. Core's `evaluatePracticeSchedule`
 * refuses the same input with the same words; `fairness-scoring` answers it
 * with a 422.
 */
export function undatedExceptionsIssue(
  slots: Array<{ firstDate?: string | null; lastDate?: string | null }>,
  exceptions: unknown[] | null | undefined
): string | null {
  if (!exceptions || exceptions.length === 0) return null;
  const dated = slots.some(
    (s) =>
      (s.firstDate !== undefined && s.firstDate !== null) ||
      (s.lastDate !== undefined && s.lastDate !== null)
  );
  if (dated) return null;
  return `practice exceptions need a dated call (every slot with firstDate and lastDate): ${exceptions.length} sent with undated slots`;
}
