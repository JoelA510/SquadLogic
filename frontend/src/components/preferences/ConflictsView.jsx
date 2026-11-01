import React from 'react';
import PropTypes from 'prop-types';
import Button from '../ui/Button.jsx';
import {
  DIMENSION_LABEL,
  PRIORITY_LABEL,
  describeRule,
} from '../../utils/coachPreferencePreview.js';

/**
 * Must rules that cannot be met together (Phase D C2). Two musts for one team whose days (or start
 * times, or venues) share no value leave no practice that meets both, so accepting them makes the
 * team TIME TBD, naming the rules. Core finds these (`resolveCoachPreferences`); this lists them,
 * by team, with the rules to edit or remove. The same finder feeds Accept all's confirmation.
 *
 * It never says "no conflicts" about something it did not check: when the roster and practice data
 * did not load, it says so instead, and a rule core could not read is listed beside the conflicts.
 */
export default function ConflictsView({
  result,
  rowById,
  checkError,
  coachName,
  teamName,
  locationNames,
  readOnly,
  busyId,
  onEdit,
  onRemove,
}) {
  if (checkError) {
    return (
      <p role="alert" className="text-sm m-0" data-testid="conflicts-not-checked">
        Conflicts could not be checked:{' '}
        {checkError.message || 'the roster and practice data did not load'}. Reload the page to try
        again.
      </p>
    );
  }

  const { conflicts, teamsExamined, unreadable } = result;
  const byTeam = new Map();
  for (const conflict of conflicts) {
    if (!byTeam.has(conflict.teamId)) byTeam.set(conflict.teamId, []);
    byTeam.get(conflict.teamId).push(conflict);
  }
  const teams = [...byTeam.keys()].sort((a, b) => teamName(a).localeCompare(teamName(b)));

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-text-muted m-0 max-w-prose">
        Must rules for one team that no practice can meet together. A team in this list is placed as
        TIME TBD naming the rules until one of them is edited or removed. Prefer rules that disagree
        are not listed: they only cost the scheduler a breach.
      </p>
      <p role="status" className="text-sm m-0" data-testid="conflicts-checked">
        {conflicts.length === 0
          ? `No conflicts among the musts in force. Checked ${teamsExamined.length} ${
              teamsExamined.length === 1 ? 'team' : 'teams'
            } with rules.`
          : `${conflicts.length} ${conflicts.length === 1 ? 'conflict' : 'conflicts'} on ${
              teams.length
            } ${teams.length === 1 ? 'team' : 'teams'}. Checked ${teamsExamined.length} ${
              teamsExamined.length === 1 ? 'team' : 'teams'
            } with rules.`}
      </p>

      {teams.map((teamId) => (
        <section
          key={teamId}
          aria-labelledby={`conflict-team-${teamId}`}
          className="card"
          data-testid="conflict-team"
        >
          <div className="card-head">
            <h3 id={`conflict-team-${teamId}`}>{teamName(teamId)}</h3>
          </div>
          <div className="card-body flex flex-col gap-4">
            {byTeam.get(teamId).map((conflict) => (
              <div key={`${conflict.dimension}-${conflict.ruleIds.join(',')}`}>
                <p className="text-sm font-semibold m-0 mb-2" data-testid="conflict">
                  {DIMENSION_LABEL[conflict.dimension]}: these musts ask for values with nothing in
                  common.
                </p>
                <ul className="m-0 list-none p-0 flex flex-col gap-2">
                  {conflict.ruleIds.map((ruleId) => {
                    const row = rowById.get(String(ruleId));
                    if (!row) return <li key={ruleId}>Rule {ruleId}</li>;
                    const label = `${coachName(row.coach_id)}'s rule for ${teamName(row.team_id)}: ${describeRule(row, locationNames)}`;
                    return (
                      <li
                        key={ruleId}
                        className="flex flex-wrap items-center justify-between gap-2 text-sm"
                      >
                        <span>
                          <strong>{coachName(row.coach_id)}</strong>:{' '}
                          {describeRule(row, locationNames)}
                          {row.coach_priority &&
                            ` (priority ${PRIORITY_LABEL[row.coach_priority].toLowerCase()})`}
                        </span>
                        <span className="flex gap-2">
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={readOnly || busyId === row.id}
                            aria-label={`Edit ${label}`}
                            onClick={() => onEdit(row)}
                          >
                            Edit
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost-danger"
                            disabled={readOnly || busyId === row.id}
                            loading={busyId === row.id}
                            aria-label={`Remove ${label}`}
                            onClick={() => onRemove(row)}
                          >
                            Remove
                          </Button>
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
        </section>
      ))}

      {unreadable.length > 0 && (
        <div role="alert" className="text-sm" data-testid="conflicts-unreadable">
          <p className="m-0 font-semibold">
            {unreadable.length} {unreadable.length === 1 ? 'rule' : 'rules'} could not be read, so{' '}
            {unreadable.length === 1 ? 'it was' : 'they were'} left out of this check:
          </p>
          <ul className="m-0 pl-5">
            {unreadable.map((item) => (
              <li key={item.ruleId}>
                {teamName(item.teamId)}: {item.message}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

ConflictsView.propTypes = {
  result: PropTypes.shape({
    teamsExamined: PropTypes.array.isRequired,
    conflicts: PropTypes.array.isRequired,
    unreadable: PropTypes.array.isRequired,
  }).isRequired,
  rowById: PropTypes.instanceOf(Map).isRequired,
  checkError: PropTypes.object,
  coachName: PropTypes.func.isRequired,
  teamName: PropTypes.func.isRequired,
  locationNames: PropTypes.instanceOf(Map).isRequired,
  readOnly: PropTypes.bool.isRequired,
  busyId: PropTypes.string,
  onEdit: PropTypes.func.isRequired,
  onRemove: PropTypes.func.isRequired,
};
