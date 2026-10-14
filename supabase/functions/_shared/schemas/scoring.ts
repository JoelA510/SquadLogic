import { z } from 'zod';
import { calendarDayNumber, wallSeconds } from '../engines/practice-live-dates.ts';

/**
 * Reusable Zod schemas for the Scoring Engine (Deno/Edge compatible)
 */

export const TeamSchema = z
  .object({
    id: z.string(),
    division: z.string(),
    coachId: z.string().nullable().optional(),
    assistantCoachIds: z.array(z.string()).nullable().optional(),
    // The `teams` column spelling; validated here so it cannot bypass the gate on its way to
    // listTeamCoachIds, which reads it when assistantCoachIds is absent.
    assistant_coach_ids: z.array(z.string()).nullable().optional(),
    organization_id: z.string().uuid().optional(),
  })
  .passthrough();

/**
 * A moment on the wire: either an instant, or a wall reading the handler will
 * compose on the season's clock.
 *
 * ## Why this is not `packages/core`'s `InstantSchema`
 *
 * Core's `InstantSchema` **refuses** a zone-less value outright, and it is
 * right to: core has no season zone at hand when it validates, so the only
 * honest answer to `'2026-11-07T16:44:00'` is "not an instant". The old
 * spelling here, `z.string().or(z.date())`, accepted that string and let
 * `new Date()` read it in the host's zone -- the schema was itself a source of
 * the defect it sat in front of (LIVE-7).
 *
 * The edge has one thing core does not: `season_settings.timezone`, read from
 * the database in the handler. So a naive value here is not an error, it is a
 * wall reading with a known clock, and refusing it would throw away a value
 * that can be placed correctly. What must never happen is a zone-less value
 * reaching an evaluator, and that is enforced by
 * `_shared/timing/anchorWallTimes.ts`, which runs before this schema's output
 * is used and turns every `start`/`end` into a `Date` or a refusal.
 *
 * So: this schema rejects what is not a moment at all, and the anchor pass
 * decides what a moment means. Both are required; neither alone is the
 * contract.
 */
export const WallTimeOrInstantSchema = z
  .union([z.string(), z.date(), z.number()])
  .refine(
    (value) => (typeof value === 'string' ? value.trim().length > 0 : true),
    'a start or end must not be blank'
  );

export const SlotSchema = z
  .object({
    id: z.string(),
    capacity: z.number().min(0),
    start: WallTimeOrInstantSchema,
    end: WallTimeOrInstantSchema,
    /**
     * The weekday this slot falls on, as the caller names it.
     *
     * Not derived when absent. `scoring-engine.ts` used to fall back to
     * `new Date(slot.start).toLocaleDateString('en-US', { weekday: 'long' })`,
     * which reads the **host's** zone: a 9pm Saturday New York practice
     * buckets as Sunday on a UTC host, which is the Supabase edge default.
     * `packages/core/src/practiceMetrics.js` never derived one -- it reads
     * `slot.day ?? 'unknown'` -- and the engine now reads it the same way.
     * One contract for one field.
     */
    day: z.string().nullable().optional(),
    organization_id: z.string().uuid().optional(),
    /**
     * The slot's dating (M4.7, `docs/PLAN_SCORING_DATE_MODEL.md` §3.4): its
     * first occurrence (`YYYY-MM-DD`, already on its weekday) and the end of
     * its validity, inclusive, plus its wall window. All four or none per
     * call (Q8): see {@link datedSlotsIssue}. Absent, the engine compares
     * first-occurrence instants as it always has (`summary.dateModel:
     * 'undated'`).
     */
    firstDate: z.string().nullable().optional(),
    lastDate: z.string().nullable().optional(),
    startTime: z.string().nullable().optional(),
    endTime: z.string().nullable().optional(),
  })
  .passthrough();

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

export const PracticeAssignmentSchema = z
  .object({
    teamId: z.string(),
    slotId: z.string(),
    /**
     * The row's `daterange` literal (stored, `[from,until+1)`) or a staged
     * placement's inclusive `[from,until]` (M4.7). Read in a dated run only;
     * absent means live on every date of its slot's validity.
     */
    effectiveDateRange: z.string().nullable().optional(),
  })
  .passthrough();

