import React, { useId, useMemo, useState } from 'react';
import PropTypes from 'prop-types';
import Button from '../ui/Button.jsx';
import {
  PUBLISHED_FILTERS,
  dateLabel,
  describePublishedCounts,
  publishedCounts,
  resolveScope,
  scopeOptions,
} from '../../utils/gamePublishedScope.js';
import { describeBulkCount } from '../../utils/gamePublishedText.js';

const KINDS = Object.freeze([
  Object.freeze({ id: 'all', label: 'All saved games' }),
  Object.freeze({ id: 'division', label: 'One division' }),
  Object.freeze({ id: 'date', label: 'One date' }),
  Object.freeze({ id: 'venue', label: 'One venue' }),
]);
const VALUE_LABEL = { division: 'Division', date: 'Date', venue: 'Venue' };

const gamesWord = (count) => (count === 1 ? 'game' : 'games');

/**
 * The Games page's Published bar (plan `docs/changes/2026-11-03-schedule-expansion.md`, 3.6, PR 3 task C2; owner
 * decisions 2 and 11): the persistent line, the list filter, and the bulk "Publish" and "Allow changes".
 *
 * - **The line** says what its numbers count (the saved games of the loaded schedule) and keeps "with changes
 *   allowed" a number of its own, so a forgotten override shows. Nothing ends an override by itself (decision 11).
 * - **The filter** shapes the LIST only. It is not an input to anything below it.
 * - **The scopes** are enumerated from `saved`, the saved set the page passes, and never from a filtered list: this
 *   component is not given one. A scope names ids, the count is on the button before anything is sent, and a list of
 *   more than 2,400 games says it goes in several calls.
 * - "Publish" acts on the games of the scope that are not Published; "Allow changes" opens the dialog for the games
 *   of the scope that are. Turning Published on needs nothing; turning it off is the dialog's deliberate act.
 *
 * @param {{
 *   saved: Array<Record<string, any>>,
 *   status: 'ready' | 'reading' | 'unreadable',
 *   summaryRef?: React.Ref<HTMLParagraphElement>,
 *   canChange: boolean,
 *   reason: string | null,
 *   reasonId: string,
 *   controlsOff: boolean,
 *   timezone?: string | null,
 *   venueOf: (game: Record<string, any>) => string | null,
 *   showFilter: boolean,
 *   filter: string,
 *   onFilterChange: (filterId: string) => void,
 *   notice: { tone: 'alert' | 'status', text: string } | null,
 *   onPublish: (input: { ids: string[], scope: { kind: string, value?: string }, count: number }) => void,
 *   onAllowChanges: (input: { games: Array<Record<string, any>>, scope: { kind: string, value?: string } }) => void,
 * }} props
 */
