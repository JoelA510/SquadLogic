import React, { useMemo, useState } from 'react';
import PropTypes from 'prop-types';
import Button from '../ui/Button.jsx';
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
 * Saving a rule that was asked for as a must decides the request: Prefer keeps it as prefer, Must
 * accepts it. The dialog says so, because the RPC takes only the level and a person editing the days
 * of a pending must should not accept it by accident.
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

  const save = async () => {
    if (!checked.ok) return;
    setBusy(true);
    try {
      if (editing) {
        await editPracticePreference(row, checked.input);
        toast('Rule saved', 'success');
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
                <p className="text-sm m-0" data-testid="edit-pending-note">
                  This rule was asked for as a must and is waiting for your decision. Saving it as
                  Prefer keeps it as prefer; saving it as Must accepts it.
                </p>
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
  toast: PropTypes.func.isRequired,
};
