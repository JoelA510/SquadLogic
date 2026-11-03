import React from 'react';
import PropTypes from 'prop-types';
import Badge from '../ui/Badge.jsx';
import {
  askedToPlayUpNote,
  flagLines,
  flagSummary,
  flagsAreKnown,
  movedAwayNote,
  movedHereNote,
  movedInFromProgramsNote,
} from '../../utils/seatNotes.js';
import { playDownOverviewNote } from '../../utils/playDownNote.js';

/** The settings panel's warnings (`assessTeamCount`), in a few words for the overview's table. */
const WARNING_LABELS = {
  TOO_FEW_PLAYERS: 'Too few players for one team',
  TOO_FEW_PER_TEAM: 'Teams under the minimum',
  TOO_MANY_PER_TEAM: 'Teams over the maximum',
  OVERRIDE_ADJUSTED: 'Override not used',
};

/**
 * Why a program with registrants has nobody to seat: all on the waitlist, none eligible for the
 * division, all placed in other divisions (their own age division), or a mix of those (no team is
 * built for any of them).
 * @param {{ waitlistedCount?: number, notEligibleCount?: number, movedOutCount?: number }} program
 */
function nobodyToSeat(program) {
  const waitlisted = Number(program.waitlistedCount) > 0;
  const notEligible = Number(program.notEligibleCount) > 0;
  const movedOut = Number(program.movedOutCount) > 0;
  if (waitlisted && !notEligible && !movedOut) return 'All on the waitlist';
  if (notEligible && !waitlisted && !movedOut) return 'None eligible';
  if (movedOut && !waitlisted && !notEligible) return 'All placed in other divisions';
  return 'Nobody to seat';
}

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

const FLAG_TONES = { up: 'info', down: 'info', unchecked: 'warning' };

/**
 * A division's play-up and play-down, in words: each count that is not zero, "None" when nobody plays
 * up or down, and "Not checked yet" when nothing was compared. Words, never a colour or an icon alone.
 * @param {{ flags?: any }} props
 */
function PlayFlags({ flags }) {
  return (
    <ul className="flex flex-col items-start gap-1">
      {flagLines(flags).map((line) => (
        <li key={line.key}>
          {FLAG_TONES[line.key] ? (
            <Badge tone={FLAG_TONES[line.key]}>{line.text}</Badge>
          ) : (
            <span className="text-text-muted">{line.text}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

PlayFlags.propTypes = { flags: PropTypes.object };

/** The counts of a program or the league, as `flagCountsOf` gives them. */
const flagCountsShape = PropTypes.shape({
  playingUp: PropTypes.number,
  playingDown: PropTypes.number,
  askedToPlayUp: PropTypes.number,
  notChecked: PropTypes.number,
  movedIn: PropTypes.number,
  checked: PropTypes.bool,
});

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
 *
 * Every play-up and play-down is flagged and counted (play-down plan, 2026-11-03, PR 2): a column
 * for each division, the counts in each program heading (`group.flags`) and a line for the league
 * (`league`), all from `summarizeSeats`, which counts a player in the division they PLAY in. They are
 * flags, not decisions: nothing here approves or refuses a player. The note under the heading says
 * whether the organization's Play-down setting is on (`playDown`, off unless an admin turned it on).
 */
export default function ProgramOverview({
  programs,
  onSelectProgram,
  selectedProgramId,
  groups = null,
  league = null,
  playDown = false,
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
        <td className="p-4 text-text-secondary">
          {program.playerCount}
          {program.waitlistedCount > 0 && (
            <span className="block text-xs text-text-muted">
              {program.waitlistedCount} on the waitlist
            </span>
          )}
          {program.notEligibleCount > 0 && (
            <span className="block text-xs text-text-muted">
              {program.notEligibleCount} not eligible
            </span>
          )}
          {program.movedInCount > 0 && (
            <span className="block text-xs text-text-muted">
              {movedHereNote(program.movedInCount)}
            </span>
          )}
          {program.movedOutCount > 0 && (
            <span className="block text-xs text-text-muted">
              {movedAwayNote(program.movedOutCount)}
            </span>
          )}
          {/* A request with nothing to honour is only known once the divisions have been read. */}
          {flagsAreKnown(program.flags) && program.flags.askedToPlayUp > 0 && (
            <span className="block text-xs text-text-muted">
              {askedToPlayUpNote(program.flags.askedToPlayUp)}
            </span>
          )}
        </td>
        <td className="p-4 text-text-secondary">
          <PlayFlags flags={program.flags} />
        </td>
        <td className="p-4 text-text-secondary">
          {/* Generation refuses rules the advice calls blocked: no count to estimate. */}
          {program.assessment?.blocked ? '—' : program.estimatedTeams}
        </td>
        <td className="p-4 text-text-secondary">{recommended ?? '—'}</td>
        <td className="p-4 text-text-secondary">{program.avgRosterSize}</td>
        <td className="p-4">
          {program.playerCount === 0 &&
          (program.waitlistedCount > 0 ||
            program.notEligibleCount > 0 ||
            program.movedOutCount > 0) ? (
            // Nobody to seat: no team is built, so "fits the limits" would say nothing true.
            <Badge tone="warning">{nobodyToSeat(program)}</Badge>
          ) : (
            <ProgramStatus assessment={program.assessment} />
          )}
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
        <p id="program-overview-note" className="mt-1 text-sm text-text-secondary">
          {playDownOverviewNote(playDown)}
        </p>
        {league && (
          <p className="mt-1 text-sm font-medium text-text-primary" data-testid="play-flags-league">
            {`League: ${flagSummary(league)}.`}
          </p>
        )}
      </div>
      <div className="overflow-x-auto">
        <table
          className="w-full text-left text-sm"
          aria-labelledby="program-overview-heading"
          aria-describedby="program-overview-note"
        >
          <thead>
            <tr className="border-b border-border-subtle text-text-secondary">
              <th scope="col" className="p-4 font-medium">
                Division
              </th>
              <th scope="col" className="p-4 font-medium">
                Players
              </th>
              <th scope="col" className="p-4 font-medium">
                Play-up and play-down
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
                    colSpan={7}
                    className="px-4 py-2 text-left text-xs font-semibold uppercase tracking-wide text-text-secondary"
                  >
                    {/* Sticky and wrapped: the table scrolls sideways in a narrow column, and a heading
                        as wide as the table would read cut off ("...moved in from another p"). */}
                    <span className="sticky left-4 block max-w-[22rem] whitespace-normal">
                      {group.label}
                      {group.flags && (
                        // Not capitalised: the counts are a sentence the heading reads out.
                        <span className="normal-case font-normal tracking-normal">
                          {`: ${flagSummary(group.flags)}`}
                          {flagsAreKnown(group.flags) && group.flags.movedIn > 0
                            ? ` (${movedInFromProgramsNote(group.flags.movedIn)})`
                            : ''}
                        </span>
                      )}
                    </span>
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
                  <td colSpan={7} className="p-8 text-center text-text-muted">
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
      waitlistedCount: PropTypes.number,
      notEligibleCount: PropTypes.number,
      movedInCount: PropTypes.number,
      movedOutCount: PropTypes.number,
      flags: flagCountsShape,
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
      flags: flagCountsShape,
    })
  ),
  league: flagCountsShape,
  /** The Play-down setting is on: the note under the heading says so. */
  playDown: PropTypes.bool,
};
