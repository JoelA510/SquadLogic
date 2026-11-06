/**
 * The sentences the Games page says about the Published switch (plan `docs/changes/2026-11-03-schedule-expansion.md`,
 * 3.3, 3.4, 3.6, PR 3), in one place so the card, the list, the bar, the dialog and their tests agree on the words.
 *
 * The words are "Published" and "Allow changes" (owner, 2026-11-06). Not "lock", and not "override": the Edge
 * function's `overrides` field and the page's "Manual Override" mode mean something else.
 *
 * **A moved game is a new record.** The save keys a game on (home, away, slot, week) and writes no id, so a game moved
 * to another slot or week is a new row. Its Published flag, when it was published and the audit history stay with the
 * old row, and the new row starts not Published (lesson 95; the identity layer is a separate, pending decision).
 * {@link movedGameNote} says so wherever a move is offered; it does not promise anything survives a move.
 *
 * @module gamePublishedText
 */

import { GAME_PUBLISH_REASONS } from '@squadlogic/core/gamePublished.js';
import { describeScope } from './gamePublishedScope.js';

const plural = (count, one, many) => (count === 1 ? one : many);
const games = (count) => `${count} ${plural(count, 'game', 'games')}`;

/** The helper text under the optional note (owner decision 1). Verbatim. */
export const NOTE_HELPER_TEXT =
  'Optional. Do not enter player names or other personal information.';

/** What a person is told once, wherever a move is offered. */
export const movedGameNote =
  'If you then move a game to another time slot or week, it is saved as a new game. The new game starts ' +
  'not Published, so publish it again after you apply the move; this game’s history stays with the old record.';

/** The matchup as the screen names it: team names when the game has them, else the ids. */
export function matchupOf(game) {
  const home = game?.homeTeamName ?? game?.homeTeamId ?? game?.home_team_id ?? 'Home';
  const away = game?.awayTeamName ?? game?.awayTeamId ?? game?.away_team_id ?? 'Away';
  return { home: String(home), away: String(away) };
}

/** The reason's label, from the closed list. */
export function reasonLabel(code) {
  return GAME_PUBLISH_REASONS.find((reason) => reason.code === code)?.label ?? String(code ?? '');
}

/** Said when a drop or "Move to" meets a Published game. The status line carries it; nothing is staged. */
export function moveRefusal(game) {
  const { home, away } = matchupOf(game);
  return `${home} vs ${away} was not moved: it is Published. Use Allow changes on it first.`;
}

/** Said when Cancel meets a Published game. Nothing is sent. */
export function cancelRefusal(game) {
  const { home, away } = matchupOf(game);
  return `${home} vs ${away} was not cancelled: it is Published. Use Allow changes on it first, then cancel it.`;
}

/** The status line for a staged move of a game that has been Published (it has a history to leave behind). */
export function stagedMoveNote(game) {
  const { home, away } = matchupOf(game);
  return (
    'Manual game move staged. Apply the schedule to persist it. ' +
    `${home} vs ${away} will be saved as a new game, which starts not Published.`
  );
}

/** Said after an Apply that saved moved games which had a Published history. */
export function movedGamesNote(count) {
  return count === 1
    ? ' 1 moved game was saved as a new game: it starts not Published, so publish it again.'
    : ` ${count} moved games were saved as new games: they start not Published, so publish them again.`;
}

/**
 * The answer to a successful call, in words.
 *
 * @param {{ changed: number, unchanged: number }} result - summed over the calls
 * @param {boolean} published - the value that was set
 */
export function describeSetResult({ changed, unchanged }, published) {
  const done = published
    ? `Published ${games(changed)}.`
    : `Changes allowed for ${games(changed)}.`;
  const already =
    unchanged > 0
      ? published
        ? ` ${unchanged} ${plural(unchanged, 'was', 'were')} already Published.`
        : ` ${unchanged} ${plural(unchanged, 'was', 'were')} not Published.`
      : '';
  return changed === 0 ? `Nothing changed.${already}` : `${done}${already}`;
}

/**
 * The refusal, in the database's words, with how far a split call got. A bulk of more than 2,400 games is several
 * calls, and an earlier one has already changed its games.
 *
 * @param {Error & { done?: { calls: number, of: number, changed: number } }} err
 */
export function describeSetFailure(err) {
  const words = err?.message || 'The change was not saved.';
  const done = err?.done;
  if (done && done.calls > 0) {
    return (
      `${words} ${done.calls} of ${done.of} calls were saved before it stopped, ` +
      `changing ${games(done.changed)}; the rest were not changed.`
    );
  }
  return words;
}

/** The sentence under a bulk button: what it will do, counted over the saved set. */
export function describeBulkCount({ eligible, calls, verb }) {
  if (eligible === 0) return null;
  return calls > 1
    ? `${verb} ${games(eligible)}, sent in ${calls} calls of at most 2,400.`
    : `${verb} ${games(eligible)}.`;
}

/**
 * One audit row of a game's history, as a person reads it. `game.publish_overridden` is the per-game record of
 * allowing changes (reason, note, scope). `game.published_set` is one row per CALL: a call that turned the flag on
 * is the game's "Published"; one that turned it off is not shown, because the game's own override row is the same
 * act with its reason.
 *
 * @param {{ id: string, created_at: string, action: string, metadata?: Record<string, any>, actor_name?: string }} row
 * @param {(value: string) => string} formatWhen
 * @returns {null | { id: string, when: string, who: string, title: string, details: string[] }}
 */
export function describeHistoryRow(row, formatWhen) {
  const metadata = row?.metadata ?? {};
  const base = {
    id: String(row.id),
    when: formatWhen(row.created_at),
    who: row.actor_name || 'Unknown User',
  };
  if (row.action === 'game.publish_overridden') {
    const details = [`Reason: ${reasonLabel(metadata.reason_code)}`];
    if (metadata.note) details.push(`Note: ${metadata.note}`);
    if (metadata.scope) details.push(`Chosen as: ${describeScope(metadata.scope)}`);
    return { ...base, title: 'Changes allowed', details };
  }
  if (row.action === 'game.published_set' && metadata.published === true) {
    const details = [];
    if (metadata.scope) details.push(`Chosen as: ${describeScope(metadata.scope)}`);
    if (Number(metadata.count) > 1) details.push(`${metadata.count} games in that call`);
    return { ...base, title: 'Published', details };
  }
  return null;
}
