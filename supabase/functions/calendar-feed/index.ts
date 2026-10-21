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
 *
 * Since 8.6 3b PR 12b the reads live there too (`_shared/calendar/teamFeed.ts`,
 * `composeTeamFeed`), with the client injected: this file validates the token
 * and hands over. The reason is the third read, of saved practice exceptions.
 * Its rows must reach the event builder, and only a test that runs the reads
 * against seeded rows can tell a handler that passes them from one that reads
 * them and passes `[]`.
 */

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.87.1';
import { composeTeamFeed, type TeamFeedClient } from '../_shared/calendar/teamFeed.ts';
import { logFailure, withFailureLogging } from '../_shared/logtail.ts';

const handler = withFailureLogging('calendar-feed', async (req, logCtx) => {
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

    // 1. Validate the token and fetch its team. The token lives in
    // team_calendar_tokens (20261021020000), which only admins, the team's
    // coaches and its guardians can read; the service role reads it here.
    const { data: tokenRow, error: teamErr } = await supabase
      .from('team_calendar_tokens')
      .select(
        'expires_at, team:teams(id, name, organization_id, division_id, organizations(name), division:divisions(season_settings_id))'
      )
      .eq('token', token)
      .single()
      // Untyped client: the SDK cannot see that these embeds are to-one FKs,
      // so it types them as arrays. PostgREST returns one object (or null).
      // Type-only; `overrideTypes` returns `this`.
      .overrideTypes<{
        expires_at: string | null;
        team: {
          id: string;
          name: string;
          organization_id: string;
          division_id: string | null;
          organizations: { name: string | null } | null;
          division: { season_settings_id: string | null } | null;
        } | null;
      }>();

    const team = tokenRow?.team ?? null;
    if (teamErr || !team) {
      return new Response('Invalid calendar token or team not found.', { status: 404 });
    }
    // Never the token or the URL that carries it: the token is the feed's credential.
    logCtx.organizationId = team.organization_id;

    // Phase 2.3 (H-2): Check token expiry
    if (tokenRow?.expires_at) {
      const expiresAt = new Date(tokenRow.expires_at);
      if (expiresAt < new Date()) {
        return new Response(
          'Calendar token has expired. Please ask your coach or admin to regenerate the calendar link.',
          { status: 403 }
        );
      }
    }

    const orgName = team.organizations?.name || 'SquadLogic';

    // 2. The season clock, the games, the practices and the saved practice
    // exceptions, placed and rendered. Every read failure is said in the
    // CALDESC and logged, never a 500 (see `teamFeed.ts`).
    //
    // Cast, not checked: matching supabase-js 2.87's builder against the structural client
    // overflows TypeScript's instantiation depth (TS2589, #483); runtime shape is unchanged.
    const { ics: icsString } = await composeTeamFeed({
      client: supabase as unknown as TeamFeedClient,
      team: {
        id: team.id,
        name: team.name,
        organization_id: team.organization_id,
        // The team's own season clock, as the portal reads it, not the newest season's.
        season_settings_id: team.division?.season_settings_id ?? null,
      },
      orgName,
    });

    return new Response(icsString, {
      headers: {
        'Content-Type': 'text/calendar; charset=utf-8',
        'Content-Disposition': `attachment; filename="${team.name.replace(/[^a-zA-Z0-9_-]/g, '_')}_Schedule.ics"`,
      },
      status: 200,
    });
  } catch (err) {
    await logFailure(logCtx, 'Calendar feed failed', err);
    return new Response('Internal Server Error', { status: 500 });
  }
});

serve(handler);
