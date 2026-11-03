import React, { useMemo } from 'react';
import PropTypes from 'prop-types';
import { Link } from 'react-router-dom';
import Badge from '../ui/Badge.jsx';
import {
  FIXES_UNCHECKED,
  FLAGGED_DATES_SHOWN,
  OUTLOOK_BANNER,
  OUTLOOK_VERDICT,
  buildDaylightOutlook,
} from '../../utils/daylightOutlook.js';

/** The count line for each outlook, in the order the table lists them. */
const COUNT_LABEL = Object.freeze({
  [OUTLOOK_VERDICT.FLAGGED]: 'Flagged on some dates',
  [OUTLOOK_VERDICT.UNKNOWN]: 'Sunset unknown',
  [OUTLOOK_VERDICT.RETIMED]: 'Need retiming',
  [OUTLOOK_VERDICT.EXEMPT]: 'Under portable lighting',
  [OUTLOOK_VERDICT.OK]: 'End by sunset as planned',
  [OUTLOOK_VERDICT.NO_DATES]: 'No practice dates',
});

/** Where a fix's link goes. */
const LINK_TARGET = Object.freeze({
  lighting: { to: '/schedule/practice-lighting', label: 'Open Practice lighting' },
  fields: { to: '/fields', label: 'Open Fields & Venues' },
});

/**
 * The flagged dates of one slot: the first few in full, the rest behind a
 * native disclosure. Each says it is kept as scheduled and flagged.
 */
