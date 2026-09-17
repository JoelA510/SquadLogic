/**
 * Edge Function: calendar-feed
 *
 * The ICS feed a family subscribes to in Apple/Google Calendar. Every game and
 * practice a team plays, as VEVENTs.
 *
 * ## LIVE-5: what this file used to emit
 *
 * Three defects, all of them reaching subscribers:
 *
 * 1. The games select asked for `game_slots ( start_time, end_time )` -- bare
 *    Postgres `time` columns -- and then did `new Date(slot.start_time)`.
 *    `new Date('16:00:00')` is **Invalid Date**, so `formatIcsDate` emitted
 *    `NaNNaNNaNTNaNNaNNaNZ` into DTSTART and DTEND **for every game**. The
 *    select never asked for `slot_date` at all, so there was nothing to
 *    compose a date from.
 * 2. `timezone` defaulted to a hardcoded `'America/New_York'`, overridden only
 *    `if (settings?.timezone)`. The column did not exist on a freshly built
 *    database (LIVE-9), had no writer anywhere (LIVE-10), and the `.single()`
 *    errored outright for any organization with more than one season -- three
 *    independent routes to the fallback, so **every club in the world got
 *    Eastern**, silently. The calendar's timezone had never once been the
 *    season's.
 * 3. The practice arm built ``new Date(`${isoDate}T${slot.start_time}Z`)`` --
 *    appending `Z` to a naive local time, asserting the club practises in UTC.
 *    Its own comment admitted this and deferred it.
 *
 * All three are one root: a wall reading turned into an instant with no zone.
 * The fix is `_shared/timing/seasonClock.ts`, the Deno arm of the season clock,
 * which takes the zone as a parameter and refuses rather than guessing.
 *
 * ## What the feed says when it cannot place an event
 *
 * See `_shared/calendar/icsFeed.ts`, which holds the whole decision: an
 * unplaceable event becomes an all-day `TIME TBD` VEVENT carrying its reason
 * code, the calendar's `X-WR-CALDESC` carries a bucketed count, and
 * `X-WR-TIMEZONE` is emitted only when the season actually has a zone.
 *
 * The feed still answers 200 with a valid VCALENDAR in that case. Refusing the
 * whole response would break the calendar app of every subscribed family over
 * a setting only an admin can fix.
 *
 * ## Why the generation lives in `_shared`
 *
 * `tests/calendarFeed.test.js` used to "cover" this file by re-declaring
 * `formatIcsDate` and the generator inside the test and asserting against the
 * copy. It passed for the entire life of defect 1 above, because the copy was
 * never handed a bare `time`. The logic is now imported by the function and by
 * both test arms, so there is one implementation to be wrong.
 */

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.87.1';
import {
  buildFeedEvents,
  renderIcsCalendar,
  summariseUnplaceable,
  type GameRow,
  type PracticeRow,
} from '../_shared/calendar/icsFeed.ts';

