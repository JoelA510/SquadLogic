import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabaseClient.js';
import { logger } from '../lib/logger.js';
import { fetchAllPages } from '../lib/pagedFetch.js';
import { PRACTICE_TBD_CAUSES } from '@squadlogic/core/utils/practiceOccurrences.js';
import { applyPracticeExceptions } from '@squadlogic/core/utils/practiceExceptions.js';

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
 * Said when the exceptions read fails (plan §10 Q5): the feed's CALDESC
 * sentence (`icsFeed.ts`), word for word. `tests/teamPortalPracticeExceptions.test.jsx`
 * pins the two equal.
 */
export const PRACTICE_CHANGES_UNREAD_TEXT =
  'INCOMPLETE: practice changes could not be read, so some practices shown may have moved or have no confirmed time.';

/** Plain code-unit order: wall dates and zero-padded wall times sort as strings. */
const order = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * useTeamPortal
 * Fetches and manages data for the Team Portal.
 * Handles practice expansion (season wall dates and saved practice
 * exceptions, see `expandPractices`) and real-time updates.
 */
export function useTeamPortal(teamId) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [team, setTeam] = useState(null);
  const [roster, setRoster] = useState([]);
  const [events, setEvents] = useState([]);
  // Q5: the practices still show, and the page says their changes are unread.
  const [practiceChangesUnread, setPracticeChangesUnread] = useState(false);
  const [rsvps, setRsvps] = useState([]);
  const [messages, setMessages] = useState([]);
  const [myPlayers, setMyPlayers] = useState([]);

  const fetchData = useCallback(async () => {
    if (!teamId) return;

    try {
      setLoading(true);

      // 1. Fetch Team Details
      const { data: teamData, error: teamError } = await supabase
        .from('teams')
        .select(
          `
          *,
          division:divisions (
            id,
            name,
            season:season_settings (
              id,
              season_start,
              season_end
            )
          )
        `
        )
        .eq('id', teamId)
        .single();

      if (teamError) throw teamError;
      setTeam(teamData);

      // 2. Fetch Roster
      const { data: rosterData, error: rosterError } = await supabase
        .from('team_players')
        .select(
          `
          player:players (
            id,
            first_name,
            last_name,
            gender,
            jersey_number,
            years_played,
            rating,
            willing_to_coach
          )
        `
        )
        .eq('team_id', teamId);

      if (rosterError) throw rosterError;

      // Deduplicate roster by player ID to prevent React key collisions
      const uniqueRoster = [];
      const seenIds = new Set();
      rosterData.forEach((r) => {
        const p = Array.isArray(r.player) ? r.player[0] : r.player;
        if (p && !seenIds.has(p.id)) {
          seenIds.add(p.id);
          uniqueRoster.push(p);
        }
      });

      const medicalClearanceByPlayer = new Map();

      if (uniqueRoster.length > 0) {
        const { data: medicalStatusData, error: medicalStatusError } = await supabase.rpc(
          'get_team_portal_medical_status',
          { p_team_id: teamId }
        );

        if (medicalStatusError) {
          logger.warn('Unable to load team portal medical clearance state:', medicalStatusError);
        } else {
          (medicalStatusData || []).forEach((statusRow) => {
            if (!medicalClearanceByPlayer.has(statusRow.player_id)) {
              medicalClearanceByPlayer.set(statusRow.player_id, {
                medical_cleared: statusRow.medical_cleared === true,
                medical_clearance_visible: true,
              });
            }
          });
        }
      }

      setRoster(
        uniqueRoster.map((player) => {
          const clearance = medicalClearanceByPlayer.get(player.id);

          return {
            ...player,
            medical_cleared: clearance?.medical_cleared ?? false,
            medical_clearance_visible: clearance?.medical_clearance_visible === true,
          };
        })
      );

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
        location: `${g.game_slot?.field?.location?.name} - ${g.game_slot?.field?.name}`,
        homeTeam: g.home_team?.name,
        awayTeam: g.away_team?.name,
        opponent: g.home_team_id === teamId ? g.away_team?.name : g.home_team?.name,
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
      setPracticeChangesUnread(changesUnread);

      const expandedPractices = expandPractices(practiceAssignments, practiceExceptions);

      // 5. Combine and Sort Events. Wall dates and zero-padded wall times are
      // compared as strings (a dated TIME TBD has no time, so a `Date` built
      // from it is Invalid and would unsort the list).
      const allEvents = [...mappedGames, ...expandedPractices].sort((a, b) => {
        // Undated TIME TBD entries have no date to order by; they go last, in row order.
        if (a.date == null || b.date == null)
          return Number(a.date == null) - Number(b.date == null);
        return (
          order(a.date, b.date) ||
          // A dated TIME TBD goes after that day's timed events.
          Number(a.startTime == null) - Number(b.startTime == null) ||
          order(String(a.startTime ?? ''), String(b.startTime ?? ''))
        );
      });
      setEvents(allEvents);

      // 6. Fetch RSVPs
      const { data: rsvpData, error: rsvpError } = await supabase
        .from('event_rsvps')
        .select('*')
        .eq('team_id', teamId);

      if (rsvpError) throw rsvpError;
      setRsvps(rsvpData);

      // 7. Fetch My Players (for RSVPing)
      const { data: authData } = await supabase.auth.getUser();
      if (authData.user) {
        const { data: myPlayerData } = await supabase
          .from('profile_players')
          .select('player_id')
          .eq('profile_id', authData.user.id);

        if (myPlayerData) {
          const myIds = myPlayerData.map((mp) => mp.player_id);
          const matchedPlayers = [];
          const seenMyIds = new Set();

          rosterData?.forEach((r) => {
            const p = Array.isArray(r.player) ? r.player[0] : r.player;
            if (p && myIds.includes(p.id) && !seenMyIds.has(p.id)) {
              seenMyIds.add(p.id);
              matchedPlayers.push(p);
            }
          });
          setMyPlayers(matchedPlayers);
        }
      } else {
        logger.warn('[DEBUG] [useTeamPortal] No authenticated user found for RSVP section');
      }

      // 8. Fetch Messages
      const { data: msgData, error: msgError } = await supabase
        .from('team_messages')
        .select(
          `
          *,
          author:profiles (
            full_name
          )
        `
        )
        .eq('team_id', teamId)
        .order('created_at', { ascending: true });

      if (msgError) throw msgError;
      setMessages(msgData);
    } catch (err) {
      logger.error('Error fetching Team Portal data:', err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [teamId]);

  useEffect(() => {
    fetchData();

    // Set up Realtime Subscription for Messages
    const messageChannel = supabase
      .channel(`team_messages:${teamId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'team_messages',
          filter: `team_id=eq.${teamId}`,
        },
        async (payload) => {
          // Fetch the author's name to match the state format
          const { data: authorData } = await supabase
            .from('profiles')
            .select('full_name')
            .eq('id', payload.new.author_id)
            .single();

          const newMessage = {
            ...payload.new,
            author: authorData || { full_name: 'Unknown User' },
          };
          setMessages((current) => [...current, newMessage]);
        }
      )
      .subscribe();

    // Set up Realtime Subscription for RSVPs
    const rsvpChannel = supabase
      .channel(`event_rsvps:${teamId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'event_rsvps',
          filter: `team_id=eq.${teamId}`,
        },
        (payload) => {
          setRsvps((currentRsvps) => {
            if (payload.eventType === 'INSERT') {
              const exists = currentRsvps.some((r) => r.id === payload.new.id);
              if (exists) return currentRsvps;
              return [...currentRsvps, payload.new];
            } else if (payload.eventType === 'UPDATE') {
              return currentRsvps.map((r) => (r.id === payload.new.id ? payload.new : r));
            } else if (payload.eventType === 'DELETE') {
              return currentRsvps.filter((r) => r.id !== payload.old.id);
            }
            return currentRsvps;
          });
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(messageChannel);
      supabase.removeChannel(rsvpChannel);
    };
  }, [teamId, fetchData]);

  const updateRsvp = async (playerId, referenceId, eventType, occurrenceDate, status) => {
    try {
      const { data: profileData } = await supabase.auth.getUser();
      if (!profileData.user) throw new Error('Not authenticated');

      const { error: upsertError } = await supabase.rpc('upsert_team_event_rsvp', {
        p_team_id: teamId,
        p_player_id: playerId,
        p_reference_id: referenceId,
        p_event_type: eventType,
        p_occurrence_date: occurrenceDate,
        p_status: status,
      });

      if (upsertError) throw upsertError;
    } catch (err) {
      logger.error('Error updating RSVP:', err);
      // You could expose an error state for mutations if needed
    }
  };

  const sendMessage = async (content) => {
    try {
      const { data: authData } = await supabase.auth.getUser();
      if (!authData.user) throw new Error('Not authenticated');

      // Optimistic UI Update
      const optimisticMsg = {
        id: Date.now(),
        author: { full_name: authData.user.user_metadata?.full_name || 'You' },
        content,
        created_at: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, optimisticMsg]);

      const { error: sendError } = await supabase.rpc('create_team_message', {
        p_team_id: teamId,
        p_content: content,
      });

      if (sendError) throw sendError;
    } catch (err) {
      logger.error('Error sending message:', err);
    }
  };

  return {
    loading,
    error,
    team,
    roster,
    events,
    practiceChangesUnread,
    rsvps,
    messages,
    myPlayers,
    updateRsvp,
    sendMessage,
    refresh: fetchData,
  };
}

/** Same fallback as the feed's `locationOf`, never 'undefined - undefined'. */
function locationOf(slot) {
  return `${slot?.field?.location?.name || 'Venue'} - ${slot?.field?.name || 'Field'}`;
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
 * (fix #64). The season timezone is not needed: the weekday of a calendar
 * date is the same in every zone, and `startTime` stays the slot's wall reading.
 *
 * What it emits, per the helper's occurrence kind:
 *
 * - `series`: a timed practice at the row's slot.
 * - `relocated`: a timed practice at the relocated slot's time and ground,
 *   `kind: 'relocated'`, with `movedFrom` naming the slot it replaces (Q3).
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
 * @param {Array<Record<string, any>>} assignments
 * @param {Array<Record<string, any>>} [exceptions]
 * @returns {Array<Record<string, any>>}
 */
export function expandPractices(assignments, exceptions = []) {
  const rows = (assignments ?? []).filter((row) => row && typeof row === 'object');
  const byId = new Map(rows.map((row) => [row.id, row]));
  const { occurrences, undated, findings } = applyPracticeExceptions({
    rows: /** @type {any[]} */ (rows),
    exceptions,
  });

  if (findings.length > 0) {
    logger.warn('[useTeamPortal] practice exceptions reported findings', { findings });
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
    if (o.kind === 'relocated') {
      return {
        ...base,
        kind: 'relocated',
        startTime: o.slot.start_time,
        endTime: o.slot.end_time,
        location: locationOf(o.slot),
        description: 'Practice (moved)',
        exceptionId: o.exceptionId,
        movedFrom: {
          dayOfWeek: o.replaces?.day_of_week ?? null,
          startTime: o.replaces?.start_time ?? null,
          location: locationOf(o.replaces),
        },
      };
    }
    return {
      ...base,
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
