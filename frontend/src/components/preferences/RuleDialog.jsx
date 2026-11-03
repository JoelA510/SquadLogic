import React, { useMemo, useState } from 'react';
import PropTypes from 'prop-types';
import Button from '../ui/Button.jsx';
import Badge from '../ui/Badge.jsx';
import Modal from '../ui/Modal.jsx';
import {
  addPracticePreference,
  editPracticePreference,
} from '../../hooks/useCoachPracticePreferences.js';
import { summarizeRule } from '../../utils/coachPreferencePreview.js';
import MustKeepPreview from './MustKeepPreview.jsx';
import RuleForm, { checkRuleForm, emptyRuleForm, formOfRow } from './RuleForm.jsx';

/**
 * Add a rule, or edit one in force (Phase D C2). The same fields either way (`RuleForm`), a sentence
 * that reads the rule back before it is saved, and, for a must, the re-judge of which of the team's
 * current practice series it would make unsatisfiable (`MustKeepPreview`, the same as Accept as must
 * shows). Adding picks the coach and one of the teams that coach coaches today (what the RPC
 * accepts); editing keeps the coach and the team.
 *
 * **A rule still waiting for a decision stays waiting when it is saved** (20261116010000): the form
 * shows it as "Still pending", with its level as text, and Save sends the level in force (prefer), which
 * the database no longer reads as a decision. Deciding it is a separate act on the saved rule, with its
 * own buttons here: Accept as must (which hands over to the Accept dialog and its impact preview) and
 * Keep as prefer. They are off while the form holds unsaved changes, because they act on the rule as it
 * is saved. A rule that was requested as a must and has been decided keeps its Level control: saving it
 * at Prefer keeps it as prefer, at Must accepts it.
 */