serve(async (req) => {
  try {
    const url = new URL(req.url);
    const token = url.searchParams.get('token');

    if (!token) {
      return new Response('Missing calendar token', { status: 400 });
    }

    // Initialize Supabase with Service Role to bypass RLS for public feed
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

    if (!supabaseUrl || !supabaseServiceKey) {
      console.error('Missing Env Vars');
      return new Response('Internal Server Error', { status: 500 });
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // 1. Validate Token and Fetch Team (Phase 2.3: includes expiry check)
    const { data: team, error: teamErr } = await supabase
      .from('teams')
      .select(
        'id, name, organization_id, division_id, calendar_token_expires_at, organizations(name)'
      )
      .eq('calendar_token', token)
      .single();

    if (teamErr || !team) {
      return new Response('Invalid calendar token or team not found.', { status: 404 });
    }

    // Phase 2.3 (H-2): Check token expiry
    if (team.calendar_token_expires_at) {
      const expiresAt = new Date(team.calendar_token_expires_at);
      if (expiresAt < new Date()) {
        return new Response(
          'Calendar token has expired. Please ask your coach or admin to regenerate the calendar link.',
          { status: 403 }
        );
      }
    }

    const teamId = team.id;
    const organizationId = team.organization_id;
    const orgName = team.organizations?.name || 'SquadLogic';

    // 2. Fetch the season's timezone.
    //
    // No default. A season with no timezone refuses rather than guessing; the
    // hardcoded `America/New_York` this replaced was the bug, not the safety
    // net.
    //
    // `.order(created_at desc).limit(1)` rather than `.single()`: an
    // organization legitimately has several `season_settings` rows -- the
    // season switcher in `OrganizationContext` lists them and defaults to the
    // newest -- and `.single()` errors on more than one row, which yielded
    // `settings: null` and fell through to Eastern. Newest-first is the
    // contract the frontend already uses for "the current season".
    let timezone: string | null = null;
    if (organizationId) {
      const { data: settings, error: settingsError } = await supabase
        .from('season_settings')
        .select('timezone, created_at')
        .eq('organization_id', organizationId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (settingsError) {
        console.error('calendar-feed: season_settings read failed', {
          organizationId,
          message: settingsError.message,
        });
      }
      const value = settings?.timezone;
      timezone = typeof value === 'string' && value.trim() ? value.trim() : null;
    }

    // 3. Fetch Games.
    //
    // `slot_date` is the column this select was missing entirely: it asked for
    // the two `time` columns alone and fed them straight to `new Date()`.
    // `start`/`end` are the `timestamptz` pair, preferred when a row carries
    // them -- the order `normalizeGameSlot` already uses.
    const { data: games, error: gamesError } = await supabase
      .from('games')
      .select(
        `
          id,
          game_slots ( slot_date, start_time, end_time, start, end, fields(name, locations(name)) ),
          teams!games_home_team_id_fkey(name),
          teams!games_away_team_id_fkey(name)
      `
      )
      .or(`home_team_id.eq.${teamId},away_team_id.eq.${teamId}`);

    if (gamesError) {
      console.error('calendar-feed: games read failed', { teamId, message: gamesError.message });
    }

    // 4. Fetch Practice Assignments
    const { data: practices, error: practicesError } = await supabase
      .from('practice_assignments')
      .select(
        `
          id,
          effective_date_range,
          practice_slots ( day_of_week, start_time, end_time, fields(name, locations(name)) )
       `
      )
      .eq('team_id', teamId);

    if (practicesError) {
      console.error('calendar-feed: practice_assignments read failed', {
        teamId,
        message: practicesError.message,
      });
    }

    // 5. Place every occurrence on the season clock.
    const events = buildFeedEvents({
      teamName: team.name,
      timezone,
      games: (games ?? []) as unknown as GameRow[],
      practices: (practices ?? []) as unknown as PracticeRow[],
    });

    const unplaceable = summariseUnplaceable(events);
    if (unplaceable.count > 0) {
      // Logged as well as rendered: the CALDESC reaches the family, this
      // reaches whoever can fix it.
      console.error('calendar-feed: events could not be placed on the season clock', {
        teamId,
        organizationId,
        timezone,
        unplaceableCount: unplaceable.count,
        totalCount: events.length,
        byCode: unplaceable.byCode,
      });
    }

    // 6. Render (strict RFC 5545, CRLF).
    const icsString = renderIcsCalendar({
      orgName,
      teamName: team.name,
      timezone,
      events,
    });

    return new Response(icsString, {
      headers: {
        'Content-Type': 'text/calendar; charset=utf-8',
        'Content-Disposition': `attachment; filename="${team.name.replace(/[^a-zA-Z0-9_-]/g, '_')}_Schedule.ics"`,
      },
      status: 200,
    });
  } catch (err) {
    console.error('Calendar Feed Error:', err);
    return new Response('Internal Server Error', { status: 500 });
  }
});
