import React, { createContext, useContext } from 'react';
import PropTypes from 'prop-types';
import Toggle from '../ui/Toggle.jsx';
import Badge from '../ui/Badge.jsx';
import { PUBLISHED_STATE_WORDS, publishedStateOf } from '../../utils/gamePublishedScope.js';
import { matchupOf } from '../../utils/gamePublishedText.js';

/**
 * What the Games page offers on a saved game's Published state, provided by `GameSchedulingPage` around the grid and
 * the list (plan `docs/changes/2026-11-03-schedule-expansion.md`, 3.6, PR 3 task C1). With no provider (a card
 * rendered on its own) a game still SAYS its state and a Published card is still not draggable; only the controls
 * are absent.
 *
 * - `canChange`: this person may turn the flag on and off (an organization admin, in a season that is not complete).
 * - `canReadHistory`: this person may read the game's audit history (an organization admin).
 * - `disabledReason`: why the controls are off right now (a staged review waits, the saved schedule is being read,
 *   a change is being saved), or null. Said once, visibly, in the bar; `reasonId` is that element's id.
 * - `publish(game)`: turn the flag on. Needs nothing else.
 * - `allowChanges(game)`: open the "Allow changes" dialog. Turning the flag off is its own deliberate, audited act.
 * - `showHistory(game)`: open the game's history.
 *
 * @type {React.Context<null | {
 *   canChange: boolean,
 *   canReadHistory: boolean,
 *   disabledReason: string | null,
 *   reasonId?: string,
 *   publish: (game: Record<string, any>) => void,
 *   allowChanges: (game: Record<string, any>) => void,
 *   showHistory: (game: Record<string, any>) => void,
 * }>}
 */
export const GamePublishedContext = createContext(null);

/** @type {Record<string, 'success' | 'warning' | 'neutral'>} */
const TONE = {
  published: 'success',
  'changes-allowed': 'warning',
  'not-published': 'neutral',
};

/**
 * One saved game's Published state: the words (never colour alone), a switch that turns it on or opens the "Allow
 * changes" dialog, an explicit "Allow changes" button on a Published game (the keyboard path that replaces "Move to"
 * for it), and a link to its history.
 *
 * The switch's name is "Published: home versus away" and its state is `aria-checked`; the words beside it say the
 * same thing for a person who does not see the switch. A game with no row yet (a staged review) has no switch and
 * says "Apply the schedule first".
 *
 * @param {{ assignment: Record<string, any>, className?: string }} props
 */
export default function PublishedControls({ assignment, className = 'mt-2' }) {
  const ctx = useContext(GamePublishedContext);
  const state = publishedStateOf(assignment);
  const { home, away } = matchupOf(assignment);
  const words = PUBLISHED_STATE_WORDS[state];

  if (state === 'unsaved') {
    return (
      <p className={`${className} text-xs text-text-muted`.trim()} data-testid="published-state">
        {words}
      </p>
    );
  }

  const isPublished = state === 'published';
  const off = Boolean(ctx?.disabledReason);
  // A press on a control is a choice, not the start of a drag of the card it sits on.
  const keepPointer = (event) => event.stopPropagation();

  return (
    <div
      className={`${className} flex flex-wrap items-center gap-2`.trim()}
      data-testid={`published-controls-${assignment.id}`}
    >
      {ctx?.canChange && (
        <span onPointerDown={keepPointer} className="inline-flex">
          <Toggle
            checked={isPublished}
            onChange={(next) => (next ? ctx.publish(assignment) : ctx.allowChanges(assignment))}
            label={`Published: ${home} versus ${away}`}
            disabled={off}
            describedBy={off ? ctx.reasonId : undefined}
          />
        </span>
      )}
      <Badge tone={TONE[state]} dot data-testid="published-state">
        {words}
      </Badge>
      {isPublished && ctx?.canChange && (
        <button
          type="button"
          className="btn btn-default sm"
          disabled={off}
          aria-describedby={off ? ctx.reasonId : undefined}
          aria-label={`Allow changes: ${home} versus ${away}`}
          onPointerDown={keepPointer}
          onClick={() => ctx.allowChanges(assignment)}
        >
          Allow changes
        </button>
      )}
      {ctx?.canReadHistory && state !== 'not-published' && (
        <button
          type="button"
          className="btn btn-subtle sm"
          aria-label={`History: ${home} versus ${away}`}
          onPointerDown={keepPointer}
          onClick={() => ctx.showHistory(assignment)}
        >
          History
        </button>
      )}
    </div>
  );
}

PublishedControls.propTypes = {
  assignment: PropTypes.object.isRequired,
  className: PropTypes.string,
};
