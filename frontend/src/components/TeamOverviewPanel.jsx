import React from 'react';
import PropTypes from 'prop-types';
import { Users, UserCheck, ShieldAlert, Award } from 'lucide-react';
import { formatDateTime } from '../utils/formatters.js';

const COLOR_CLASSES = {
  blue: 'text-brand-400 bg-brand-500/10 border-brand-500/30',
  green: 'text-status-success bg-status-success/10 border-status-success/30',
  amber: 'text-status-warning bg-status-warning/10 border-status-warning/30',
  purple: 'text-accent-400 bg-accent-500/10 border-accent-500/30',
};

/**
 * **There is no `timezone` prop, and its absence is the contract.**
 * `generatedAt` is a `scheduler_runs` timestamp carrying a zone, and the
 * viewer's own clock is the right one to read it on -- the `toSeasonInstant`
 * docblock in `utils/formatters.js` names this panel as one of the callers
 * that deliberately passes none. It used to be declared, typed and discarded
 * as `_timezone`, which reads as load-bearing and is not.
 *
 * This docblock used to add that its sibling `TeamListView` "DOES honour a
 * `timezone`, and that difference is real: the two render different
 * timestamps, not the same one two ways." That was wrong, and it justified
 * leaving the sibling unfixed. `DashboardWorkflow` renders the two as the
 * fallback and the child of a single `FeatureGuard`, handed the identical
 * `teamData.totals`, `teamData.divisions` and `teamData.generatedAt`: they are
 * one panel and its accessible alternative, showing the same run timestamp.
 * `TeamListView` now reads it on the viewer's clock too.
 */
export default function TeamOverviewPanel({ totals, divisions, generatedAt }) {
  const summaryItems = [
    {
      label: 'Assigned Players',
      value: totals.playersAssigned,
      icon: Users,
      color: 'blue',
    },
    {
      label: 'Target Players',
      value: totals.playersTarget,
      icon: UserCheck,
      color: 'green',
    },
    {
      label: 'Manual Review',
      value: totals.manualReviewRequired,
      icon: ShieldAlert,
      color: totals.manualReviewRequired > 0 ? 'amber' : 'green',
    },
    {
      label: 'Teams Formed',
      value: totals.totalTeams,
      icon: Award,
      color: 'purple',
    },
  ];

  return (
    <div className="space-y-8 animate-fadeIn">
      <div className="flex justify-between items-center">
        <h2 className="text-xl font-bold text-text-primary">Teaming Overview</h2>
        {generatedAt && (
          <span className="text-sm text-text-secondary">
            Generated {formatDateTime(generatedAt)}
          </span>
        )}
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {summaryItems.map(({ label, value, icon: Icon, color }) => (
          <article
            key={label}
            className={`card-glass border rounded-lg p-4 flex items-center gap-3 ${COLOR_CLASSES[color] ?? COLOR_CLASSES.blue}`}
            aria-label={label}
          >
            <Icon size={22} aria-hidden="true" />
            <div>
              <div className="text-[10px] uppercase tracking-widest opacity-75">{label}</div>
              <div className="text-xl font-display font-bold text-text-primary">{value ?? 0}</div>
            </div>
          </article>
        ))}
      </div>

      <div>
        <h3 className="text-lg font-semibold text-text-primary mb-4">Division Breakdown</h3>
        <div className="insights-grid">
          {divisions.map((division) => (
            <article
              key={division.divisionId}
              className="insight-card card-glass hover:bg-bg-surface-hover transition-colors"
              aria-labelledby={`heading-div-${division.divisionId}`}
            >
              <h3
                className="text-brand-400 font-bold mb-1"
                id={`heading-div-${division.divisionId}`}
              >
                {division.divisionId}
              </h3>
              <p className="text-text-secondary mb-3">
                {division.totalTeams} teams · {division.playersAssigned} players
              </p>
              <div className="space-y-1">
                <div className="flex justify-between text-xs">
                  <span className="text-text-muted">Roster Utilization</span>
                  <span className="text-text-primary font-medium">
                    {Math.round((division.playersAssigned / (division.totalTeams * 12)) * 100)}%
                  </span>
                </div>
                <div className="w-full bg-bg-glass h-1.5 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-brand-500 rounded-full"
                    style={{
                      width: `${Math.min(100, (division.playersAssigned / (division.totalTeams * 12)) * 100)}%`,
                    }}
                  />
                </div>
              </div>
            </article>
          ))}
        </div>
      </div>
    </div>
  );
}

TeamOverviewPanel.propTypes = {
  totals: PropTypes.object.isRequired,
  divisions: PropTypes.array.isRequired,
  generatedAt: PropTypes.string,
};
