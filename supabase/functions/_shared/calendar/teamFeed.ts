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
 * All four run under the service role (the feed is public, token-gated), so
 * each is scoped here rather than by RLS:
 *
 * - `season_settings` through `readSeasonTimezone` (the one server-side read
 *   of a season's clock);
 * - `games` by home or away team;
 * - `practice_assignments` by team;
 * - `practice_exceptions` by team **and** the team's organization (R4), with
 *   the relocated slot embedded as `slot`. Withdrawn rows are read too: the
 *   twin filters them itself (plan §3 rule 2) and counts them in `meta`.
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

/** The `practice_exceptions` columns the twin reads, and the relocated slot. */
export const PRACTICE_EXCEPTIONS_SELECT =
  'id, assignment_id, window, kind, practice_slot_id, tbd_reason, cause_kind, withdrawn_at, ' +
  'slot:practice_slots!practice_slot_id ( day_of_week, start_time, end_time, fields(name, locations(name)) )';

export interface TeamFeedResult {
  ics: string;
  events: FeedEvent[];
  readFailures: string[];
  /** The twin's result: `null` only if `buildFeedEvents` never reported one. */
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
  const season = await readSeasonTimezone(client as SeasonSettingsReader, organizationId);
  if (season.errored) {
    // Not fatal. A feed that 500s takes every family's calendar down; every
    // event becomes TIME TBD instead, which says the true thing.
    log('calendar-feed: season_settings read failed', { organizationId, message: season.message });
  }
  const timezone = season.timezone;

  // 2. Games.
  //
  // `slot_date` is the column this select was missing entirely: it asked for
  // the two `time` columns alone and fed them straight to `new Date()`.
  // `start`/`end` are the `timestamptz` pair, preferred when a row carries
  // them -- the order `normalizeGameSlot` already uses.
  const { data: games, error: gamesError } = await client
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

  // A failed read is recorded, not swallowed: it is rendered into the
  // CALDESC below, because an empty feed reads as "nothing scheduled".
  const readFailures: string[] = [];
  if (gamesError) {
    log('calendar-feed: games read failed', { teamId, message: gamesError.message });
    readFailures.push('games');
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
    const { data, error } = await client
      .from('practice_exceptions')
      .select(PRACTICE_EXCEPTIONS_SELECT)
      .eq('team_id', teamId)
      .eq('organization_id', organizationId);
    if (error) {
      // Q5: not a 500 and not hidden. The practices still show, and the
      // CALDESC says they may be superseded.
      log('calendar-feed: practice_exceptions read failed', { teamId, message: error.message });
      readFailures.push(PRACTICE_CHANGES_READ);
    } else {
      exceptions = (data ?? []) as PracticeExceptionRow[];
    }
  }

  // 5. Place every occurrence on the season clock.
  let practiceExceptions: PracticeExceptionsResult | null = null;
  const events = buildFeedEvents({
    teamName: team.name,
    timezone,
    games: (games ?? []) as GameRow[],
    practices: (practices ?? []) as PracticeRow[],
    exceptions,
    onPracticeExceptions: (result) => {
      practiceExceptions = result;
    },
  });

  const applied = practiceExceptions as PracticeExceptionsResult | null;
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
