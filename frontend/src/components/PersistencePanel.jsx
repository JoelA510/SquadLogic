import React from 'react';
import PropTypes from 'prop-types';
import { PERSISTENCE_THEMES } from '../utils/themes.js';

/**
 * Shared shell rendered by `TeamPersistencePanel`.
 * Accepts either the legacy `theme` prop or the newer `colorTheme`; either
 * maps to a `PERSISTENCE_THEMES` key (currently 'blue' | 'green').
 */
export default function PersistencePanel({
  title = 'Supabase Persistence',
  status,
  lastSync = undefined,
  theme = undefined,
  colorTheme = undefined,
  onSync,
  stats = undefined,
  message = undefined,
  children = undefined,
}) {
  const themeKey = colorTheme || theme || 'blue';
  const palette = PERSISTENCE_THEMES[themeKey] || PERSISTENCE_THEMES.blue;

  const statusLabel = status === 'syncing' ? 'Syncing active...' : 'System Ready';
  const statusDetail = lastSync ? `Last updated ${lastSync}` : message || 'No recent sync';

  return (
    <div
      className={`relative overflow-hidden rounded-xl border border-border-subtle bg-gradient-to-br ${palette.gradientFrom} ${palette.gradientTo} p-6`}
    >
      <div className="relative z-10 flex flex-col sm:flex-row sm:items-center justify-between gap-6">
        <div className="flex items-center gap-4">
          <div className="relative flex h-12 w-12 items-center justify-center rounded-full bg-bg-glass">
            <div className={`h-3 w-3 rounded-full ${palette.dotColor} ${palette.shadowColor}`} />
            <div
              className={`absolute inset-0 animate-ping rounded-full ${palette.dotColor} opacity-20`}
            />
          </div>
          <div>
            <h3 className="text-lg font-bold text-text-primary">{title}</h3>
            <div className="flex items-center gap-2 mt-1">
              <span className={`text-sm font-medium ${palette.statusText}`}>{statusLabel}</span>
              <span className="text-text-muted">•</span>
              <span className="text-sm text-text-muted">{statusDetail}</span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={onSync}
            disabled={status === 'syncing'}
            className="glass-button relative z-20"
          >
            {status === 'syncing' ? 'Syncing...' : 'Sync to Supabase'}
          </button>
        </div>
      </div>

      {stats && stats.length > 0 && (
        <dl className="relative z-10 mt-6 grid grid-cols-2 sm:grid-cols-3 gap-3">
          {stats.map((stat) => (
            <div
              key={stat.label}
              className="rounded-lg border border-border-subtle bg-bg-glass px-3 py-2"
            >
              <dt className="text-[10px] uppercase tracking-widest text-text-muted">
                {stat.label}
              </dt>
              <dd className="text-sm font-semibold text-text-secondary mt-1">{stat.value}</dd>
            </div>
          ))}
        </dl>
      )}

      {children && <div className="relative z-10 mt-6">{children}</div>}

      {/* Background Decorative Element */}
      <div className="absolute -right-8 -top-8 h-32 w-32 rounded-full bg-bg-glass blur-3xl pointer-events-none" />
    </div>
  );
}

PersistencePanel.propTypes = {
  title: PropTypes.string,
  status: PropTypes.string.isRequired,
  lastSync: PropTypes.string,
  theme: PropTypes.oneOf(['blue', 'green']),
  colorTheme: PropTypes.oneOf(['blue', 'green']),
  onSync: PropTypes.func.isRequired,
  stats: PropTypes.arrayOf(
    PropTypes.shape({
      label: PropTypes.string.isRequired,
      value: PropTypes.oneOfType([PropTypes.string, PropTypes.number]).isRequired,
    })
  ),
  message: PropTypes.string,
  children: PropTypes.node,
};
