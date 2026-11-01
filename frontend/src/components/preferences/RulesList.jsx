import React, { useMemo, useState } from 'react';
import PropTypes from 'prop-types';
import Button from '../ui/Button.jsx';
import Badge from '../ui/Badge.jsx';
import { DecisionBadge } from './PreferenceFields.jsx';
import {
  LEVEL_LABEL,
  PRIORITY_LABEL,
  describeRule,
  priorityRank,
  ruleNotApplied,
} from '../../utils/coachPreferencePreview.js';

/** The most rows drawn at once; the filters narrow a longer list. */
const RULES_SHOWN_AT_ONCE = 200;

const ALL = 'all';

/**
 * The window a rule is in force over, as words (nothing for an open rule).
 * @param {any} row
 */
function windowText(row) {
  if (row.effective_from && row.effective_to) {
    return `In force from ${row.effective_from} until ${row.effective_to}`;
  }
  if (row.effective_from) return `In force from ${row.effective_from}`;
  if (row.effective_to) return `In force until ${row.effective_to}`;
  return null;
}

/** The line under the filters: how many rules are drawn, of how many match, of how many exist. */
function countText({ shown, matching, total, filtered }) {
  if (total === 0) return 'No rules in force.';
  const noun = (n) => (n === 1 ? 'rule' : 'rules');
  const capped = matching > shown ? `the first ${shown} of ${matching}` : `${shown} of ${matching}`;
  const tail = matching > shown ? '; narrow the filters to see the rest' : '';
  return filtered
    ? `Showing ${capped} ${noun(matching)} matching the filters (${total} in force)${tail}.`
    : `Showing ${capped} ${noun(matching)} in force${tail}.`;
}

/** Does a rule match the level filter? Must, Prefer (not a pending must), or Pending must. */
function matchesLevel(row, level) {
  if (level === ALL) return true;
  if (level === 'pending') return row.must_decision === 'pending';
  if (level === 'must') return row.level === 'must';
  return row.level === 'prefer' && row.must_decision !== 'pending';
}

function matchesPriority(row, priority) {
  if (priority === ALL) return true;
  if (priority === 'none') return !row.coach_priority;
  return row.coach_priority === priority;
}

/**
 * Every rule in force, by team and coach (Phase D C2), with filters for the team, the coach, the
 * level and the coach's priority, and Edit and Remove on each (the RPCs are admin-only and audited).
 * The priority is shown and can be filtered on; it is the coach's own ranking and the scheduler does
 * not weigh it, which the page says.
 */
