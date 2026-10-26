import React from 'react';
import PropTypes from 'prop-types';
import Badge from '../ui/Badge.jsx';

/** The settings panel's warnings (`assessTeamCount`), in a few words for the overview's table. */
const WARNING_LABELS = {
  TOO_FEW_PLAYERS: 'Too few players for one team',
  TOO_FEW_PER_TEAM: 'Teams under the minimum',
  TOO_MANY_PER_TEAM: 'Teams over the maximum',
  OVERRIDE_ADJUSTED: 'Override not used',
};

/**
 * A program's status before generation, from the same advice the settings panel shows: whether
 * the count generation will build keeps every team within the roster limits. Never a blanket
 * "Ready" (Phase B4): a program that cannot fit its limits says so.
 * @param {{ assessment?: any }} props
 */
function ProgramStatus({ assessment }) {
  if (!assessment) return <span className="text-text-muted">Not assessed</span>;
  if (assessment.blocked) return <Badge tone="warning">Settings need fixing</Badge>;
  const warnings = Array.isArray(assessment.warnings) ? assessment.warnings : [];
  if (warnings.length === 0) return <Badge tone="success">Fits the limits</Badge>;
  return (
    <ul className="flex flex-wrap gap-1">
      {warnings.map((warning) => (
        <li key={warning.code}>
          <Badge tone="warning">{WARNING_LABELS[warning.code] ?? warning.code}</Badge>
        </li>
      ))}
    </ul>
  );
}

ProgramStatus.propTypes = {
  assessment: PropTypes.shape({
    blocked: PropTypes.bool,
    warnings: PropTypes.arrayOf(PropTypes.shape({ code: PropTypes.string })),
  }),
};

/**
 * Every division of the import, with the count generation will build, the recommended count and
 * a status from the settings panel's advice. Choosing a division is a button in its row's first
 * cell (WCAG 2.1.1), marked `aria-current` while that division is the one being configured (a
 * single selection, not a toggle); the row stays clickable with a mouse.
 *
 * (The component, its props and the rows are still called programs: that was the page's word for
 * a division before Phase E2 gave "program" a meaning of its own, a group of divisions. Only the
 * copy on screen changed.)
 *
 * `groups` (Phase E2) lists the divisions under the program they are in, one heading per program
 * and "No program" last. It is passed only when a season has a program of its own with a division
 * in it: a league that runs on divisions alone is shown one flat list, with no heading at all.
 */
export default function ProgramOverview({
  programs,
  onSelectProgram,
  selectedProgramId,
  groups = null,
}) {
  const renderRow = (program) => {
    const selected = selectedProgramId === program.id;
    const recommended = program.assessment?.recommendedTeamCount ?? null;
    return (
      <tr
        key={program.id}
        // A mouse convenience only: the button in the first cell is the control.
        onClick={() => onSelectProgram(program.id)}
        className={`cursor-pointer transition-colors ${
          selected
            ? 'bg-brand-500/10 border-l-4 border-l-brand-500'
            : 'hover:bg-bg-surface-hover border-l-4 border-l-transparent'
        }`}
      >
        <td className="p-4 font-medium text-text-primary">
          <button
            type="button"
            className="text-left font-medium text-text-primary hover:underline rounded"
            aria-current={selected ? 'true' : undefined}
            onClick={(event) => {
              // The row's own click would select it a second time.
              event.stopPropagation();
              onSelectProgram(program.id);
            }}
          >
            {program.name}
          </button>
        </td>
        <td className="p-4 text-text-secondary">{program.playerCount}</td>
        <td className="p-4 text-text-secondary">
          {/* Generation refuses rules the advice calls blocked: no count to estimate. */}
          {program.assessment?.blocked ? '—' : program.estimatedTeams}
        </td>
        <td className="p-4 text-text-secondary">{recommended ?? '—'}</td>
        <td className="p-4 text-text-secondary">{program.avgRosterSize}</td>
        <td className="p-4">
          <ProgramStatus assessment={program.assessment} />
        </td>
      </tr>
    );
  };
  const byId = new Map(programs.map((program) => [program.id, program]));
  return (
    <div className="bg-bg-surface border border-border-subtle rounded-xl overflow-hidden">
      <div className="p-4 border-b border-border-subtle bg-bg-surface-hover">
        <h3 id="program-overview-heading" className="font-bold text-text-primary">
          Division Overview
        </h3>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm" aria-labelledby="program-overview-heading">
          <thead>
            <tr className="border-b border-border-subtle text-text-secondary">
              <th scope="col" className="p-4 font-medium">
                Division
              </th>
              <th scope="col" className="p-4 font-medium">
                Players
              </th>
              <th scope="col" className="p-4 font-medium">
                Est. Teams
              </th>
              <th scope="col" className="p-4 font-medium">
                Recommended
              </th>
              <th scope="col" className="p-4 font-medium">
                Avg Roster
              </th>
              <th scope="col" className="p-4 font-medium">
                Status
              </th>
            </tr>
          </thead>
          {groups && groups.length > 0 ? (
            groups.map((group) => (
              <tbody key={group.key} data-testid={`program-group-${group.key}`}>
                <tr className="border-b border-border-subtle bg-bg-surface-hover">
                  <th
                    scope="rowgroup"
                    colSpan={6}
                    className="px-4 py-2 text-left text-xs font-semibold uppercase tracking-wide text-text-secondary"
                  >
                    {group.label}
                  </th>
                </tr>
                {group.ids
                  .map((id) => byId.get(id))
                  .filter(Boolean)
                  .map(renderRow)}
              </tbody>
            ))
          ) : (
            <tbody>
              {programs.map(renderRow)}
              {programs.length === 0 && (
                <tr>
                  <td colSpan={6} className="p-8 text-center text-text-muted">
                    No divisions found. Import data to see overview.
                  </td>
                </tr>
              )}
            </tbody>
          )}
        </table>
      </div>
    </div>
  );
}

ProgramOverview.propTypes = {
  programs: PropTypes.arrayOf(
    PropTypes.shape({
      id: PropTypes.string.isRequired,
      name: PropTypes.string,
      playerCount: PropTypes.number,
      estimatedTeams: PropTypes.number,
      avgRosterSize: PropTypes.number,
      assessment: PropTypes.object,
    })
  ).isRequired,
  onSelectProgram: PropTypes.func.isRequired,
  selectedProgramId: PropTypes.string,
  groups: PropTypes.arrayOf(
    PropTypes.shape({
      key: PropTypes.string.isRequired,
      label: PropTypes.string.isRequired,
      ids: PropTypes.arrayOf(PropTypes.string).isRequired,
    })
  ),
};