export default function GamePublishedBar({
  saved,
  status,
  summaryRef,
  canChange,
  reason,
  reasonId,
  controlsOff,
  timezone = null,
  venueOf,
  showFilter,
  filter,
  onFilterChange,
  notice,
  onPublish,
  onAllowChanges,
}) {
  const headingId = useId();
  const kindId = useId();
  const valueId = useId();
  const filterId = useId();
  const publishWhyId = useId();
  const allowWhyId = useId();
  const [kind, setKind] = useState('all');
  const [value, setValue] = useState('');

  const context = useMemo(() => ({ timezone, venueOf }), [timezone, venueOf]);
  const counts = useMemo(() => publishedCounts(saved), [saved]);
  const options = useMemo(() => scopeOptions(saved, context), [saved, context]);
  // A choice the saved set no longer holds (the schedule was read again) is not a choice.
  const chosen =
    kind !== 'all' && options[kind].some((option) => option.value === value) ? value : '';
  const scope = useMemo(() => ({ kind, value: chosen }), [kind, chosen]);
  const toPublish = useMemo(
    () => resolveScope(saved, scope, 'publish', context),
    [saved, scope, context]
  );
  const toAllow = useMemo(
    () => resolveScope(saved, scope, 'allow-changes', context),
    [saved, scope, context]
  );

  const showControls = canChange && counts.total > 0;
  const publishWhy = toPublish.eligible === 0 ? 'Nothing to publish in this scope.' : null;
  const allowWhy = toAllow.eligible === 0 ? 'No Published games in this scope.' : null;
  const publishNote = describeBulkCount({
    eligible: toPublish.eligible,
    calls: toPublish.calls,
    verb: 'Publish',
  });

  return (
    <section className="section-panel glass-panel" aria-labelledby={headingId}>
      <header className="section-header">
        <h2 id={headingId}>Published games</h2>
      </header>

      {/* A line that counts before its inputs have arrived says 0 of 0; it says it is reading instead (lesson 93). */}
      <p
        ref={summaryRef}
        tabIndex={-1}
        className="text-sm text-text-primary"
        data-testid="published-summary"
      >
        {status === 'ready'
          ? `${describePublishedCounts(counts)}.`
          : status === 'reading'
            ? 'Reading the saved schedule\u2026'
            : 'The saved schedule could not be read, so Published games cannot be counted.'}
      </p>

      {showFilter && (
        <div className="field mt-2">
          <label htmlFor={filterId}>Show in the list</label>
          <select
            id={filterId}
            className="select"
            value={filter}
            onChange={(event) => onFilterChange(event.target.value)}
          >
            {PUBLISHED_FILTERS.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </div>
      )}

      {reason && (
        <p id={reasonId} className="mt-2 text-sm text-text-muted" data-testid="published-reason">
          {reason}
        </p>
      )}

      {showControls && (
        <div className="mt-2" role="group" aria-label="Publish or allow changes to games in bulk">
          <div className="field">
            <label htmlFor={kindId}>Which games</label>
            <select
              id={kindId}
              className="select"
              value={kind}
              disabled={controlsOff}
              onChange={(event) => {
                setKind(event.target.value);
                setValue('');
              }}
            >
              {KINDS.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
          </div>
          {kind !== 'all' && (
            <div className="field mt-2">
              <label htmlFor={valueId}>{VALUE_LABEL[kind]}</label>
              <select
                id={valueId}
                className="select"
                value={chosen}
                disabled={controlsOff}
                onChange={(event) => setValue(event.target.value)}
              >
                <option value="">{`Choose a ${VALUE_LABEL[kind].toLowerCase()}`}</option>
                {options[kind].map((option) => (
                  <option key={option.value} value={option.value}>
                    {kind === 'date' ? dateLabel(option.value) : option.value}
                    {` (${option.count} ${gamesWord(option.count)})`}
                  </option>
                ))}
              </select>
            </div>
          )}
          <p className="mt-2 text-sm text-text-primary" data-testid="published-scope-count">
            {`In this scope: ${toPublish.eligible} not Published, ${toAllow.eligible} Published.`}
          </p>
          {publishNote && toPublish.calls > 1 && (
            <p className="text-xs text-text-muted">{publishNote}</p>
          )}
          <div className="mt-2 flex flex-wrap gap-2">
            <Button
              variant="primary"
              disabled={controlsOff || toPublish.eligible === 0}
              aria-describedby={
                controlsOff && reason ? reasonId : publishWhy ? publishWhyId : undefined
              }
              onClick={() =>
                onPublish({ ids: toPublish.ids, scope: toPublish.scope, count: toPublish.eligible })
              }
            >
              {`Publish ${toPublish.eligible} ${gamesWord(toPublish.eligible)}`}
            </Button>
            <Button
              variant="secondary"
              disabled={controlsOff || toAllow.eligible === 0}
              aria-describedby={
                controlsOff && reason ? reasonId : allowWhy ? allowWhyId : undefined
              }
              onClick={() => onAllowChanges({ games: toAllow.games, scope: toAllow.scope })}
            >
              {`Allow changes to ${toAllow.eligible} ${gamesWord(toAllow.eligible)}`}
            </Button>
          </div>
          {(publishWhy || allowWhy) && (
            <p className="mt-1 text-xs text-text-muted" data-testid="published-nothing-to-do">
              {publishWhy && <span id={publishWhyId}>{publishWhy}</span>}
              {publishWhy && allowWhy ? ' ' : null}
              {allowWhy && <span id={allowWhyId}>{allowWhy}</span>}
            </p>
          )}
        </div>
      )}

      {notice && (
        <p
          className={`mt-2 text-sm ${
            notice.tone === 'alert' ? 'text-status-error-text' : 'text-status-success-text'
          }`}
          role={notice.tone === 'alert' ? 'alert' : 'status'}
          data-testid="published-bar-notice"
        >
          {notice.text}
        </p>
      )}
    </section>
  );
}

GamePublishedBar.propTypes = {
  saved: PropTypes.arrayOf(PropTypes.object).isRequired,
  status: PropTypes.oneOf(['ready', 'reading', 'unreadable']).isRequired,
  summaryRef: PropTypes.oneOfType([PropTypes.func, PropTypes.shape({ current: PropTypes.any })]),
  canChange: PropTypes.bool.isRequired,
  reason: PropTypes.string,
  reasonId: PropTypes.string.isRequired,
  controlsOff: PropTypes.bool.isRequired,
  timezone: PropTypes.string,
  venueOf: PropTypes.func.isRequired,
  showFilter: PropTypes.bool.isRequired,
  filter: PropTypes.string.isRequired,
  onFilterChange: PropTypes.func.isRequired,
  notice: PropTypes.shape({ tone: PropTypes.string, text: PropTypes.string }),
  onPublish: PropTypes.func.isRequired,
  onAllowChanges: PropTypes.func.isRequired,
};