export default function RuleDialog({
  row = null,
  coaches,
  defaultCoachId = '',
  teamsOf,
  rosterError = null,
  locations,
  previewContext,
  date,
  coachName,
  teamName,
  onClose,
  onDone,
  onAccept = null,
  onKeepPrefer = null,
  toast,
}) {
  const editing = row !== null;
  const [coachId, setCoachId] = useState(editing ? String(row.coach_id) : defaultCoachId);
  const teams = useMemo(() => (coachId ? teamsOf(coachId) : []), [coachId, teamsOf]);
  const [teamIdChoice, setTeamId] = useState(editing ? String(row.team_id) : '');
  // The team follows the coach: the first team they coach until one is chosen.
  const teamId = editing
    ? String(row.team_id)
    : teams.some((team) => team.id === teamIdChoice)
      ? teamIdChoice
      : (teams[0]?.id ?? '');
  const [form, setForm] = useState(() => (editing ? formOfRow(row) : emptyRuleForm()));
  const [busy, setBusy] = useState(false);

  const checked = useMemo(
    () =>
      /** @type {import('./RuleForm.jsx').RuleCheck} */ (
        coachId && teamId
          ? checkRuleForm(form, { coachId, teamId, id: editing ? String(row.id) : 'new' })
          : { ok: false, messages: [], input: null, rule: null }
      ),
    [form, coachId, teamId, editing, row]
  );
  const locationNames = previewContext.locationNames;
  const summary = checked.ok
    ? summarizeRule(
        {
          level: checked.input.level,
          weekdays: checked.input.weekdays,
          start_minutes: checked.input.startMinutes,
          venue_ids: checked.input.venueIds,
          keep_weekday: checked.input.keepWeekday,
          keep_start: checked.input.keepStart,
          keep_venue: checked.input.keepVenue,
          effective_from: checked.input.effectiveFrom,
          effective_to: checked.input.effectiveTo,
        },
        { teamName: teamName(teamId), locationNames }
      )
    : null;
  const wasRequestedMust = editing && row.requested_level === 'must';
  const pending = editing && row.must_decision === 'pending';
  // The form differs from the saved rule: Accept and Keep act on the saved rule, so they wait for Save.
  const dirty = useMemo(
    () => pending && JSON.stringify(form) !== JSON.stringify(formOfRow(row)),
    [pending, form, row]
  );

  const save = async () => {
    if (!checked.ok) return;
    setBusy(true);
    try {
      if (editing) {
        const saved = await editPracticePreference(row, checked.input);
        // Say what the database answered, not what was expected: against a database that has not yet
        // applied 20261116010000 a pending rule saved at prefer comes back kept as prefer.
        if (pending && saved?.must_decision === 'pending') {
          toast('Rule saved. It is still waiting for your decision.', 'success');
        } else if (pending && saved?.must_decision) {
          toast(
            `Rule saved. It was ${saved.must_decision === 'accepted' ? 'accepted as a must' : 'kept as prefer'}, not left pending.`,
            'success'
          );
        } else {
          toast('Rule saved', 'success');
        }
      } else {
        await addPracticePreference({ coachId, teamId, ...checked.input });
        toast('Rule added', 'success');
      }
      await onDone();
      onClose();
    } catch (err) {
      toast(
        err?.message || (editing ? 'The rule could not be saved' : 'The rule could not be added'),
        'warning'
      );
    } finally {
      setBusy(false);
    }
  };

  // Keep as prefer is the parent's act (it toasts, refreshes and closes this dialog on success); busy
  // covers the wait so a second click cannot send a second decision.
  const keepAsPrefer = async () => {
    setBusy(true);
    try {
      await onKeepPrefer(row);
    } finally {
      setBusy(false);
    }
  };

  const idPrefix = editing ? `edit-${row.id}` : 'add';
  // An empty roster read is not "no team today": with the roster unread the teams cannot be listed.
  const teamsUnread = !editing && coachId !== '' && rosterError !== null;
  const noTeam = !editing && coachId !== '' && !teamsUnread && teams.length === 0;

  return (
    <Modal
      open
      onClose={onClose}
      title={editing ? 'Edit a rule' : 'Add a rule'}
      wide
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={save}
            loading={busy}
            disabled={busy || !checked.ok || !teamId}
          >
            {editing ? 'Save rule' : 'Add rule'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {editing ? (
          <p className="text-sm m-0">
            Coach: <strong>{coachName(row.coach_id)}</strong> · Team:{' '}
            <strong>{teamName(row.team_id)}</strong>
          </p>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            <div className="field">
              <label htmlFor={`${idPrefix}-coach`}>Coach</label>
              <select
                id={`${idPrefix}-coach`}
                className="select"
                value={coachId}
                onChange={(event) => setCoachId(event.target.value)}
              >
                <option value="">Choose a coach</option>
                {coaches.map((coach) => (
                  <option key={String(coach.id)} value={String(coach.id)}>
                    {coach.full_name}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor={`${idPrefix}-team`}>Team</label>
              <select
                id={`${idPrefix}-team`}
                className="select"
                value={teamId}
                disabled={teams.length === 0}
                onChange={(event) => setTeamId(event.target.value)}
              >
                {teams.length === 0 && <option value="">Choose a coach first</option>}
                {teams.map((team) => (
                  <option key={team.id} value={team.id}>
                    {team.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
        )}

        {teamsUnread ? (
          <p className="text-sm m-0" data-testid="add-teams-unread">
            The roster did not load, so the teams of this coach cannot be listed (
            {rosterError.message || 'unknown error'}). Close this and reload the page to try again.
          </p>
        ) : noTeam ? (
          <p className="text-sm m-0">
            This coach coaches no team today, so there is nothing to add a rule to.
          </p>
        ) : (
          (editing || coachId !== '') && (
            <>
              {pending && (
                <div
                  className="flex flex-col gap-3 rounded-md border border-border-subtle p-3"
                  data-testid="edit-pending-note"
                  role="group"
                  aria-labelledby={`${idPrefix}-pending-heading`}
                >
                  <p id={`${idPrefix}-pending-heading`} className="text-sm m-0">
                    <Badge tone="warning">Still pending</Badge>{' '}
                    <span>
                      This rule was asked for as a must and counts as a prefer until you decide.
                      Saving your changes does not decide it.
                    </span>
                  </p>
                  {onAccept && onKeepPrefer && (
                    <>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          variant="primary"
                          disabled={busy || dirty}
                          aria-describedby={dirty ? `${idPrefix}-decide-hint` : undefined}
                          onClick={() => onAccept(row)}
                        >
                          Accept as must…
                        </Button>
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={busy || dirty}
                          aria-describedby={dirty ? `${idPrefix}-decide-hint` : undefined}
                          onClick={keepAsPrefer}
                        >
                          Keep as prefer
                        </Button>
                      </div>
                      {dirty && (
                        <p
                          id={`${idPrefix}-decide-hint`}
                          className="text-xs text-text-muted m-0"
                          data-testid="decide-hint"
                        >
                          Save your changes first: Accept and Keep act on the rule as it is saved.
                        </p>
                      )}
                    </>
                  )}
                </div>
              )}
              {wasRequestedMust && !pending && (
                <p className="text-sm m-0">
                  This rule was asked for as a must (it is{' '}
                  {row.level === 'must' ? 'accepted' : 'kept as prefer'}). Saving it as Prefer keeps
                  it as prefer; saving it as Must accepts it.
                </p>
              )}
              {editing && row.source === 'import' && (
                <p className="text-sm text-text-muted m-0">
                  This rule came from an import file. Importing a file for this team again replaces
                  it.
                </p>
              )}
              <RuleForm
                idPrefix={idPrefix}
                form={form}
                onChange={setForm}
                locations={locations}
                disabled={busy}
                levelLocked={pending}
              />
              {checked.ok ? (
                <p className="text-sm m-0" data-testid="rule-summary">
                  <strong>This rule reads:</strong> {summary}
                </p>
              ) : (
                checked.messages.length > 0 && (
                  <ul
                    role="alert"
                    className="m-0 pl-5 text-sm field-error"
                    data-testid="rule-form-errors"
                  >
                    {checked.messages.map((message) => (
                      <li key={message}>{message}</li>
                    ))}
                  </ul>
                )
              )}
              {checked.ok && form.level === 'must' && (
                <MustKeepPreview proposal={checked.rule} context={previewContext} date={date} />
              )}
            </>
          )
        )}
      </div>
    </Modal>
  );
}

RuleDialog.propTypes = {
  row: PropTypes.object,
  coaches: PropTypes.arrayOf(PropTypes.shape({ id: PropTypes.any, full_name: PropTypes.string }))
    .isRequired,
  defaultCoachId: PropTypes.string,
  teamsOf: PropTypes.func.isRequired,
  rosterError: PropTypes.shape({ message: PropTypes.string }),
  locations: PropTypes.array.isRequired,
  previewContext: PropTypes.object.isRequired,
  date: PropTypes.string.isRequired,
  coachName: PropTypes.func.isRequired,
  teamName: PropTypes.func.isRequired,
  onClose: PropTypes.func.isRequired,
  onDone: PropTypes.func.isRequired,
  /** Hand a pending rule to the Accept dialog (with its impact preview); with `onKeepPrefer`, shows both buttons. */
  onAccept: PropTypes.func,
  /** Keep a pending rule as prefer; resolves once the parent has refreshed and closed this dialog. */
  onKeepPrefer: PropTypes.func,
  toast: PropTypes.func.isRequired,
};
