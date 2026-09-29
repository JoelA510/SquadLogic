import React, { useId, useMemo, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import { useOrganization } from '../../contexts/OrganizationContext.jsx';
import { usePracticeRepairSnapshot } from '../../hooks/usePracticeRepairSnapshot.js';
import { supabase } from '../../lib/supabaseClient.js';
import {
  TBD_REASON_TEXT,
  declineIn,
  describeShape,
  namesOf,
  openPracticeRepair,
  panelRowsOf,
  undoIn,
} from '../../utils/practiceRepairPanel.js';
import {
  ENACT_REFUSAL_TEXT,
  enactGateOf,
  enactPlanOf,
  enactPracticeRecommendation,
  enactPromptOf,
  enactedRowsOf,
  mintEnactKey,
} from '../../utils/practiceRepairEnact.js';
import { persistPracticeEnact } from '../../utils/practicePersistenceClient.js';
import Button from '../ui/Button.jsx';
import PracticeEnactDialog from './PracticeEnactDialog.jsx';
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
 * - Each window shows whether a save would be refused and why (every
 *   blackout window is, until 3b PR 12), never hiding one.
 * - **Enact** (3b PR 11c, retirements only): one button per recommendation,
 *   admin-only, enabled only once the retirement is COMMITTED (operator
 *   answer Q3). In the retirement dialog's dry-run preview (`preview`) every
 *   button is disabled with the reason; for a blackout it is disabled with
 *   the save refusal (Q1). Its confirmation is the ruling-2 override prompt
 *   (`PracticeEnactDialog`); the flow is `utils/practiceRepairEnact.js`,
 *   which re-reads, re-judges and sends ONE write, never a retry. Nothing
 *   else writes: declines and undos stay on screen only.
 * - **A failed or partial read shows no recommendations**, only the error,
 *   in a `role="alert"`. So does an input the adapter refuses.
 *
 * @param {{ loss: Object, subject: string, isAdmin?: boolean, preview?: boolean }} props
 */
export default function PracticeRepairPanel({ loss, subject, isAdmin = false, preview = false }) {
  const org = /** @type {any} */ (useOrganization() ?? {});
  const organizationId = org.currentOrganization?.id ?? null;
  const season = org.currentSeasonSetting ?? null;
  const snapshot = usePracticeRepairSnapshot({
    organizationId,
    seasonSettingsId: season?.id ?? null,
  });
  const lossKey = JSON.stringify(loss);
  const titleId = `practice-repair-title${useId().replace(/:/g, '')}`;

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
        isAdmin={isAdmin}
        preview={preview}
        organizationId={organizationId}
        seasonSettingsId={season?.id ?? null}
      />
    );
  }

  return (
    <section
      className="card mt-2 p-3"
      aria-labelledby={titleId}
      data-testid="practice-repair-panel"
    >
      <h3 id={titleId} className="text-sm" tabIndex={-1}>
        <strong>Practice repair recommendations</strong>
      </h3>
      <p className="text-sm" data-testid="practice-repair-read-only">
        Declining only re-offers a slot on this screen and is never saved.{' '}
        {loss?.kind === 'retirement'
          ? 'Enact saves one recommendation and locks it: admin-only, and only once the retirement is saved.'
          : 'Enacting a blackout recommendation is not available yet.'}
      </p>
      {body}
    </section>
  );
}

PracticeRepairPanel.propTypes = {
  loss: PropTypes.object.isRequired,
  subject: PropTypes.string.isRequired,
  isAdmin: PropTypes.bool,
  preview: PropTypes.bool,
};

/**
 * @param {{ rows: Record<string, any[]>, lossKey: string, timeZone: string|null, subject: string,
 *   isAdmin: boolean, preview: boolean, organizationId: string|null,
 *   seasonSettingsId: string|null }} props
 */
