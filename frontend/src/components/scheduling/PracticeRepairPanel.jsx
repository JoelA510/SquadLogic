import React, { useMemo, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import { useOrganization } from '../../contexts/OrganizationContext.jsx';
import { usePracticeRepairSnapshot } from '../../hooks/usePracticeRepairSnapshot.js';
import {
  declineIn,
  namesOf,
  openPracticeRepair,
  panelRowsOf,
  undoIn,
} from '../../utils/practiceRepairPanel.js';
import Button from '../ui/Button.jsx';
import { PRACTICE_REASON } from '@squadlogic/core/practice/index.js';

/** The finding a decline or undo stamps (`practice/recommendations.js`). */
const LOCAL_CODE = PRACTICE_REASON.REPAIR_RECOMMENDATION_LOCAL;

/**
 * The practice repair recommendation panel (8.6 3b plan §7, PR 10).
 *
 * Opened by an admin from the field retirement dialog and the blackout
 * editor (`PracticeRepairLauncher`, which lazy-loads this file: the repair
 * is heavy and only an admin who asks for it pays for it).
 *
 * - **One row per displaced series-window**, the repair's own list. A TIME
 *   TBD entry is a row like any other, with its reason; nothing is hidden.
 * - **Decline and undo** run `declineRecommendation` / `undoDecline` in
 *   memory (decisions are not persisted, 3b decision 10). After any, the
 *   panel carries `PRACTICE_REPAIR_RECOMMENDATION_LOCAL`: locally repaired,
 *   not proven optimal.
 * - **Read-only.** No enact, no RPC, no write: the only client calls are the
 *   snapshot's selects. Each window shows whether a save would be refused
 *   and why (every blackout window is, until 3b PR 12), never hiding one.
 * - **A failed or partial read shows no recommendations**, only the error,
 *   in a `role="alert"`. So does an input the adapter refuses.
 *
 * @param {{ loss: Object, subject: string }} props
 */
export default function PracticeRepairPanel({ loss, subject }) {
  const org = /** @type {any} */ (useOrganization() ?? {});
  const organizationId = org.currentOrganization?.id ?? null;
  const season = org.currentSeasonSetting ?? null;
  const snapshot = usePracticeRepairSnapshot({
    organizationId,
    seasonSettingsId: season?.id ?? null,
  });
  const lossKey = JSON.stringify(loss);

  let body;
  if (snapshot.error) {
    body = (
      <p className="badge danger" role="alert" data-testid="practice-repair-error">
        The practice repair could not read the season, so no recommendation is shown:{' '}
        {snapshot.error}
      </p>
    );
  } else if (snapshot.loading || !snapshot.rows) {
    body = (
      <p className="text-sm" role="status" data-testid="practice-repair-loading">
        Reading the season&rsquo;s practices…
      </p>
    );
  } else {
    body = (
      <Recommendations
        // Keyed on every input of `opened`, so the decline state is never
        // carried over onto a result computed from a different input.
        key={`${lossKey}|${season?.timezone ?? ''}`}
        rows={snapshot.rows}
        lossKey={lossKey}
        timeZone={season?.timezone ?? null}
        subject={subject}
      />
    );
  }

  return (
    <section
      className="card mt-2 p-3"
      aria-labelledby="practice-repair-title"
      data-testid="practice-repair-panel"
    >
      <h3 id="practice-repair-title" className="text-sm" tabIndex={-1}>
        <strong>Practice repair recommendations</strong>
      </h3>
      <p className="text-sm" data-testid="practice-repair-read-only">
        Read-only. Nothing here is saved or sent: declining only re-offers a slot on this screen,
        and enacting a recommendation is not available yet.
      </p>
      {body}
    </section>
  );
}

PracticeRepairPanel.propTypes = {
  loss: PropTypes.object.isRequired,
  subject: PropTypes.string.isRequired,
};

/**
 * @param {{ rows: Record<string, any[]>, lossKey: string, timeZone: string|null, subject: string }} props
 */
function Recommendations({ rows, lossKey, timeZone, subject }) {
  const opened = useMemo(() => {
    try {
      return { ok: true, value: openPracticeRepair(rows, JSON.parse(lossKey), { timeZone }) };
    } catch (err) {
      return { ok: false, message: err?.message ?? String(err) };
    }
  }, [rows, lossKey, timeZone]);
  const [state, setState] = useState(opened.ok ? opened.value.state : null);
  const [announce, setAnnounce] = useState('');
  const [actionError, setActionError] = useState(/** @type {string|null} */ (null));
  const headingRef = useRef(/** @type {HTMLParagraphElement|null} */ (null));
  const names = useMemo(() => namesOf(rows), [rows]);
  // The payload builder runs here (for each window's refusal): guarded like
  // the repair itself, so a throw is the alert below, never a crashed dialog.
  const view = useMemo(() => {
    if (!opened.ok || !state) return null;
    try {
      return { ok: true, rows: panelRowsOf(opened.value, state, names) };
    } catch (err) {
      return { ok: false, message: err?.message ?? String(err) };
    }
  }, [opened, state, names]);

  if (!opened.ok || !state || !view?.ok) {
    const message = !opened.ok ? opened.message : view && !view.ok ? view.message : 'no state';
    return (
      <p className="badge danger" role="alert" data-testid="practice-repair-error">
        No repair could be computed for this loss over this season&rsquo;s data, so no
        recommendation is shown: {message}
      </p>
    );
  }

  const { result, adapted, daylightPlan } = opened.value;
  const windows = view.rows;

  const act = (next, message) => {
    try {
      setState(next());
      setActionError(null);
      setAnnounce(message);
    } catch (err) {
      setActionError(err?.message ?? String(err));
    }
    headingRef.current?.focus();
  };

  const local = state.findings.filter((f) => f.code === LOCAL_CODE);

  return (
    <>
      <p ref={headingRef} tabIndex={-1} className="text-sm" data-testid="practice-repair-count">
        <strong>{windows.length}</strong> practice series-window{windows.length === 1 ? '' : 's'}{' '}
        {windows.length === 1 ? 'is' : 'are'} displaced by <strong>{subject}</strong>.
      </p>
      <p className="sr-only" aria-live="polite" data-testid="practice-repair-announce">
        {announce}
      </p>
      {actionError && (
        <p className="badge danger" role="alert" data-testid="practice-repair-action-error">
          {actionError}
        </p>
      )}
      {local.length > 0 && (
        <p
          className="badge warning mt-2"
          data-testid="practice-repair-local"
          data-reason-code={LOCAL_CODE}
        >
          {LOCAL_CODE}: after {local.length} decline{local.length === 1 ? '' : 's'} or undo
          {local.length === 1 ? '' : 's'}, these recommendations are locally repaired, not proven
          optimal.
        </p>
      )}

      {windows.length === 0 ? (
        <p className="text-sm" data-testid="practice-repair-none">
          No practice series is displaced. This is the repair&rsquo;s answer over the whole season,
          not an empty panel.
        </p>
      ) : (
        <div className="overflow-x-auto mt-2">
          <table className="grid" data-testid="practice-repair-rows">
            <caption className="sr-only">
              One recommendation per practice series-window displaced by {subject}
            </caption>
            <thead>
              <tr>
                <th scope="col">Team</th>
                <th scope="col">Now</th>
                <th scope="col">Window</th>
                <th scope="col">Recommendation</th>
                <th scope="col">If saved</th>
                <th scope="col">Action</th>
              </tr>
            </thead>
            <tbody>
              {windows.map((row) => (
                <tr
                  key={row.assignmentId}
                  data-testid="practice-repair-window"
                  data-assignment-id={row.assignmentId}
                >
                  <td>{row.team}</td>
                  <td>{row.now}</td>
                  <td>{row.window}</td>
                  <td>
                    {row.to ? (
                      <span data-testid="practice-repair-to">
                        {row.to}
                        {row.tier === 'cross-venue' ? ' (another venue)' : ''}
                      </span>
                    ) : (
                      <span data-testid="practice-repair-time-tbd" data-tbd-reason={row.reason}>
                        <span className="badge warning">TIME TBD</span> {row.reasonText}
                      </span>
                    )}
                  </td>
                  <td>
                    {row.refusals.length === 0 ? (
                      <span className="text-sm">No refusal found</span>
                    ) : (
                      row.refusals.map((r) => (
                        <span
                          key={r.why}
                          className="text-sm block"
                          data-testid="practice-repair-save-refused"
                          data-refusal={r.why}
                        >
                          <span className="badge danger">Refused</span> {r.text}
                        </span>
                      ))
                    )}
                  </td>
                  <td>
                    {row.canDecline && (
                      <Button
                        size="sm"
                        variant="secondary"
                        aria-label={`Decline the recommendation for ${row.team}`}
                        onClick={() =>
                          act(
                            () => declineIn(state, row.assignmentId),
                            `Declined the recommendation for ${row.team}.`
                          )
                        }
                      >
                        Decline
                      </Button>
                    )}
                    {row.declined.map((d) => (
                      <Button
                        key={d.key}
                        size="sm"
                        variant="ghost"
                        aria-label={`Undo the decline of ${d.text} for ${row.team}`}
                        onClick={() =>
                          act(
                            () => undoIn(state, row.assignmentId, d.shape),
                            `Undid the decline of ${d.text} for ${row.team}.`
                          )
                        }
                      >
                        Undo decline
                      </Button>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-sm mt-2">
        <strong>Findings of the repair run</strong>, before any decline or undo (the table above is
        current):
      </p>
      <ul className="text-sm" data-testid="practice-repair-findings">
        <li data-testid="practice-repair-closures-declared">
          Existing blackouts and other retirements are not consulted: a recommendation may land on
          ground they already close. Check it before enacting.
        </li>
        {result.findings.map((finding, index) => (
          <li
            key={`${finding.code}-${index}`}
            data-reason-code={finding.code}
            data-severity={finding.severity}
          >
            <strong>{finding.code}</strong> ({finding.severity}) — {finding.message}
          </li>
        ))}
        {!daylightPlan.daylight && (
          <li data-testid="practice-repair-daylight-why">
            No sunset was judged because {daylightPlan.why}.
          </li>
        )}
        {!adapted.declared.lightingOverrides.supplied && (
          <li data-testid="practice-repair-lighting-declared">
            {adapted.declared.lightingOverrides.note}
          </li>
        )}
      </ul>
    </>
  );
}

Recommendations.propTypes = {
  rows: PropTypes.object.isRequired,
  lossKey: PropTypes.string.isRequired,
  timeZone: PropTypes.string,
  subject: PropTypes.string.isRequired,
};
