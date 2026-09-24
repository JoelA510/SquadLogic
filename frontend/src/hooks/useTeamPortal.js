import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabaseClient.js';
import { logger } from '../lib/logger.js';
import {
  PRACTICE_OCCURRENCE_REFUSAL,
  PRACTICE_TBD_CAUSES,
  practiceOccurrenceDates,
} from '@squadlogic/core/utils/practiceOccurrences.js';

/**
 * useTeamPortal
 * Fetches and manages data for the Team Portal.
 * Handles practice expansion (season wall dates, see `expandPractices`) and real-time updates.
 */
export function useTeamPortal(teamId) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [team, setTeam] = useState(null);
  const [roster, setRoster] = useState([]);
  const [events, setEvents] = useState([]);
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

      const expandedPractices = expandPractices(practiceAssignments);

      // 5. Combine and Sort Events
      const allEvents = [...mappedGames, ...expandedPractices].sort((a, b) => {
        // TIME TBD entries have no date to order by; they go last, in row order.
        if (a.date == null || b.date == null)
          return Number(a.date == null) - Number(b.date == null);
        const dateA = new Date(`${a.date}T${a.startTime}`);
        const dateB = new Date(`${b.date}T${b.startTime}`);
        return dateA.getTime() - dateB.getTime();
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
    rsvps,
    messages,
    myPlayers,
    updateRsvp,
    sendMessage,
    refresh: fetchData,
  };
}

/**
 * Expand each practice assignment into one event per occurrence.
 *
 * Every row is expanded only within its own `effective_date_range`: a team can
 * hold several rows with disjoint ranges once a repair splits a series.
 *
 * Dates are wall dates on the season's clock and are computed without a
 * `Date` (`practiceOccurrenceDates`, GAP-30). The loop this replaced parsed the
 * range start as UTC midnight and read it back with local `getDay()`, so in
 * any US zone a Monday practice rendered on the Tuesday and the last week of
 * the range was dropped (fix #64). The season timezone is not needed here:
 * the weekday of a calendar date is the same in every zone, and `startTime`
 * stays the slot's wall reading.
 *
 * A row that cannot be expanded is logged AND returned as one TIME TBD entry
 * (`timeTbd: true`, `date: null`) carrying the feed's reason code and wording
 * -- the feed reports the same row as TIME TBD, so the portal must not show
 * nothing where the calendar says TBD.
 *
 * @param {Array<Record<string, any>>} assignments
 * @returns {Array<Record<string, any>>}
 */
export function expandPractices(assignments) {
  const expanded = [];

  (assignments ?? []).forEach((assignment) => {
    const slot = assignment.slot;
    // Same fallback as the feed's `locationOf`, never 'undefined - undefined'.
    const location = `${slot?.field?.location?.name || 'Venue'} - ${slot?.field?.name || 'Field'}`;
    const timeTbd = (reasonCode) => {
      logger.error('[useTeamPortal] practice assignment cannot be expanded', {
        assignmentId: assignment.id,
        refusal: reasonCode,
      });
      expanded.push({
        id: assignment.id,
        type: 'practice',
        date: null,
        startTime: null,
        endTime: null,
        location,
        description: 'TIME TBD - Practice',
        timeTbd: true,
        reasonCode,
        reason: PRACTICE_TBD_CAUSES[reasonCode],
      });
    };
    if (!slot) {
      timeTbd(PRACTICE_OCCURRENCE_REFUSAL.SLOT_MISSING);
      return;
    }

    const { dates, refusal } = practiceOccurrenceDates({
      range: assignment.effective_date_range,
      dayOfWeek: slot.day_of_week,
    });
    if (refusal) {
      timeTbd(refusal);
      return;
    }

    for (const date of dates) {
      expanded.push({
        id: assignment.id,
        type: 'practice',
        date,
        startTime: slot.start_time,
        endTime: slot.end_time,
        location,
        description: 'Practice',
      });
    }
  });

  return expanded;
}
