import React from 'react';
import PropTypes from 'prop-types';
import { PERSISTENCE_THEMES } from '../utils/themes.js';
import Badge from './ui/Badge.jsx';

/**
 * Per-status display. Live-region contract follows `AutoSchedulerPanel`: progress and success
 * are `role="status"` + `aria-live="polite"`, failure is `role="alert"` + `aria-live="assertive"`.
 * `idle` is the resting state and is not announced. `blocked` (pending manual overrides) is a
 * standing precondition rather than a failed sync, so it is announced politely.
 */
const STATUS_DISPLAY = {
  idle: { label: 'System Ready', tone: 'neutral', dot: 'bg-status-pending' },
  syncing: {
    label: 'Syncing active...',
    tone: 'info',
    dot: 'bg-brand',
    role: 'status',
    live: 'polite',
  },
  success: {
    label: 'Sync complete',
    tone: 'success',
    dot: 'bg-status-success',
    role: 'status',
    live: 'polite',
  },
  blocked: {
    label: 'Sync blocked',
    tone: 'warning',
    dot: 'bg-status-warning',
    role: 'status',
    live: 'polite',
  },
  error: {
    label: 'Sync failed',
    tone: 'danger',
    dot: 'bg-status-error',
    role: 'alert',
    live: 'assertive',
  },
};

const UNKNOWN_STATUS_DISPLAY = {
  label: 'Status unknown',
  tone: 'warning',
  dot: 'bg-status-warning',
  role: 'status',
  live: 'polite',
};

/**
 * Shared shell rendered by `TeamPersistencePanel`.
 */
export default function PersistencePanel({
  title = 'Supabase Persistence',
  status,
  lastSync = undefined,
  onSync,
  stats = undefined,
  message = undefined,
  children = undefined,
}) {
  const palette = PERSISTENCE_THEMES.blue;
  // An unrecognised status must never read as "System Ready".
  const display = STATUS_DISPLAY[status] ?? UNKNOWN_STATUS_DISPLAY;
  const statusDetail = lastSync ? `Last updated ${lastSync}` : message || 'No recent sync';

  return (
    <div
      className={`relative overflow-hidden rounded-xl border border-border-subtle bg-gradient-to-br ${palette.gradientFrom} ${palette.gradientTo} p-6`}
    >
      <div className="relative z-10 flex flex-col sm:flex-row sm:items-center justify-between gap-6">
        <div className="flex items-center gap-4">
          <div className="relative flex h-12 w-12 items-center justify-center rounded-full bg-bg-glass">
            <div className={`h-3 w-3 rounded-full ${display.dot}`} aria-hidden="true" />
            {status === 'syncing' && (
              <div
                className={`absolute inset-0 animate-ping rounded-full ${display.dot} opacity-20`}
                aria-hidden="true"
              />
            )}
          </div>
          <div>
            <h3 className="text-lg font-bold text-text-primary">{title}</h3>
            <div
              key={status}
              className="flex items-center gap-2 mt-1"
              role={display.role}
              aria-live={display.live}
              data-testid="persistence-status"
            >
              <Badge tone={display.tone}>{display.label}</Badge>
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
  status: PropTypes.oneOf(Object.keys(STATUS_DISPLAY)).isRequired,
  lastSync: PropTypes.string,
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