function Recommendations({
  rows: openedRows,
  lossKey,
  timeZone,
  subject,
  isAdmin,
  preview,
  organizationId,
  seasonSettingsId,
}) {
  const firstOpen = useMemo(() => {
    try {
      return { ok: true, value: openPracticeRepair(openedRows, JSON.parse(lossKey), { timeZone }) };
    } catch (err) {
      return { ok: false, message: err?.message ?? String(err) };
    }
  }, [openedRows, lossKey, timeZone]);
  // After an enact (or a stale re-judge) the panel shows the FRESH read the
  // flow re-based onto: its rows, its repair and its state, together.
  const [fresh, setFresh] = useState(
    /** @type {{ rows: Record<string, any[]>, opened: any } | null} */ (null)
  );
  const rows = fresh?.rows ?? openedRows;
  const opened = useMemo(
    () => /** @type {any} */ (fresh ? { ok: true, value: fresh.opened } : firstOpen),
    [fresh, firstOpen]
  );
  const [state, setState] = useState(firstOpen.ok ? firstOpen.value.state : null);
  const [announce, setAnnounce] = useState('');
  const [actionError, setActionError] = useState(/** @type {string|null} */ (null));
  const [dialog, setDialog] = useState(/** @type {any} */ (null));
  const [busy, setBusy] = useState(false);
  // The enacts of this session, as confirmed and written (shown from the fresh read).
  const [enactLog, setEnactLog] = useState(
    /** @type {Array<{ assignmentId: string, teamId: string, written: any }>} */ ([])
  );
  // Set when a write's outcome is unknown or its season unread: no further
  // enact from this panel until it is reopened.
  const [halted, setHalted] = useState(false);
  // One write in flight, whatever React has rendered yet (a double click).
  const inFlight = useRef(false);
  const headingRef = useRef(/** @type {HTMLParagraphElement|null} */ (null));
  const names = useMemo(() => namesOf(rows), [rows]);
  const loss = useMemo(() => JSON.parse(lossKey), [lossKey]);
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
  const enactedRows = enactedRowsOf(rows, enactLog, names);

  /** Open the override prompt for one recommendation, on the rows shown. */
  const openEnact = (row) => {
    const shown = state.recommendations.find((r) => r.assignmentId === row.assignmentId);
    try {
      setDialog({ ...dialogFor(shown, adapted, rows, names, loss, subject), notice: null });
      setActionError(null);
    } catch (err) {
      setActionError(err?.message ?? String(err));
    }
  };

  const adoptView = (view) => {
    setFresh({ rows: view.rows, opened: view.opened });
    setState(view.state);
  };

  const confirmEnact = async () => {
    if (inFlight.current || !dialog) return;
    inFlight.current = true;
    setBusy(true);
    const current = dialog;
    try {
      const outcome = await enactPracticeRecommendation({
        client: supabase,
        send: persistPracticeEnact,
        organizationId,
        seasonSettingsId,
        loss,
        timeZone,
        state,
        shown: current.shown,
        shownPrompt: current.prompt,
        answer: { accepted: true },
        enactKey: mintEnactKey(),
      });
      if (outcome.status === 'enacted' || outcome.status === 'enacted-unread') {
        setEnactLog((log) => [
          ...log,
          {
            assignmentId: current.shown.assignmentId,
            teamId: current.shown.teamId,
            written: outcome.written,
          },
        ]);
      }
      if (outcome.status === 'enacted-unread') {
        setHalted(true);
        setDialog(null);
        setActionError(
          `The practice for ${current.team} was enacted, but the season could not be read again (${outcome.message}). Close and reopen this panel before enacting anything else.`
        );
        headingRef.current?.focus();
        return;
      }
      if (outcome.status === 'enacted') {
        adoptView(outcome.view);
        setDialog(null);
        setAnnounce(
          `Enacted the recommendation for ${current.team}. Its practice is saved and locked.`
        );
        headingRef.current?.focus();
        return;
      }
      if (outcome.view) adoptView(outcome.view);
      if (outcome.status === 'stale') {
        const fresher = outcome.view?.state.recommendations.find(
          (r) => r.assignmentId === current.shown.assignmentId
        );
        if (outcome.unread) {
          setHalted(true);
          setDialog({
            ...current,
            notice: {
              tone: 'alert',
              text: `The season changed since this was shown, and it could not be read again (${outcome.unread}). Nothing was enacted. Close and reopen the panel.`,
            },
            blocked: 'The season could not be read again.',
          });
          return;
        }
        const again = outcome.stillStands
          ? 'It still stands: tick the box and confirm again to enact it.'
          : `It changed (${(outcome.differences ?? []).join(', ') || outcome.why}): now ${
              !fresher
                ? 'no longer displaced'
                : fresher.to
                  ? describeShape(fresher.to, names)
                  : 'TIME TBD'
            }. Close this and review the updated recommendation.`;
        // Still standing: the prompt is rebuilt on the fresh read, so what is
        // ticked again is what the next Confirm will check.
        const rebuilt =
          outcome.stillStands && fresher
            ? dialogFor(
                fresher,
                outcome.view.opened.adapted,
                outcome.view.rows,
                namesOf(outcome.view.rows),
                loss,
                subject
              )
            : {};
        setDialog({
          ...current,
          ...rebuilt,
          notice: { tone: 'alert', text: `The season changed since this was shown. ${again}` },
          blocked: outcome.stillStands ? null : 'This recommendation changed since it was shown.',
        });
        return;
      }
      if (outcome.status === 'error' && outcome.sent) {
        // The write went out and its answer did not come back: say so.
        setHalted(true);
        setDialog({
          ...current,
          notice: {
            tone: 'alert',
            text: `It is not known whether the practice was enacted: ${outcome.message}. Close and reopen the panel to see the season as saved.`,
          },
          blocked: 'The outcome of the last enact is unknown.',
        });
        return;
      }
      const text =
        outcome.status === 'refused'
          ? (ENACT_REFUSAL_TEXT[outcome.refusal] ?? outcome.refusal)
          : outcome.message;
      setDialog({
        ...current,
        notice: { tone: 'alert', text: `Nothing was enacted: ${text}` },
        blocked: text,
      });
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

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
                    <EnactControl
                      row={row}
                      gate={enactGateOf({ isAdmin, preview, rows, loss, refusals: row.refusals })}
                      busy={busy || halted}
                      onEnact={() => openEnact(row)}
                    />
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

      {enactedRows.length > 0 && (
        <div className="mt-2" data-testid="practice-repair-enacted">
          <p className="text-sm">
            <strong>Enacted this session</strong> (the change budget counts only this
            session&rsquo;s enacts):
          </p>
          <ul className="text-sm">
            {enactedRows.map((e) => (
              <li
                key={e.assignmentId}
                data-testid="practice-repair-enacted-row"
                data-assignment-id={e.assignmentId}
              >
                {e.team}:{' '}
                {e.closedRange ? `its series now ends ${e.closedRange}` : 'its series was replaced'}
                {e.timeTbd ? ', TIME TBD after it' : ''}
                {e.missing > 0 ? `; ${e.missing} written row(s) not found on the fresh read` : ''}
                {e.locked.map((l) => {
                  const slot = adapted.context.slots.get(l.slotId);
                  return (
                    <span key={l.id} data-testid="practice-repair-enacted-locked">
                      ; moved to {slot ? describeShape(slot, names) : l.slotId}, {l.range}{' '}
                      <span className="badge warning">Locked</span>
                    </span>
                  );
                })}
              </li>
            ))}
          </ul>
        </div>
      )}

      {dialog && (
        <PracticeEnactDialog
          open
          fieldName={dialog.fieldName}
          storedDate={dialog.storedDate}
          team={dialog.team}
          teams={dialog.teams}
          rows={dialog.rows}
          replacement={dialog.replacement}
          affected={dialog.affected}
          busy={busy}
          notice={dialog.notice}
          blocked={dialog.blocked}
          onConfirm={confirmEnact}
          onClose={() => setDialog(null)}
        />
      )}

      <p className="text-sm mt-2">
        <strong>Findings of the repair run</strong>, before any decline or undo (the table above is
        current):
      </p>
      <ul className="text-sm" data-testid="practice-repair-findings">
        <li data-testid="practice-repair-closures-declared">
          Existing blackouts and retirements of venues, fields and sub-surfaces are honoured (
          {adapted.declared.closures.applied} applied, {result.closures?.candidatesRefused ?? 0}{' '}
          candidate slot(s) refused). Not read: a field switched off without a retirement date.
        </li>
        {adapted.declared.closures.unattributable.length > 0 && (
          <li data-testid="practice-repair-closures-unattributable">
            {adapted.declared.closures.unattributable.length} imported blackout(s) name no field, so
            they were not applied: a recommendation may land on ground they close.
          </li>
        )}
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
  isAdmin: PropTypes.bool.isRequired,
  preview: PropTypes.bool.isRequired,
  organizationId: PropTypes.string,
  seasonSettingsId: PropTypes.string,
};

/**
 * The override prompt's content for one recommendation, from ONE read (its
 * adapter output and rows): the prompt record the enact will check, and the
 * words the dialog shows.
 */
function dialogFor(shown, adapted, rows, names, loss, subject) {
  const prompt = enactPromptOf(adapted, rows, enactPlanOf(adapted, shown));
  const snapshotRow = adapted.context.snapshot.find((r) => r.id === shown.assignmentId);
  const field = (rows.fields ?? []).find(
    (f) => String(f.id).toLowerCase() === String(loss.field?.id).toLowerCase()
  );
  const team = names.team(shown.teamId);
  return {
    shown,
    prompt,
    team,
    teams: [{ id: shown.teamId, name: team }],
    fieldName: field?.name ?? subject,
    // The STORED date: the gate enabled the button only when it is set.
    storedDate: field?.effective_to ?? '',
    rows: prompt.record.rows.map((r) => ({
      assignmentId: r.assignment_id,
      now: describeShape(shown.from, names),
      range: snapshotRow ? `${snapshotRow.range.from} to ${snapshotRow.range.until}` : '',
      assignedVia: r.assigned_via,
      effect: r.effect,
      rangeAfter: r.range_after,
    })),
    replacement: shown.to
      ? `${describeShape(shown.to, names)}, from ${prompt.lossDate} to ${shown.effectiveUntil}`
      : `TIME TBD from ${prompt.lossDate}, because ${TBD_REASON_TEXT[shown.reason] ?? shown.reason}`,
    affected: prompt.record.published_practices_affected,
    blocked: null,
  };
}

/**
 * One row's Enact button, and its visible reason when it is disabled.
 *
 * @param {{ row: any, gate: { enabled: boolean, why: string|null, text: string|null },
 *   busy: boolean, onEnact: () => void }} props
 */
function EnactControl({ row, gate, busy, onEnact }) {
  // A blackout splits one series into several windows: one id per control.
  const reasonId = `practice-enact-why${useId().replace(/:/g, '')}`;
  return (
    <>
      <Button
        size="sm"
        variant="primary"
        disabled={!gate.enabled || busy}
        aria-busy={busy}
        aria-describedby={gate.enabled ? undefined : reasonId}
        aria-label={`Enact the recommendation for ${row.team}`}
        data-testid="practice-repair-enact"
        data-enact-gate={gate.why ?? 'open'}
        onClick={onEnact}
      >
        Enact
      </Button>
      {!gate.enabled && (
        <span
          id={reasonId}
          className="text-sm block"
          data-testid="practice-repair-enact-why"
          data-enact-gate={gate.why}
        >
          {gate.text}
        </span>
      )}
    </>
  );
}

EnactControl.propTypes = {
  row: PropTypes.object.isRequired,
  gate: PropTypes.object.isRequired,
  busy: PropTypes.bool.isRequired,
  onEnact: PropTypes.func.isRequired,
};
