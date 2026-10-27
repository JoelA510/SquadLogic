import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabaseClient.js';
import { logger } from '../lib/logger.js';
import { fetchAllPages } from '../lib/pagedFetch.js';
import { PRACTICE_TBD_CAUSES } from '@squadlogic/core/utils/practiceOccurrences.js';
import { applyPracticeExceptions } from '@squadlogic/core/utils/practiceExceptions.js';
import {
  PRACTICE_TIME_NOTE_CAUSES,
  PRACTICE_TIME_NOTE_CAUSE_UNKNOWN,
  placePracticeTime,
} from '@squadlogic/core/timing/index.js';

/**
 * The `practice_exceptions` columns the helper reads, and the relocated slot
 * (plan §4 R2). The embed names its FK column, as the feed's does (#521):
 * `practice_slot_id` is used as the hint and not selected, because nothing
 * reads the id -- the helper reads the embedded `slot`.
 */
export const PORTAL_PRACTICE_EXCEPTIONS_SELECT =
  'id, assignment_id, window, kind, tbd_reason, cause_kind, withdrawn_at, ' +
  'slot:practice_slots!practice_slot_id(day_of_week, start_time, end_time, field:fields(name, location:locations(name)))';

/**
 * The team read. The season embed carries `timezone`: the season clock every
 * practice date is placed on (`expandPractices`), the zone the feed reads from
 * the same table. `tests/teamPortalPracticeDst.test.js` pins that it is asked for.
 */
export const PORTAL_TEAM_SELECT = `
  *,
  division:divisions (
    id,
    name,
    season:season_settings (
      id,
      season_start,
      season_end,
      timezone
    )
  )
`;

/**
 * Said when the exceptions read fails (plan §10 Q5): the feed's CALDESC
 * sentence (`icsFeed.ts`), word for word. `tests/teamPortalPracticeExceptions.test.jsx`
 * pins the two equal.
 */
export const PRACTICE_CHANGES_UNREAD_TEXT =
  'INCOMPLETE: practice changes could not be read, so some practices shown may have moved or have no confirmed time.';

/** Plain code-unit order: wall dates and zero-padded wall times sort as strings. */
const order = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The order a schedule is shown in, on the team page: by
 * wall date and time, a dated TIME TBD after that day's timed events, and an
 * undated event last (a stable sort keeps those in row order). Wall dates and
 * zero-padded wall times compare as strings: a `Date` built from a dated TIME
 * TBD has no time, so it is Invalid and would unsort the list.
 *
 * @param {{ date?: string | null, startTime?: string | null }} a
 * @param {{ date?: string | null, startTime?: string | null }} b
 */
export function compareTeamEvents(a, b) {
  if (a.date == null || b.date == null) return Number(a.date == null) - Number(b.date == null);
  return (
    order(a.date, b.date) ||
    Number(a.startTime == null) - Number(b.startTime == null) ||
    order(String(a.startTime ?? ''), String(b.startTime ?? ''))
  );
}

/**
 * useTeamPortal
 * Fetches the data for the Team Portal: the team, its roster, and its games and
 * practices. Handles practice expansion (season wall dates and saved practice
 * exceptions, see `expandPractices`). Availability marking (RSVP) and team chat
 * were removed with their tables (20261022030000; plan
 * docs/changes/2026-10-22-admin-focus.md, R2), so the page reads neither and
 * subscribes to nothing.
 */
