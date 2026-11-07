import React, { useEffect, useId, useMemo, useState } from 'react';
import PropTypes from 'prop-types';
import Button from '../ui/Button.jsx';
import ScrollRegion, { Cell } from './ScrollRegion.jsx';
import { usePublicationBaselines } from '../../hooks/usePublicationBaselines.js';
import {
  CHANGE_KIND,
  buildChangesSincePublication,
  changesCsv,
} from '@squadlogic/core/reports/changesSincePublication.js';
import { changesBaselineFrom, loadScheduleAuditRows } from '../../utils/scheduleReportsRead.js';
import { csvBlob, saveFile } from '../../utils/scheduleDownloads.js';

/** What the view holds between choosing a baseline and its answer arriving. */
const READING = Object.freeze({ status: 'loading' });

/**
 * "Changes since publication" (task G4): for each game, what it was in a chosen published baseline, what it is in the
 * saved schedule, and why. A view, not a store.
 *
 * A game moved to another slot or week is saved as a new game (the save keys a game on its teams, slot and week, and
 * writes no id), so it is shown as one game no longer saved and one game new, and the page says so. It never claims
 * they are the same game.
 */
export default function ChangesView({
  games,
  reference,
  timeZone,
  organizationId,
  supabaseClient,
}) {
  const selectId = useId();
  const { baselines, loading, error, readBaseline } = usePublicationBaselines();
  const [baselineId, setBaselineId] = useState('');
  const [read, setRead] = useState(/** @type {any} */ ({ id: null }));

  useEffect(() => {
    if (!baselineId) return undefined;
    let current = true;
    Promise.all([
      // The store reads the baseline and re-checks its digest; a request that is rejected is a failure of that table.
      readBaseline(baselineId).then(
        changesBaselineFrom,
        (err) =>
          /** @type {const} */ ({
            ok: false,
            table: 'publication_baselines',
            message: String(err?.message ?? err),
          })
      ),
      loadScheduleAuditRows(supabaseClient, { organizationId }),
    ]).then(([baselineResult, auditResult]) => {
      if (!current) return;
      if (baselineResult.ok === false)
        setRead({ id: baselineId, status: 'error', failed: baselineResult });
      else if (auditResult.ok === false)
        setRead({ id: baselineId, status: 'error', failed: auditResult });
      else {
        setRead({
          id: baselineId,
          status: 'ready',
          baseline: baselineResult.baseline,
          audit: auditResult,
        });
      }
    });
    return () => {
      current = false;
    };
  }, [baselineId, organizationId, supabaseClient, readBaseline]);

  const reading = baselineId && read.id !== baselineId ? READING : read;

  const result = useMemo(() => {
    if (reading.status !== 'ready') return null;
    try {
      return {
        ok: true,
        view: buildChangesSincePublication({
          baseline: reading.baseline,
          savedGames: games,
          tbdGames: reference.tbdGames,
          teams: reference.teams,
          fields: reference.fields,
          venues: reference.venues,
          slots: reference.slots,
          timeZone,
          auditRows: reading.audit.rows,
          auditLimit: reading.audit.limit,
        }),
      };
    } catch (err) {
      return { ok: false, message: String(err?.message ?? err) };
    }
  }, [reading, games, reference, timeZone]);

  const view = result?.ok ? result.view : null;
  const counts = view?.counts;
  const download = () => {
    if (view)
      saveFile(`changes-since-baseline-v${view.baseline.version}.csv`, csvBlob(changesCsv(view)));
  };

  return (
    <div data-testid="changes">
      {loading && (
        <p className="text-sm text-text-muted" role="status" data-testid="changes-not-checked">
          <strong>Not checked yet:</strong> the published baselines are being read.
        </p>
      )}
      {!loading && error && (
        <p className="text-sm text-status-error-text" role="alert" data-testid="baselines-error">
          {`Published baselines could not be read, so this says nothing about whether any exist: ${error}`}
        </p>
      )}
      {!loading && !error && baselines.length === 0 && (
        <p className="text-sm text-text-primary" data-testid="changes-no-baseline">
          No published baseline has been recorded, so there is nothing to compare the saved schedule
          against. Uploading the files from the exports above to storage records one.
        </p>
      )}
      {!loading && !error && baselines.length > 0 && (
        <div className="flex flex-wrap items-end gap-3">
          <div className="field">
            <label htmlFor={selectId}>Compare with baseline</label>
            <select
              id={selectId}
              className="select"
              value={baselineId}
              onChange={(event) => setBaselineId(event.target.value)}
            >
              <option value="">Choose a baseline</option>
              {baselines.map((baseline) => (
                <option key={baseline.id} value={baseline.id}>
                  {`v${baseline.baselineVersion}: ${baseline.label} (${baseline.recordedAt ? String(baseline.recordedAt).slice(0, 10) : baseline.publishedAt}, ${baseline.rowCount} rows)`}
                </option>
              ))}
            </select>
          </div>
          {view && (
            <Button variant="secondary" onClick={download}>
              Download changes (CSV)
            </Button>
          )}
        </div>
      )}

      {reading.status === 'loading' && (
        <p className="mt-3 text-sm text-text-muted" role="status" data-testid="changes-reading">
          <strong>Not checked yet:</strong> the baseline and the schedule audit are being read.
        </p>
      )}
      {reading.status === 'error' && (
        <p
          className="mt-3 text-sm text-status-error-text"
          role="alert"
          data-testid="changes-read-error"
        >
          {`${reading.failed.table} could not be used (${reading.failed.message}). Nothing is compared: a comparison over a baseline or an audit that could not be trusted could say a game is unchanged when it is not.`}
        </p>
      )}
      {result && !result.ok && (
        <p
          className="mt-3 text-sm text-status-error-text"
          role="alert"
          data-testid="changes-read-error"
        >
          {`The comparison could not be made (${result.message}).`}
        </p>
      )}

      {view && (
        <>
          <p className="mt-3 text-sm text-text-primary" role="status" data-testid="changes-summary">
            {`Compared with published baseline v${view.baseline.version} ("${view.baseline.label}", recorded ${String(view.baseline.recordedAt).slice(0, 10)}): ${counts.baselineGames} games then, ${counts.savedGames} now: ${counts.unchanged} unchanged, ${counts.changed} changed, ${counts.removed} no longer saved, ${counts.added} new. TIME TBD: ${counts.baselineTbd} then, ${counts.nowTbd} now.`}
          </p>
          {!view.sound && (
            <p
              className="mt-1 text-sm text-status-error-text"
              role="alert"
              data-testid="changes-unsound"
            >
              Some of the baseline could not be read, so this comparison cannot be read as a
              verdict.
            </p>
          )}
          <ul className="mt-1 text-xs text-text-muted list-disc pl-5" data-testid="changes-notes">
            {view.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
          {view.unreadable.length > 0 && (
            <ul className="mt-1 text-xs list-disc pl-5" data-testid="changes-unreadable">
              {view.unreadable.map((item, index) => (
                <li key={index}>{`${item.team} v ${item.opponent}: ${item.why}`}</li>
              ))}
            </ul>
          )}
          {view.rows.length === 0 ? (
            <p className="mt-2 text-sm text-text-primary" data-testid="changes-nothing">
              No game has changed since this baseline.
            </p>
          ) : (
            <ScrollRegion label="Games changed since the published baseline">
              <table className="grid grid-prose" data-testid="changes-table">
                <caption className="sr-only">Games changed since the published baseline</caption>
                <thead>
                  <tr>
                    <th scope="col">Change</th>
                    <th scope="col">Game</th>
                    <th scope="col">Originally</th>
                    <th scope="col">Now</th>
                    <th scope="col">Why</th>
                  </tr>
                </thead>
                <tbody>
                  {view.rows.map((row) => (
                    <tr key={row.key}>
                      <Cell>{row.label}</Cell>
                      <Cell>{`${row.division ? `${row.division}: ` : ''}${row.home} v ${row.away}`}</Cell>
                      <Cell>
                        {row.originally ?? 'Not in the baseline'}
                        {row.sameTeamsOld.length > 0 && (
                          <span className="block text-xs text-text-muted">
                            {`The same two teams were at: ${row.sameTeamsOld.join('; ')}`}
                          </span>
                        )}
                      </Cell>
                      <Cell>
                        {row.now ??
                          (row.kind === CHANGE_KIND.TBD_CLEARED
                            ? 'Not on the TIME TBD list'
                            : 'Not in the saved schedule')}
                        {row.sameTeamsNew.length > 0 && (
                          <span className="block text-xs text-text-muted">
                            {`The same two teams have a new game: ${row.sameTeamsNew.join('; ')}`}
                          </span>
                        )}
                      </Cell>
                      <Cell>
                        {row.whyLines.length > 0 ? (
                          <ul className="list-none p-0 m-0">
                            {row.whyLines.map((line) => (
                              <li key={line}>{line}</li>
                            ))}
                          </ul>
                        ) : (
                          row.whyNote || 'None recorded'
                        )}
                      </Cell>
                    </tr>
                  ))}
                </tbody>
              </table>
            </ScrollRegion>
          )}
        </>
      )}
    </div>
  );
}

ChangesView.propTypes = {
  games: PropTypes.array.isRequired,
  reference: PropTypes.object.isRequired,
  timeZone: PropTypes.string.isRequired,
  organizationId: PropTypes.string.isRequired,
  supabaseClient: PropTypes.object.isRequired,
};
