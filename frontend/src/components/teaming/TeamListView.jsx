import React from 'react';
import { formatPercent, formatDate } from '../../utils/formatters.js';

/**
 * TeamListView Component
 *
 * A high-contrast, semantic table-based alternative to the graphical TeamOverviewPanel.
 * Designed for maximum accessibility and screen-reader compatibility.
 *
 * **There is no `timezone` prop, and its absence is the contract.**
 * `generatedAt` is a `scheduler_runs` timestamp (see `teamSummaryMapper`), a
 * real instant carrying a zone, and the viewer's own clock is the right one to
 * read it on — the `toSeasonInstant` docblock in `utils/formatters.js` states
 * that rule and `TeamOverviewPanel` already follows it.
 *
 * That matters here more than anywhere else: `DashboardWorkflow` renders this
 * component and `TeamOverviewPanel` as the two arms of one `FeatureGuard`,
 * handed the identical `teamData.generatedAt`. They are one panel with an
 * accessible alternative, so a zone on one arm and not the other made the same
 * run report two different dates depending on a feature flag.
 *
 * @param {Object} props
 * @param {Object} props.totals - Global allocator totals.
 * @param {Array} props.divisions - List of division-specific results.
 * @param {string} props.generatedAt - ISO timestamp of when teams were generated.
 */
const TeamListView = ({ totals, divisions, generatedAt }) => {
  return (
    <section
      className="bg-bg-surface border-4 border-text-primary p-6 rounded-none my-4"
      aria-labelledby="accessibility-view-heading"
    >
      <header className="mb-6 border-b-2 border-text-primary pb-4">
        <h2
          id="accessibility-view-heading"
          className="text-2xl font-bold text-text-primary uppercase tracking-tight"
        >
          Drafting Summary (Table View)
        </h2>
        <p className="text-text-primary font-medium mt-2">Generated on {formatDate(generatedAt)}</p>
      </header>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        <div className="border-2 border-text-primary p-4">
          <span className="block text-xs font-bold uppercase">Divisions</span>
          <span className="text-2xl font-black">{totals.divisions}</span>
        </div>
        <div className="border-2 border-text-primary p-4">
          <span className="block text-xs font-bold uppercase">Teams</span>
          <span className="text-2xl font-black">{totals.teams}</span>
        </div>
        <div className="border-2 border-text-primary p-4">
          <span className="block text-xs font-bold uppercase">Players</span>
          <span className="text-2xl font-black">{totals.playersAssigned}</span>
        </div>
        <div className="border-2 border-text-primary p-4 bg-text-primary text-bg-surface">
          <span className="block text-xs font-bold uppercase">Overflow</span>
          <span className="text-2xl font-black">{totals.overflowPlayers}</span>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full border-collapse border-2 border-text-primary text-left">
          <caption className="sr-only">
            Detailed breakdown of team generation results by division
          </caption>
          <thead>
            <tr className="bg-text-primary text-bg-surface">
              <th className="border border-bg-surface p-3 font-bold uppercase text-sm">Division</th>
              <th className="border border-bg-surface p-3 font-bold uppercase text-sm">Teams</th>
              <th className="border border-bg-surface p-3 font-bold uppercase text-sm">Players</th>
              <th className="border border-bg-surface p-3 font-bold uppercase text-sm">
                Fill Rate
              </th>
              <th className="border border-bg-surface p-3 font-bold uppercase text-sm">
                Coach Coverage
              </th>
              <th className="border border-bg-surface p-3 font-bold uppercase text-sm">Status</th>
            </tr>
          </thead>
          <tbody>
            {divisions.map((division) => (
              <tr
                key={division.divisionId}
                className="border-b-2 border-text-primary hover:bg-bg-surface-hover transition-colors"
              >
                <td className="p-3 font-bold border-r-2 border-text-primary">
                  {division.divisionId}
                </td>
                <td className="p-3 border-r-2 border-text-primary text-center font-mono">
                  {division.totalTeams}
                </td>
                <td className="p-3 border-r-2 border-text-primary text-center font-mono">
                  {division.playersAssigned}
                </td>
                <td className="p-3 border-r-2 border-text-primary text-center font-mono">
                  {formatPercent(division.averageFillRate)}
                </td>
                <td className="p-3 border-r-2 border-text-primary text-center font-mono">
                  {formatPercent(division.coachCoverage.coverageRate)}
                </td>
                <td className="p-3">
                  {division.needsAdditionalCoaches ? (
                    <span className="bg-status-error text-white px-2 py-1 font-bold text-xs uppercase rounded">
                      Attention: Needs Coaches
                    </span>
                  ) : (
                    <span className="bg-status-success text-white px-2 py-1 font-bold text-xs uppercase rounded">
                      Roster Ready
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
};

export default TeamListView;