export function useTeamPortal(teamId) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [team, setTeam] = useState(null);
  const [roster, setRoster] = useState([]);
  // Why the roster is empty when the read did not return it: 'refused' (the
  // read does not admit this caller) or 'failed'; null when it was read.
  const [rosterUnavailable, setRosterUnavailable] = useState(
    /** @type {'refused' | 'failed' | null} */ (null)
  );
  const [events, setEvents] = useState([]);
  // Q5: the practices still show, and the page says their changes are unread.
  const [practiceChangesUnread, setPracticeChangesUnread] = useState(false);

  const fetchData = useCallback(async () => {
    if (!teamId) return;

    try {
      setLoading(true);

      // 1. Fetch Team Details
      const { data: teamData, error: teamError } = await supabase
        .from('teams')
        .select(PORTAL_TEAM_SELECT)
        .eq('id', teamId)
        .single();

      if (teamError) throw teamError;
      setTeam(teamData);

      // 2. Fetch Roster. Through the server-side read (20261021010000, without
      // the guardian since 20261024010000): names, jersey number
      // and balance fields for an admin, and no contact details (20261025010000). A caller it does not
      // admit gets 42501: the roster tab says so, and the rest of the page
      // (the schedule) still loads, as it reads tables every member can.
      const { data: rosterRows, error: rosterError } = await supabase.rpc('get_team_roster', {
        p_team_id: teamId,
      });

      if (rosterError) {
        logger.warn('[useTeamPortal] roster not loaded', {
          teamId,
          code: rosterError.code,
          message: rosterError.message,
        });
        setRosterUnavailable(rosterError.code === '42501' ? 'refused' : 'failed');
      } else {
        setRosterUnavailable(null);
      }

      // Deduplicate roster by player ID to prevent React key collisions
      const uniqueRoster = [];
      const seenIds = new Set();
      (rosterRows || []).forEach((row) => {
        if (row?.player_id && !seenIds.has(row.player_id)) {
          seenIds.add(row.player_id);
          uniqueRoster.push({ ...row, id: row.player_id });
        }
      });

      setRoster(uniqueRoster);

      // 3-5. The team's games and practices (with its saved practice
      // exceptions), on the team's own season clock.
      const { events: allEvents, practiceChangesUnread: changesUnread } = await fetchTeamEvents(
        teamId,
        teamData?.division?.season?.timezone ?? null
      );
      setPracticeChangesUnread(changesUnread);
      setEvents(allEvents);
    } catch (err) {
      logger.error('Error fetching Team Portal data:', err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [teamId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  return {
    loading,
    error,
    team,
    roster,
    rosterUnavailable,
    events,
    practiceChangesUnread,
    refresh: fetchData,
  };
}

/**
 * One team's schedule: its games and its practices expanded with its saved
 * practice exceptions (`expandPractices`), sorted as the team page shows
 * them. `timeZone` is the team's season clock (`PORTAL_TEAM_SELECT`'s
 * `division.season.timezone`); null makes every timed practice TIME TBD.
 *
 * A failed games or practices read throws; a failed exceptions read does not
 * (Q5): the practices still come back as the bare series, with
 * `practiceChangesUnread` true. The team page (`useTeamPortal`), the coach
 * home (admin focus R6) and the schedule exports (R7) all read a schedule
 * through this one function. `rows` are the three reads as returned, which
 * the calendar download renders through the feed's own builder; the slot's
 * `start` and `end` instants are asked for because the feed prefers them.
 *
 * @param {string} teamId
 * @param {string | null} timeZone
 * @returns {Promise<{ events: Array<Record<string, any>>, practiceChangesUnread: boolean,
 *   rows: { games: Array<Record<string, any>>, practices: Array<Record<string, any>>,
 *   exceptions: Array<Record<string, any>> } }>}
 */
export async function fetchTeamEvents(teamId, timeZone) {
  // 3. Fetch Games
  const { data: gamesData, error: gamesError } = await supabase
    .from('games')
    .select(
      `
      *,
      game_slot:game_slots (
        slot_date,
        start_time,
        end_time,
        start,
        end,
        field:fields (
          name,
          location:locations (name)
        )
      ),
      home_team:teams!home_team_id (name),
      away_team:teams!away_team_id (name)
    `
    )
    .or(`home_team_id.eq.${teamId},away_team_id.eq.${teamId}`);

  if (gamesError) throw gamesError;

  const mappedGames = gamesData.map((g) => ({
    id: g.id,
    type: 'game',
    date: g.game_slot?.slot_date,
    startTime: g.game_slot?.start_time,
    endTime: g.game_slot?.end_time,
    // A game with no slot yet has no ground: null, which the pages show as
    // "Location TBD" (it read "undefined - undefined" before R6).
    location: g.game_slot ? locationOf(g.game_slot) : null,
    homeTeam: g.home_team?.name,
    awayTeam: g.away_team?.name,
    opponent: g.home_team_id === teamId ? g.away_team?.name : g.home_team?.name,
    // For the schedule export (R7): which side the team is on, and whether the
    // game has a slot at all (a slot can lack the wall date and time).
    role: g.home_team_id === teamId ? 'Home' : 'Away',
    hasSlot: Boolean(g.game_slot),
    description: `vs ${g.home_team_id === teamId ? g.away_team?.name : g.home_team?.name}`,
  }));

  // 4. Fetch Practices and Expand
  const { data: practiceAssignments, error: practiceError } = await supabase
    .from('practice_assignments')
    .select(
      `
      *,
      slot:practice_slots!practice_slot_id (
        day_of_week,
        start_time,
        end_time,
        field:fields (
          name,
          location:locations (name)
        )
      )
    `
    )
    .eq('team_id', teamId);

  if (practiceError) throw practiceError;

  // 4b. Saved practice exceptions (plan §4 R2). RLS gates the read by
  // `is_org_member(organization_id)`, the predicate `practice_assignments`
  // has. Live rows only, as the feed reads them (#521): withdrawn rows are
  // kept forever. The helper filters withdrawn rows again itself (plan §3
  // rule 2), so this filter is an economy, not the guarantee. Paged
  // (`fetchAllPages`) rather than capped, so no read is silently truncated.
  //
  // A failure is never fatal and never silent (Q5): the practices still
  // show, as the bare series, and the page says their changes are unread.
  let practiceExceptions = [];
  let changesUnread = false;
  try {
    practiceExceptions = await fetchAllPages(() =>
      supabase
        .from('practice_exceptions')
        .select(PORTAL_PRACTICE_EXCEPTIONS_SELECT)
        .eq('team_id', teamId)
        .is('withdrawn_at', null)
    );
  } catch (exceptionsError) {
    logger.error('[useTeamPortal] practice_exceptions read failed', {
      teamId,
      message: exceptionsError?.message,
    });
    changesUnread = true;
  }

  // The team's own season clock, as the feed places on it. No default: a
  // season with no timezone shows its practices as TIME TBD, as the feed does.
  const expandedPractices = expandPractices(practiceAssignments, practiceExceptions, timeZone);

  // 5. Combine and Sort Events. Wall dates and zero-padded wall times are
  // compared as strings (a dated TIME TBD has no time, so a `Date` built
  // from it is Invalid and would unsort the list).
  const allEvents = [...mappedGames, ...expandedPractices].sort(compareTeamEvents);
  return {
    events: allEvents,
    practiceChangesUnread: changesUnread,
    // The rows as read, for the calendar download (admin focus R7), which
    // renders them through the feed's own builder (`utils/scheduleDownloads.js`).
    rows: {
      games: gamesData,
      practices: practiceAssignments ?? [],
      exceptions: practiceExceptions,
    },
  };
}

/** Same fallback as the feed's `locationOf`, never 'undefined - undefined'. */
function locationOf(slot) {
  return `${slot?.field?.location?.name || 'Venue'} - ${slot?.field?.name || 'Field'}`;
}

/** The slot a relocated occurrence replaces, as the page names it (Q3). */
function movedFromOf(o) {
  return {
    dayOfWeek: o.replaces?.day_of_week ?? null,
    startTime: o.replaces?.start_time ?? null,
    location: locationOf(o.replaces),
  };
}

/**
 * Expand each practice assignment into one event per occurrence, with the
 * team's saved practice exceptions applied (8.6 3b PR 12c, plan §4 R2).
 *
 * The dates come from core `applyPracticeExceptions`, the one function every
 * reader of stored rows goes through (the feed runs its Deno twin). It
 * expands each row only within its own `effective_date_range` -- a team can
 * hold several rows with disjoint ranges once a repair splits a series -- on
 * wall dates computed without a `Date` (GAP-30). The loop this once replaced
 * parsed the range start as UTC midnight and read it back with local
 * `getDay()`, so in any US zone a Monday practice rendered on the Tuesday
 * (fix #64). The *date* needs no timezone: the weekday of a calendar date is
 * the same in every zone. Whether that date *has* the slot's wall time does:
 * the spring-forward date has no 02:30 and the fall-back date has two 01:30s.
 * So every timed occurrence is placed on the season clock, per date, by the
 * feed's own contract (`placePracticeTime`, core's `resolveZonedInstant`): a
 * time that names no instant is a dated TIME TBD, and `startTime` stays the
 * slot's wall reading for every other date, including an ambiguous one (the
 * feed takes the earlier occurrence and notes it; so does `timingNotes`).
 *
 * What it emits, per the helper's occurrence kind:
 *
 * - `series`: a timed practice at the row's slot.
 * - `relocated`: a timed practice at the relocated slot's time and ground,
 *   `kind: 'relocated'`, with `movedFrom` naming the slot it replaces (Q3).
 *   (Either one whose wall time cannot be placed on `timeZone` that date is a
 *   dated TIME TBD instead, with the slot's ground and the timing reason code;
 *   a moved one keeps its `movedFrom`.)
 * - `time_tbd`: a **dated** TIME TBD (`date` set, `timeTbd: true`) with the
 *   reason code and wording. A tail window after the row's range shows here
 *   (plan §2, W4). No location: the feed gives none either.
 * - undated (a row refusal, or an open or unreadable window): one TIME TBD
 *   entry with `date: null`, logged -- the feed reports the same row, so the
 *   portal must not show nothing where the calendar says TBD.
 *
 * `exceptions` defaults to none for callers that predate it; the hook always
 * passes what it read. The helper's findings (for example
 * `PRACTICE_TBD_SHADOWED`) are logged, not shown, as the feed logs them.
 *
 * `timeZone` is the season's IANA zone. There is no default: `null` or a zone
 * the runtime does not know makes every timed practice TIME TBD, as the feed
 * does for a season with no timezone.
 *
 * @param {Array<Record<string, any>>} assignments
 * @param {Array<Record<string, any>>} [exceptions]
 * @param {string|null} [timeZone]
 * @returns {Array<Record<string, any>>}
 */
export function expandPractices(assignments, exceptions = [], timeZone = null) {
  const rows = (assignments ?? []).filter((row) => row && typeof row === 'object');
  const byId = new Map(rows.map((row) => [row.id, row]));
  const { occurrences, undated, findings } = applyPracticeExceptions({
    rows: /** @type {any[]} */ (rows),
    exceptions,
  });

  if (findings.length > 0) {
    logger.warn('[useTeamPortal] practice exceptions reported findings', { findings });
  }
  if (occurrences.length > 0 && !(typeof timeZone === 'string' && timeZone.trim())) {
    // Said, not silent: with no season clock every timed practice below is TIME TBD.
    logger.warn('[useTeamPortal] no season timezone; timed practices are shown as TIME TBD', {
      timeZone,
    });
  }

  const expanded = occurrences.map((o) => {
    const base = { id: o.assignmentId, type: 'practice', date: o.date };
    if (o.kind === 'time_tbd') {
      return {
        ...base,
        startTime: null,
        endTime: null,
        location: null,
        description: 'TIME TBD - Practice',
        timeTbd: true,
        reasonCode: o.code,
        reason: PRACTICE_TBD_CAUSES[o.code],
        exceptionId: o.exceptionId,
      };
    }
    // Per date, on the season clock (the feed's contract): a wall time the
    // date does not have is TIME TBD, not a fake time.
    const placed = placePracticeTime({
      date: o.date,
      startTime: o.slot?.start_time,
      endTime: o.slot?.end_time,
      timeZone,
    });
    if (placed.placed === false) {
      return {
        ...base,
        // A moved practice keeps its "Moved from" line: the family still learns it moved.
        ...(o.kind === 'relocated' ? { kind: 'relocated', movedFrom: movedFromOf(o) } : {}),
        startTime: null,
        endTime: null,
        location: locationOf(o.slot),
        description: 'TIME TBD - Practice',
        timeTbd: true,
        reasonCode: placed.code,
        reason: placed.cause,
        exceptionId: o.kind === 'relocated' ? o.exceptionId : undefined,
      };
    }
    const timingNotes = placed.notes.length
      ? {
          timingNotes: placed.notes.map(
            (code) => PRACTICE_TIME_NOTE_CAUSES[code] ?? PRACTICE_TIME_NOTE_CAUSE_UNKNOWN
          ),
        }
      : {};
    if (o.kind === 'relocated') {
      return {
        ...base,
        ...timingNotes,
        kind: 'relocated',
        startTime: o.slot.start_time,
        endTime: o.slot.end_time,
        location: locationOf(o.slot),
        description: 'Practice (moved)',
        exceptionId: o.exceptionId,
        movedFrom: movedFromOf(o),
      };
    }
    return {
      ...base,
      ...timingNotes,
      startTime: o.slot.start_time,
      endTime: o.slot.end_time,
      location: locationOf(o.slot),
      description: 'Practice',
    };
  });

  for (const entry of undated) {
    logger.error('[useTeamPortal] practice assignment cannot be expanded', {
      assignmentId: entry.assignmentId,
      exceptionId: entry.exceptionId,
      refusal: entry.code,
    });
    expanded.push({
      id: entry.assignmentId,
      type: 'practice',
      date: null,
      startTime: null,
      endTime: null,
      location: locationOf(byId.get(entry.assignmentId)?.slot),
      description: 'TIME TBD - Practice',
      timeTbd: true,
      reasonCode: entry.code,
      reason: PRACTICE_TBD_CAUSES[entry.code],
      exceptionId: entry.exceptionId,
    });
  }

  return expanded;
}
