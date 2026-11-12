import React, { useEffect, useId, useState } from 'react';
import PropTypes from 'prop-types';
import { describeScheduleTbdReason } from '@squadlogic/core/scheduleTbd.js';
import { supabase } from '../../lib/supabaseClient.js';
import { readScheduleTbd } from '../../utils/scheduleTbdClient.js';

/**
 * The season's TIME TBD games on the Games page (plan `docs/changes/2026-11-03-schedule-expansion.md`, PR 6, task F6;
 * owner, 2026-11-09: "Time TBD should hold a date only and no time on the game schedule").
 *
 * A game an import gave a date and no time is listed with its date and no time; a game the scheduler could not place
 * has no date, and is listed with its week as it is everywhere else. The rows are the season's `schedule_tbd` games as
 * `readScheduleTbd` returns them (the table, read by the RPC with each game's `game_date`), never a second list.
 *
 * **A game that is listed here and also on the grid** is said, not hidden. The list is the table's: a game placed by
 * hand stays in it until the next save that carries a list of unplaced games (a generation), because a hand edit sends
 * none. Hiding the entry would guess that the placed game is this one; two teams can meet twice.
 *
 * Renders nothing when the season has no TIME TBD game.
 *
 * @param {Object} props
 * @param {Array<Record<string, any>>} props.rows - `get_schedule_tbd` rows of kind `game`, with `game_date`
 * @param {Array<{ homeTeamId?: string, awayTeamId?: string, weekIndex?: number }>} [props.placed] - the saved games
 * @param {string | null} [props.error] - why the list could not be read, when it could not
 */
export function GameTimeTbdList({ rows, placed = [], error = null }) {
  const headingId = useId();
  if (error) {
    return (
      <p role="alert" data-testid="game-time-tbd-error" className="text-sm text-status-error-text">
        {`The TIME TBD games could not be read: ${error}`}
      </p>
    );
  }
  const games = (rows ?? []).filter((row) => row?.kind === 'game');
  if (games.length === 0) return null;
  const onGrid = new Set(
    placed.map((a) => JSON.stringify([a.homeTeamId, a.awayTeamId, a.weekIndex]))
  );
  return (
    <section
      aria-labelledby={headingId}
      data-testid="game-time-tbd-list"
      className="glass-panel p-4 border border-border-subtle"
    >
      <h2 id={headingId} className="text-sm font-semibold text-text-primary">
        {`TIME TBD games (${games.length})`}
      </h2>
      <p className="text-xs text-text-muted max-w-prose">
        These games have no time yet, so they are not on the grid. A game with a date is listed with
        its date and no time.
      </p>
      <ul className="text-sm text-text-secondary mt-2 space-y-1">
        {games.map((row) => {
          const also = onGrid.has(
            JSON.stringify([row.home_team_id, row.away_team_id, row.week_index])
          );
          return (
            <li
              key={row.id}
              data-testid="game-time-tbd-item"
              data-dated={row.game_date ? 'yes' : 'no'}
            >
              <span className="text-text-primary">
                {`${row.division_name ? `${row.division_name}: ` : ''}${row.home_team_name ?? 'A team'} v ${
                  row.away_team_name ?? 'a team'
                }.`}
              </span>{' '}
              {row.game_date
                ? `${row.game_date}, no time yet (week ${row.week_index}).`
                : `No date yet (week ${row.week_index}).`}{' '}
              {`${describeScheduleTbdReason('game', row.reason)}.`}
              {also && (
                <span className="block text-xs text-status-warning-text">
                  These teams also have a game on the grid in this week. If it is this game, this
                  entry clears at the next generated schedule.
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

GameTimeTbdList.propTypes = {
  rows: PropTypes.arrayOf(PropTypes.object),
  placed: PropTypes.arrayOf(PropTypes.object),
  error: PropTypes.string,
};

/**
 * The list, read for a season: `readScheduleTbd` (the RPC, which gives each game its date), again whenever
 * `refreshKey` changes (the saved run the page shows). The list is an administrator's to read (`get_schedule_tbd`
 * refuses anyone else, 42501): `enabled` is the page's own answer to "may this person manage the schedule", and with it
 * false nothing is read or drawn. A 42501 from the read draws nothing either (the list is not theirs); any other
 * failure is said.
 *
 * @param {Object} props
 * @param {string | null | undefined} props.seasonSettingsId
 * @param {boolean} props.enabled
 * @param {unknown} [props.refreshKey]
 * @param {Array<{ homeTeamId?: string, awayTeamId?: string, weekIndex?: number }>} [props.placed]
 * @param {any} [props.supabaseClient] - injected for tests
 */
export default function GameTimeTbdSection({
  seasonSettingsId,
  enabled,
  refreshKey = null,
  placed = [],
  supabaseClient,
}) {
  const client = supabaseClient ?? supabase;
  // What was read, and the season it was read for: a list read for another season is never drawn for this one.
  const [state, setState] = useState(
    /** @type {{ season: string | null, rows: Array<Record<string, any>>, error: string | null }} */ ({
      season: null,
      rows: [],
      error: null,
    })
  );
  useEffect(() => {
    if (!enabled || !seasonSettingsId) return undefined;
    let current = true;
    readScheduleTbd(client, seasonSettingsId).then(
      (read) => {
        if (current) setState({ season: seasonSettingsId, rows: read.rows, error: null });
      },
      (err) => {
        if (!current) return;
        // The list is an administrator's (`get_schedule_tbd` answers 42501 to anyone else, and to a season it does
        // not hold): for a person who may manage the schedule and is not one, there is no list to draw and nothing
        // went wrong. Any other failure is said.
        const notTheirs = err?.code === '42501';
        setState({
          season: seasonSettingsId,
          rows: [],
          error: notTheirs ? null : err?.message || 'the read failed',
        });
      }
    );
    return () => {
      current = false;
    };
  }, [client, enabled, seasonSettingsId, refreshKey]);
  if (!enabled || !seasonSettingsId || state.season !== seasonSettingsId) return null;
  return <GameTimeTbdList rows={state.rows} placed={placed} error={state.error} />;
}

GameTimeTbdSection.propTypes = {
  seasonSettingsId: PropTypes.string,
  enabled: PropTypes.bool.isRequired,
  refreshKey: PropTypes.any,
  placed: PropTypes.arrayOf(PropTypes.object),
  supabaseClient: PropTypes.object,
};
