/**
 * One team's calendar feed, from the reads to the VCALENDAR text (8.6 3b PR 12b).
 *
 * ## Why this is not inside `calendar-feed/index.ts`
 *
 * The handler imports `serve` and `createClient` from URLs, so no test can
 * import it, and `tests/calendarFeed.test.js` could only pin its source with
 * regexes. That was enough while the handler passed its reads straight to the
 * renderer. It stopped being enough when PR 12 added a third read whose rows
 * must reach `buildFeedEvents`: the handler reading `practice_exceptions` and
 * then passing `exceptions: []` would satisfy every source pin and show every
 * family the bare series (plan §6, W11's plant).
 *
 * So everything after the token check lives here, with the client injected.
 * `index.ts` validates the token, builds the service-role client and calls
 * {@link composeTeamFeed}; `_shared/tests/ics-feed_test.ts` and
 * `tests/calendarFeed.test.js` call it with a fake client serving seeded rows,
 * and assert the rendered calendar against the seed.
 *
 * ## Reads
 *
 * All five run under the service role (the feed is public, token-gated), so
 * each is scoped here rather than by RLS:
 *
 * - `season_settings` through `readSeasonTimezone` (the one server-side read
 *   of a season's clock);
 * - `current_game_runs` by the team's organization (and season), then `game_assignments` of those runs by
 *   organization and by home or away team (F11-3: the saved schedule, not the legacy `games` table);
 * - `practice_assignments` by team;
 * - `practice_exceptions` by team **and** the team's organization (R4), live
 *   rows only, with the relocated slot embedded as `slot`. The twin filters
 *   withdrawn rows again itself (plan §3 rule 2), whatever this selects.
 *
 * A failed read never 500s and is never silent: it is pushed to
 * `readFailures`, which the renderer says in the CALDESC, and it is logged.
 *
 * @module _shared/calendar/teamFeed
 */

import {
  buildFeedEvents,
  PRACTICE_CHANGES_READ,
  renderIcsCalendar,
  summariseUnplaceable,
  type FeedEvent,
  type GameRow,
  type PracticeExceptionRow,
  type PracticeRow,
} from './icsFeed.ts';
import type { PracticeExceptionsResult } from './practiceExceptions.ts';
import { readSeasonTimezone, type SeasonSettingsReader } from '../timing/seasonSettings.ts';

/** The team row `index.ts` has already validated against the token. */
export interface FeedTeam {
  id: string;
  name: string;
  organization_id: string | null;
  /**
   * The team's own season (its division's `season_settings_id`). The feed reads
   * that season's clock, as the team portal does (`PORTAL_TEAM_SELECT`); without
   * it, `readSeasonTimezone` falls back to the organization's newest season.
   */
  season_settings_id?: string | null;
}

/**
 * The client, structurally. `from()` is typed loosely on purpose: matching
 * supabase-js 2.87's builder against a structural type overflows TypeScript's
 * instantiation depth (TS2589, #483), which is why `index.ts` already casts
 * for `readSeasonTimezone`. The shape is exercised by the fake client in the
 * tests, which is the builder surface this module actually calls.
 */
export interface TeamFeedClient {
  // deno-lint-ignore no-explicit-any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from(table: string): any;
}

export type FeedLog = (message: string, details: Record<string, unknown>) => void;

/**
 * The `practice_exceptions` columns the twin reads, and the relocated slot.
 * `practice_slot_id` is used as the embed's hint and not selected: the twin
 * reads the embedded `slot`, never the id.
 */
export const PRACTICE_EXCEPTIONS_SELECT =
  'id, assignment_id, window, kind, tbd_reason, cause_kind, withdrawn_at, ' +
  'slot:practice_slots!practice_slot_id ( day_of_week, start_time, end_time, fields(name, locations(name)) )';

/**
 * A saved game as the feed reads one: its own instants, and its slot (hinted by column: `game_assignments` has two
 * foreign keys to `game_slots`) for the ground and the wall reading.
 */
export const SAVED_GAMES_SELECT =
  'id, start, end, ' +
  'game_slots!game_slot_id ( slot_date, start_time, end_time, start, end, fields(name, locations(name)) )';

/** The most games one read asks for: PostgREST's `max_rows`, as {@link PRACTICE_EXCEPTIONS_READ_CAP}. */
export const SAVED_GAMES_READ_CAP = 1000;