function FlaggedDates({ flagged }) {
  const shown = flagged.items.slice(0, FLAGGED_DATES_SHOWN);
  const rest = flagged.items.slice(FLAGGED_DATES_SHOWN);
  return (
    <>
      <ul className="m-0 mt-2 list-disc pl-4" data-testid="daylight-flagged">
        {shown.map((item) => (
          <li key={item.date} data-testid="daylight-flagged-date">
            {item.text}
          </li>
        ))}
      </ul>
      {rest.length > 0 && (
        <details className="mt-1">
          <summary className="cursor-pointer text-sm">
            Show the other {rest.length} flagged {rest.length === 1 ? 'date' : 'dates'}
          </summary>
          <ul className="m-0 mt-1 list-disc pl-4">
            {rest.map((item) => (
              <li key={item.date} data-testid="daylight-flagged-date">
                {item.text}
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}

FlaggedDates.propTypes = { flagged: PropTypes.object.isRequired };

/** @param {{ row: import('../../utils/daylightOutlook.js').OutlookRow }} props */
function OutlookTableRow({ row }) {
  const { verdict } = row;
  return (
    <tr data-testid="daylight-row" data-verdict={verdict.key}>
      <td className="align-top">
        <div className="px-3 py-2 text-sm">
          <div className="font-semibold text-text-primary" data-testid="daylight-slot-title">
            {row.title}
          </div>
          <div className="text-text-secondary">{row.ground}</div>
          <div className="text-xs text-text-muted">Teams: {row.teams}</div>
        </div>
      </td>
      <td className="align-top">
        <div className="px-3 py-2 text-sm">
          <Badge tone={verdict.tone} dot data-testid="daylight-verdict">
            {verdict.label}
          </Badge>
          <p className="m-0 mt-1">{verdict.headline}</p>
          {row.flagged && <FlaggedDates flagged={row.flagged} />}
          {row.unknown && (
            <p className="m-0 mt-2" data-testid="daylight-unknown">
              {row.unknown}
            </p>
          )}
          {row.exempt && (
            <p className="m-0 mt-2" data-testid="daylight-exempt">
              {row.exempt}
            </p>
          )}
        </div>
      </td>
      <td className="align-top">
        <div className="px-3 py-2 text-sm">
          <p className="m-0 text-text-secondary">{row.plan}</p>
          {row.phases.length > 0 ? (
            <ul className="m-0 mt-2 list-disc pl-4" data-testid="daylight-phases">
              {row.phases.map((phase) => (
                <li key={phase.date} data-testid="daylight-phase">
                  {phase.text}
                </li>
              ))}
            </ul>
          ) : (
            <p className="m-0 mt-2 text-text-muted">No change is proposed.</p>
          )}
        </div>
      </td>
      <td className="align-top">
        <div className="px-3 py-2 text-sm">
          {row.fixes.length > 0 ? (
            <>
              <ul className="m-0 list-disc pl-4" data-testid="daylight-fixes">
                {row.fixes.map((fix) => (
                  <li key={fix.kind}>
                    {fix.text}
                    {fix.link && (
                      <>
                        {' '}
                        <Link to={LINK_TARGET[fix.link].to} className="text-link">
                          {LINK_TARGET[fix.link].label}
                        </Link>
                      </>
                    )}
                  </li>
                ))}
              </ul>
              {row.candidatesUnchecked && (
                <p className="m-0 mt-2 text-xs text-text-muted">{FIXES_UNCHECKED}</p>
              )}
            </>
          ) : (
            <p className="m-0 text-text-muted">{row.fixesNote}</p>
          )}
        </div>
      </td>
    </tr>
  );
}

OutlookTableRow.propTypes = { row: PropTypes.object.isRequired };

/**
 * The Practice daylight outlook (duration-phase wiring, PR B): what the rest
 * of the season does to each practice slot on unlit ground, proposed and never
 * applied. Read-only. The model runs once per read of the rows, on the main
 * thread: it takes about a tenth of a second on a real league's season
 * (`tests/practiceDaylightOutlook.test.jsx` times it on the demo grid).
 *
 * A model that throws (an input the adapter refuses) is shown as its message
 * and no row: a partial or guessed report is never drawn.
 *
 * @param {{ rows: Record<string, any[]>, season: Record<string, any> }} props
 */
export default function DaylightOutlook({ rows, season }) {
  const built = useMemo(() => {
    try {
      return { ok: true, outlook: buildDaylightOutlook({ rows, season }) };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }, [rows, season]);

  if (!built.ok) {
    return (
      <p className="badge danger" role="alert" data-testid="daylight-error">
        The outlook could not be worked out over this season&rsquo;s data, so nothing is shown:{' '}
        {built.message}
      </p>
    );
  }
  const { outlook } = built;

  return (
    <div className="flex flex-col gap-4" data-testid="daylight-outlook">
      <section className="card p-3" aria-labelledby="daylight-banner-title">
        <h2 id="daylight-banner-title" className="sr-only">
          What this page does
        </h2>
        <p className="m-0 text-sm" data-testid="daylight-banner">
          {OUTLOOK_BANNER}
        </p>
        <p className="m-0 mt-2 text-sm text-text-secondary" data-testid="daylight-rules">
          {outlook.rules}
        </p>
      </section>

      <section aria-labelledby="daylight-summary-title">
        <h2 id="daylight-summary-title" className="mb-1 text-base font-bold text-text-primary">
          The season
        </h2>
        <p className="m-0 text-sm" data-testid="daylight-summary">
          {outlook.summary}
        </p>
        {outlook.counts.slots > 0 && (
          <ul className="m-0 mt-2 flex list-none flex-wrap gap-2 p-0" data-testid="daylight-counts">
            {Object.entries(COUNT_LABEL).map(([key, label]) =>
              outlook.counts.byVerdict[key] > 0 ? (
                <li key={key}>
                  <Badge tone="neutral" square>
                    {label}: {outlook.counts.byVerdict[key]}
                  </Badge>
                </li>
              ) : null
            )}
          </ul>
        )}
        {outlook.notes.length > 0 && (
          <ul className="m-0 mt-2 list-disc pl-4 text-sm" data-testid="daylight-notes">
            {outlook.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        )}
      </section>

      {outlook.counts.slots === 0 && (
        <p className="text-sm" role="status" data-testid="daylight-empty">
          {outlook.counts.litSlots > 0
            ? 'Every practice slot is on lit ground, where sunset is not judged, so there is nothing to look at.'
            : 'There are no practice slots yet, so there is nothing to look at.'}
        </p>
      )}

      {outlook.counts.slots > 0 && outlook.noCoordinates && (
        <p className="card p-3 text-sm" role="status" data-testid="daylight-no-coordinates">
          <strong>Sunset unknown.</strong> No venue with unlit practices has coordinates, so no
          sunset can be placed on any date and every unlit practice would read &ldquo;sunset
          unknown&rdquo;. Set each venue&rsquo;s coordinates on{' '}
          <Link to="/fields" className="text-link">
            Fields &amp; Venues
          </Link>{' '}
          and this page will show the season&rsquo;s outlook.
        </p>
      )}

      {outlook.counts.slots > 0 && !outlook.noCoordinates && !outlook.judged && (
        <p className="text-sm" role="status" data-testid="daylight-nothing-judged">
          No date of any unlit practice falls inside the season, so nothing was judged.
        </p>
      )}

      {outlook.counts.slots > 0 && !outlook.noCoordinates && (
        <section aria-labelledby="daylight-table-title">
          <h2 id="daylight-table-title" className="mb-1 text-base font-bold text-text-primary">
            Practice slots on unlit ground
          </h2>
          <div className="overflow-x-auto">
            <table className="grid grid-prose" data-testid="daylight-table">
              <caption className="sr-only">
                Practice slots on unlit ground, those that need attention first, with the changes
                proposed for each
              </caption>
              <thead>
                <tr>
                  <th scope="col" className="min-w-36">
                    Practice
                  </th>
                  <th scope="col" className="min-w-64">
                    Outlook
                  </th>
                  <th scope="col" className="min-w-64">
                    Proposed changes
                  </th>
                  <th scope="col" className="min-w-56">
                    Ways to fix
                  </th>
                </tr>
              </thead>
              <tbody>
                {outlook.rows.map((row) => (
                  <OutlookTableRow key={row.slotId} row={row} />
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}

DaylightOutlook.propTypes = {
  rows: PropTypes.object.isRequired,
  season: PropTypes.object.isRequired,
};