export const GameAssignmentSchema = z
  .object({
    weekIndex: z.number().positive(),
    division: z.string(),
    fieldId: z.string().optional(),
    homeTeamId: z.string(),
    awayTeamId: z.string(),
    start: WallTimeOrInstantSchema,
    end: WallTimeOrInstantSchema,
  })
  .passthrough();

export const ScoringInputSchema = z.object({
  organizationId: z.string().uuid(),
  practice: z
    .object({
      teams: z.array(TeamSchema),
      slots: z.array(SlotSchema),
      assignments: z.array(PracticeAssignmentSchema),
      unassigned: z
        .array(z.object({ teamId: z.string(), reason: z.string() }))
        .nullable()
        .optional()
        .default([]),
    })
    .nullable(),
  games: z
    .object({
      teams: z.array(TeamSchema),
      /**
       * **Parsed and unread, and it was also REQUIRED.**
       *
       * `evaluateGameSchedule` takes only `assignments` and `teams`; nothing in
       * either Edge Function reads `games.slots`. Named here rather than
       * quietly validated, because a field that reads as load-bearing and is
       * not is how a waiver gets lost. It is therefore also not placed on the
       * season clock by `fairness-scoring` -- refusing a request over a field
       * no evaluator consumes would be strictness with no subject.
       *
       * It being required was worse than decorative: `EvaluationPanel.jsx`
       * sends `games: { games, teams }` with no `slots` at all, so every game
       * evaluation from that panel failed `safeParse` and came back 400 -- a
       * mandatory field nothing reads, rejecting the one caller that sends the
       * object. Made optional here; deleting it outright is a games-engine
       * change, not a timing one.
       */
      slots: z.array(SlotSchema).optional().default([]),
      games: z.array(GameAssignmentSchema),
    })
    .nullable(),
  persist: z.boolean().optional().default(false),
  metadata: z.record(z.string(), z.any()).optional(),
});

/** The `code` of `fairness-scoring`'s 422 for a practice block with no teams or no slots. */
export const EMPTY_PRACTICE_ROSTER = 'EMPTY_PRACTICE_ROSTER';

export type EmptyPracticeRosterRefusal = {
  error: string;
  code: typeof EMPTY_PRACTICE_ROSTER;
  teamCount: number;
  slotCount: number;
};

/**
 * Refuse a practice block that has no teams or no slots (remediation M2.6).
 *
 * The engine resolves every assignment against `teams` and `slots`, so with
 * either list empty it drops every row and reports a clean schedule after
 * examining nothing; with `persist: true` that clean result was recorded as an
 * evaluation run. `EvaluationPanel` stopped sending such a request in #551
 * (`practiceRosterOf`, the same rule: both lists non-empty); this is the
 * server's own refusal, because validation is server-side.
 *
 * `null` practice (a games-only request) is not refused here.
 */
export function refuseEmptyPracticeRoster(
  practice: { teams: unknown[]; slots: unknown[] } | null | undefined
): EmptyPracticeRosterRefusal | null {
  if (!practice) return null;
  const teamCount = practice.teams.length;
  const slotCount = practice.slots.length;
  if (teamCount > 0 && slotCount > 0) return null;
  const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;
  return {
    error:
      'A practice evaluation needs at least one team and one practice slot; this request has ' +
      `${plural(teamCount, 'team')} and ${plural(slotCount, 'slot')}, so nothing would be ` +
      'examined. Nothing was evaluated or saved.',
    code: EMPTY_PRACTICE_ROSTER,
    teamCount,
    slotCount,
  };
}

export type Team = z.infer<typeof TeamSchema>;
export type Slot = z.infer<typeof SlotSchema>;
export type PracticeAssignment = z.infer<typeof PracticeAssignmentSchema>;
export type GameAssignment = z.infer<typeof GameAssignmentSchema>;
export type ScoringInput = z.infer<typeof ScoringInputSchema>;