export default function RulesList({
  rows,
  coachName,
  teamName,
  locationNames,
  readOnly,
  busyId,
  rosterRows,
  date,
  onAdd,
  onEdit,
  onRemove,
}) {
  const [team, setTeam] = useState(ALL);
  const [coach, setCoach] = useState(ALL);
  const [level, setLevel] = useState(ALL);
  const [priority, setPriority] = useState(ALL);

  const teamOptions = useMemo(
    () =>
      [...new Set(rows.map((row) => String(row.team_id)))]
        .map((id) => ({ id, name: teamName(id) }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [rows, teamName]
  );
  const coachOptions = useMemo(
    () =>
      [...new Set(rows.map((row) => String(row.coach_id)))]
        .map((id) => ({ id, name: coachName(id) }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [rows, coachName]
  );

  const matching = useMemo(
    () =>
      rows
        .filter(
          (row) =>
            (team === ALL || String(row.team_id) === team) &&
            (coach === ALL || String(row.coach_id) === coach) &&
            matchesLevel(row, level) &&
            matchesPriority(row, priority)
        )
        .sort(
          (a, b) =>
            teamName(a.team_id).localeCompare(teamName(b.team_id)) ||
            coachName(a.coach_id).localeCompare(coachName(b.coach_id)) ||
            priorityRank(a.coach_priority) - priorityRank(b.coach_priority) ||
            String(a.created_at).localeCompare(String(b.created_at)) ||
            String(a.id).localeCompare(String(b.id))
        ),
    [rows, team, coach, level, priority, teamName, coachName]
  );
  const shown = matching.slice(0, RULES_SHOWN_AT_ONCE);
  const filtered = team !== ALL || coach !== ALL || level !== ALL || priority !== ALL;
  const clear = () => {
    setTeam(ALL);
    setCoach(ALL);
    setLevel(ALL);
    setPriority(ALL);
  };

  const ruleLabel = (row) =>
    `${coachName(row.coach_id)}'s rule for ${teamName(row.team_id)}: ${describeRule(row, locationNames)}`;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <p className="text-sm text-text-muted m-0 max-w-prose">
          Every rule in force applies, and a must is a hard rule. The coach&apos;s priority is shown
          for your reading and the scheduler does not weigh it.
        </p>
        <Button variant="primary" size="sm" disabled={readOnly} onClick={onAdd}>
          Add a rule…
        </Button>
      </div>

      <form
        className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5 items-end"
        aria-label="Filter the rules"
        onSubmit={(event) => event.preventDefault()}
      >
        <div className="field">
          <label htmlFor="rules-filter-team">Team</label>
          <select
            id="rules-filter-team"
            className="select"
            value={team}
            onChange={(event) => setTeam(event.target.value)}
          >
            <option value={ALL}>All teams</option>
            {teamOptions.map((option) => (
              <option key={option.id} value={option.id}>
                {option.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="rules-filter-coach">Coach</label>
          <select
            id="rules-filter-coach"
            className="select"
            value={coach}
            onChange={(event) => setCoach(event.target.value)}
          >
            <option value={ALL}>All coaches</option>
            {coachOptions.map((option) => (
              <option key={option.id} value={option.id}>
                {option.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="rules-filter-level">Level</label>
          <select
            id="rules-filter-level"
            className="select"
            value={level}
            onChange={(event) => setLevel(event.target.value)}
          >
            <option value={ALL}>All levels</option>
            <option value="must">{LEVEL_LABEL.must}</option>
            <option value="prefer">{LEVEL_LABEL.prefer}</option>
            <option value="pending">Pending must</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="rules-filter-priority">Coach&apos;s priority</label>
          <select
            id="rules-filter-priority"
            className="select"
            value={priority}
            onChange={(event) => setPriority(event.target.value)}
          >
            <option value={ALL}>Any priority</option>
            {Object.entries(PRIORITY_LABEL).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
            <option value="none">No priority</option>
          </select>
        </div>
        <div>
          <Button variant="ghost" size="sm" disabled={!filtered} onClick={clear}>
            Clear filters
          </Button>
        </div>
      </form>

      <p role="status" className="text-sm text-text-muted m-0" data-testid="rules-count">
        {countText({
          shown: shown.length,
          matching: matching.length,
          total: rows.length,
          filtered,
        })}
      </p>

      {rows.length > 0 && matching.length === 0 ? (
        <p className="text-sm m-0">No rules match these filters.</p>
      ) : (
        shown.length > 0 && (
          <div className="grid-wrap">
            <table className="grid">
              <caption className="sr-only">Practice preference rules in force</caption>
              <thead>
                <tr>
                  <th scope="col">Coach</th>
                  <th scope="col">Team</th>
                  <th scope="col">Level</th>
                  <th scope="col">Rule</th>
                  <th scope="col">Coach&apos;s priority</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((row) => (
                  <tr key={row.id}>
                    <td>{coachName(row.coach_id)}</td>
                    <td>{teamName(row.team_id)}</td>
                    <td>
                      <span className="flex flex-col gap-1">
                        <span>{LEVEL_LABEL[row.level]}</span>
                        {row.must_decision && <DecisionBadge decision={row.must_decision} />}
                        {row.source === 'import' && <Badge tone="neutral">Imported</Badge>}
                      </span>
                    </td>
                    <td>
                      {describeRule(row, locationNames)}
                      {windowText(row) && (
                        <span className="block text-xs text-text-muted">{windowText(row)}</span>
                      )}
                      {rosterRows && ruleNotApplied(row, rosterRows, date) && (
                        <span
                          className="block text-xs text-text-muted"
                          data-testid="rule-not-applied"
                        >
                          Not applied today: {ruleNotApplied(row, rosterRows, date)}.
                        </span>
                      )}
                    </td>
                    <td>
                      {row.coach_priority ? (
                        PRIORITY_LABEL[row.coach_priority]
                      ) : (
                        <span aria-label="No priority">—</span>
                      )}
                    </td>
                    <td>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={readOnly || busyId === row.id}
                          aria-label={`Edit ${ruleLabel(row)}`}
                          onClick={() => onEdit(row)}
                        >
                          Edit
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost-danger"
                          disabled={readOnly || busyId === row.id}
                          loading={busyId === row.id}
                          aria-label={`Remove ${ruleLabel(row)}`}
                          onClick={() => onRemove(row)}
                        >
                          Remove
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}
    </div>
  );
}

RulesList.propTypes = {
  rows: PropTypes.array.isRequired,
  coachName: PropTypes.func.isRequired,
  teamName: PropTypes.func.isRequired,
  locationNames: PropTypes.instanceOf(Map).isRequired,
  readOnly: PropTypes.bool.isRequired,
  busyId: PropTypes.string,
  /** The roster, or null when it did not load (then no rule is judged "not applied"). */
  rosterRows: PropTypes.array,
  date: PropTypes.string.isRequired,
  onAdd: PropTypes.func.isRequired,
  onEdit: PropTypes.func.isRequired,
  onRemove: PropTypes.func.isRequired,
};