/**
 * The most exception rows one read asks for: the project's PostgREST
 * `max_rows` (`supabase/config.toml`). PostgREST truncates at that cap without
 * an error, so a read that comes back full is said as incomplete rather than
 * trusted as the whole set.
 */
export const PRACTICE_EXCEPTIONS_READ_CAP = 1000;

export interface TeamFeedResult {
  ics: string;
  events: FeedEvent[];
  readFailures: string[];
  /** The twin's result, as `buildFeedEvents` reported it. */
  practiceExceptions: PracticeExceptionsResult | null;
}

/**
 * Read one team's schedule and render its feed.
 *
 * @param input.client a service-role client (or a test's fake)
 * @param input.team the validated team row
 * @param input.orgName the calendar's PRODID owner
 * @param input.now pins DTSTAMP in tests
 * @param input.log where read failures and findings are reported; `console.error` by default
 */
export async function composeTeamFeed(input: {
  client: TeamFeedClient;
  team: FeedTeam;
  orgName: string;
  now?: Date;
  log?: FeedLog;
}): Promise<TeamFeedResult> {
  const { client, team, orgName, now, log = (m, d) => console.error(m, d) } = input;
  const teamId = team.id;
  const organizationId = team.organization_id;

  // 1. The season's timezone.
  //
  // No default. A season with no timezone refuses rather than guessing; the
  // hardcoded `America/New_York` this replaced was the bug, not the safety
  // net.
  //
  // `readSeasonTimezone` rather than a query written out here: its own header
  // calls itself "the one server-side read of a season's clock", and a second
  // copy in this file is how `.single()` ends up fixed on one arm and not the
  // other -- the twin-arm shape this whole change exists to stop.
  const season = await readSeasonTimezone(
    client as SeasonSettingsReader,
    organizationId,
    team.season_settings_id ?? null
  );
  if (season.errored) {
    // Not fatal. A feed that 500s takes every family's calendar down; every
    // event becomes TIME TBD instead, which says the true thing.
    log('calendar-feed: season_settings read failed', { organizationId, message: season.message });
  }
  const timezone = season.timezone;

  // 2. Games: the saved schedule (F11-3 of docs/changes/2026-11-06-games-table-source-of-truth.md).
  //
  // A game is a row of `game_assignments`, and a season's schedule is the games of its current game run, which
  // `current_game_runs` names (the rule of the Games page). A game left behind in an older run is not shown. Both
  // reads are scoped by the team's organization here: the service role has no row policy to do it. The game's own
  // `start` and `end` are when it is played (an imported game can end at another time than its slot); the slot
  // gives the ground and the wall reading `placeSlotTime` falls back to.
  //
  // A failed read is recorded, not swallowed: it is rendered into the
  // CALDESC below, because an empty feed reads as "nothing scheduled".
  const readFailures: string[] = [];
  let games: GameRow[] = [];
  if (!organizationId) {
    // As the exceptions read below: `.eq('organization_id', null)` matches nothing and would read as "no games".
    log('calendar-feed: games read failed, team has no organization', { teamId });
    readFailures.push('games');
  } else {
    let runsQuery = client
      .from('current_game_runs')
      .select('run_id')
      .eq('organization_id', organizationId);
    if (team.season_settings_id) {
      runsQuery = runsQuery.eq('season_settings_id', team.season_settings_id);
    }
    const { data: runs, error: runsError } = await runsQuery;
    if (runsError) {
      log('calendar-feed: games read failed (current_game_runs)', {
        teamId,
        message: runsError.message,
      });
      readFailures.push('games');
    } else {
      const runIds = ((runs ?? []) as Array<{ run_id: string }>).map((run) => run.run_id);
      // No current run is a season with no saved schedule: nothing to read, and nothing failed.
      if (runIds.length > 0) {
        const { data, error: gamesError } = await client
          .from('game_assignments')
          .select(SAVED_GAMES_SELECT)
          .eq('organization_id', organizationId)
          .in('run_id', runIds)
          .or(`home_team_id.eq.${teamId},away_team_id.eq.${teamId}`)
          .order('id', { ascending: true })
          .limit(SAVED_GAMES_READ_CAP);
        if (gamesError) {
          log('calendar-feed: games read failed', { teamId, message: gamesError.message });
          readFailures.push('games');
        } else {
          games = (data ?? []) as GameRow[];
          if (games.length >= SAVED_GAMES_READ_CAP) {
            // Shown as read, and said: games past the cap may be missing.
            log('calendar-feed: games read failed to stay under the row cap', {
              teamId,
              rows: games.length,
            });
            readFailures.push('games');
          }
        }
      }
    }
  }

  // 3. Practice assignments.
  const { data: practices, error: practicesError } = await client
    .from('practice_assignments')
    .select(
      `
          id,
          effective_date_range,
          practice_slots!practice_slot_id ( day_of_week, start_time, end_time, fields(name, locations(name)) )
       `
    )
    .eq('team_id', teamId);

  if (practicesError) {
    log('calendar-feed: practice_assignments read failed', {
      teamId,
      message: practicesError.message,
    });
    readFailures.push('practices');
  }

  // 4. Saved practice exceptions (R4). Scoped by the team's organization as
  // well as the team: this runs under the service role. A team with no
  // organization cannot be scoped, so the read is not attempted and is said
  // as failed -- `.eq('organization_id', null)` would match nothing and read
  // as "no changes".
  let exceptions: PracticeExceptionRow[] = [];
  if (!organizationId) {
    log('calendar-feed: practice_exceptions not read, team has no organization', { teamId });
    readFailures.push(PRACTICE_CHANGES_READ);
  } else {
    // Live rows only. Withdrawn rows are kept forever (withdrawn, never
    // edited), so an unfiltered read grows with every re-plan toward the
    // row cap. The twin still filters withdrawn rows itself (plan §3 rule 2),
    // so this filter is an economy, not the guarantee.
    const { data, error } = await client
      .from('practice_exceptions')
      .select(PRACTICE_EXCEPTIONS_SELECT)
      .eq('team_id', teamId)
      .eq('organization_id', organizationId)
      .is('withdrawn_at', null)
      .order('id', { ascending: true })
      .limit(PRACTICE_EXCEPTIONS_READ_CAP);
    if (error) {
      // Q5: not a 500 and not hidden. The practices still show, and the
      // CALDESC says they may be superseded.
      log('calendar-feed: practice_exceptions read failed', { teamId, message: error.message });
      readFailures.push(PRACTICE_CHANGES_READ);
    } else {
      exceptions = (data ?? []) as PracticeExceptionRow[];
      if (exceptions.length >= PRACTICE_EXCEPTIONS_READ_CAP) {
        // Applied as read, and said: rows past the cap may be missing.
        log('calendar-feed: practice_exceptions read reached the row cap', {
          teamId,
          rows: exceptions.length,
        });
        readFailures.push(PRACTICE_CHANGES_READ);
      }
    }
  }

  // 5. Place every occurrence on the season clock.
  const report: { applied: PracticeExceptionsResult | null } = { applied: null };
  const events = buildFeedEvents({
    teamName: team.name,
    timezone,
    games,
    practices: (practices ?? []) as PracticeRow[],
    exceptions,
    onPracticeExceptions: (result) => {
      report.applied = result;
    },
  });

  const { applied } = report;
  if (applied && applied.findings.length > 0) {
    // Findings the family never sees (a shadowed TBD, an exception on a row
    // not read, a relocation that adds fewer dates than it removes). They
    // reach whoever can fix them.
    const byCode: Record<string, number> = {};
    for (const f of applied.findings) byCode[f.code] = (byCode[f.code] ?? 0) + 1;
    log('calendar-feed: practice exceptions reported findings', {
      teamId,
      byCode,
      meta: applied.meta,
    });
  }

  const unplaceable = summariseUnplaceable(events);
  if (unplaceable.count > 0) {
    // Logged as well as rendered: the CALDESC reaches the family, this
    // reaches whoever can fix it.
    log('calendar-feed: events could not be placed on the season clock', {
      teamId,
      organizationId,
      timezone,
      unplaceableCount: unplaceable.count,
      totalCount: events.length,
      byCode: unplaceable.byCode,
    });
  }

  // 6. Render (strict RFC 5545, CRLF).
  const ics = renderIcsCalendar({
    orgName,
    teamName: team.name,
    timezone,
    events,
    readFailures,
    now,
  });

  return { ics, events, readFailures, practiceExceptions: applied };
}
