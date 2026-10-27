import React from 'react';
import PropTypes from 'prop-types';
import { Zap, CheckCircle, AlertTriangle, Loader2, RotateCcw, XCircle } from 'lucide-react';
import Button from '../ui/Button.jsx';

/**
 * The Edge Function stops its search at the server's compute cap (`CPU_CAP_MS` in
 * `auto-scheduler-solver.ts`) and says so with this `terminationReason`. The run still completes,
 * with the best schedule found by then, so the admin is told in plain words rather than shown the
 * code. Re-running does not search further: the search starts from the same seed.
 */
const CPU_CAP_REASON = 'cpu-cap';
const CPU_CAP_NOTICE =
  "Stopped at the server's time limit. This is the best schedule found in that time; " +
  'check any unassigned teams before you apply it.';

/**
 * AutoSchedulerPanel — WCAG 2.2 AA compliant panel for triggering and
 * displaying the status of the Hill Climbing auto-scheduler.
 *
 * Renders an "Auto-Generate" button, progress indicator during optimization,
 * and a summary of results on completion.
 */
export default function AutoSchedulerPanel({
  title = 'Intelligent Auto-Scheduler',
  description = 'Optimize practice assignments for maximum fairness',
  runningLabel = 'Running Hill Climbing optimization...',
  assignedLabel = 'Assigned',
  unassignedLabel = 'Unassigned',
  status,
  progress,
  result,
  error,
  onTrigger,
  onCancel,
  onReset,
  disabled = false,
}) {
  const isRunning = status === 'running' || status === 'polling';
  const isCompleted = status === 'completed';
  const isFailed = status === 'failed';

  return (
    <section className="glass-panel p-6" aria-label="Auto-Scheduler">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-gradient-to-br from-blue-500/20 to-cyan-400/20">
            <Zap size={20} className="text-text-accent" aria-hidden="true" />
          </div>
          <div>
            <h3 className="text-lg font-display font-bold text-text-primary">{title}</h3>
            <p className="text-sm text-text-muted">{description}</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {isCompleted && (
            <Button
              variant="ghost"
              size="sm"
              onClick={onReset}
              className="flex items-center gap-1"
              aria-label="Reset auto-scheduler and start over"
            >
              <RotateCcw size={14} aria-hidden="true" />
              Reset
            </Button>
          )}
          {isRunning && onCancel && (
            <Button
              variant="danger"
              size="sm"
              onClick={onCancel}
              className="flex items-center gap-1"
              aria-label="Cancel the running optimization"
            >
              <XCircle size={14} aria-hidden="true" />
              Cancel
            </Button>
          )}
          <Button
            variant="primary"
            onClick={onTrigger}
            disabled={disabled || isRunning}
            loading={isRunning}
            aria-label={
              isRunning
                ? 'Optimizing: optimization in progress'
                : 'Auto-Generate: run auto-scheduler optimization'
            }
            aria-busy={isRunning}
          >
            <Zap size={16} aria-hidden="true" />
            {isRunning ? 'Optimizing…' : 'Auto-Generate'}
          </Button>
        </div>
      </div>

      {/* Progress indicator */}
      {isRunning && progress && (
        <div
          className="mt-4 p-4 rounded-lg bg-bg-glass border border-border-subtle"
          role="status"
          aria-live="polite"
          aria-label="Optimization progress"
        >
          <div className="flex items-center gap-3 mb-2">
            <Loader2 size={16} className="text-text-accent animate-spin" aria-hidden="true" />
            <span className="text-sm text-text-secondary">{runningLabel}</span>
          </div>
          <div className="grid grid-cols-3 gap-4 text-center">
            <div>
              <div className="text-xs text-text-muted uppercase tracking-wider">Iterations</div>
              <div className="text-lg font-display font-bold text-text-primary">
                {progress.iteration?.toLocaleString() ?? '—'}
              </div>
            </div>
            <div>
              <div className="text-xs text-text-muted uppercase tracking-wider">Best Score</div>
              <div className="text-lg font-display font-bold text-text-accent">
                {progress.bestScore != null ? `${(progress.bestScore * 100).toFixed(1)}%` : '—'}
              </div>
            </div>
            <div>
              <div className="text-xs text-text-muted uppercase tracking-wider">Elapsed</div>
              <div className="text-lg font-display font-bold text-text-primary">
                {progress.elapsedMs != null ? `${(progress.elapsedMs / 1000).toFixed(1)}s` : '—'}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Completed results. Labels take --text-secondary: --text-muted on this emerald tint is
          4.42:1 in the dark theme (axe, Wave 4). */}
      {isCompleted && result && (
        <div
          className="mt-4 p-4 rounded-lg bg-emerald-500/10 border border-emerald-500/20"
          role="status"
          aria-live="polite"
        >
          <div className="flex items-center gap-2 mb-3">
            <CheckCircle size={16} className="text-status-success-text" aria-hidden="true" />
            <span className="text-sm font-semibold text-status-success-text">
              Optimization Complete
            </span>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-center">
            <div>
              <div className="text-xs text-text-secondary uppercase tracking-wider">
                {assignedLabel}
              </div>
              <div className="text-lg font-display font-bold text-text-primary">
                {result.assignments?.length ?? 0}
              </div>
            </div>
            <div>
              <div className="text-xs text-text-secondary uppercase tracking-wider">
                {unassignedLabel}
              </div>
              <div className="text-lg font-display font-bold text-text-primary">
                {result.unassigned?.length ?? 0}
              </div>
            </div>
            <div>
              <div className="text-xs text-text-secondary uppercase tracking-wider">Score</div>
              <div className="text-lg font-display font-bold text-text-accent">
                {result.optimization?.bestScore != null
                  ? `${(result.optimization.bestScore * 100).toFixed(1)}%`
                  : '—'}
              </div>
            </div>
            <div>
              <div className="text-xs text-text-secondary uppercase tracking-wider">
                Improvement
              </div>
              <div className="text-lg font-display font-bold text-status-success-text">
                {result.optimization?.improvement != null
                  ? `+${(result.optimization.improvement * 100).toFixed(1)}%`
                  : '—'}
              </div>
            </div>
          </div>
          {result.optimization && (
            <p className="mt-3 text-xs text-text-secondary">
              {result.optimization.iterations?.toLocaleString()} iterations in{' '}
              {(result.optimization.elapsedMs / 1000).toFixed(1)}s
              {result.optimization.restarts > 0 &&
                ` (${result.optimization.restarts} restart${result.optimization.restarts > 1 ? 's' : ''})`}
              {result.optimization.terminationReason !== CPU_CAP_REASON && (
                <>
                  {' · '}
                  Terminated: {result.optimization.terminationReason}
                </>
              )}
            </p>
          )}
          {result.optimization?.terminationReason === CPU_CAP_REASON && (
            <p className="mt-2 text-sm text-text-primary">{CPU_CAP_NOTICE}</p>
          )}
        </div>
      )}

      {/* Error state */}
      {isFailed && error && (
        <div
          className="mt-4 p-4 rounded-lg bg-red-500/10 border border-red-500/20"
          role="alert"
          aria-live="assertive"
        >
          <div className="flex items-center gap-2">
            <AlertTriangle size={16} className="text-status-error-text" aria-hidden="true" />
            <span className="text-sm text-status-error-text">{error}</span>
          </div>
        </div>
      )}
    </section>
  );
}

AutoSchedulerPanel.propTypes = {
  title: PropTypes.string,
  description: PropTypes.string,
  runningLabel: PropTypes.string,
  assignedLabel: PropTypes.string,
  unassignedLabel: PropTypes.string,
  status: PropTypes.oneOf(['idle', 'running', 'polling', 'completed', 'failed']).isRequired,
  progress: PropTypes.shape({
    iteration: PropTypes.number,
    bestScore: PropTypes.number,
    elapsedMs: PropTypes.number,
  }),
  result: PropTypes.shape({
    assignments: PropTypes.array,
    unassigned: PropTypes.array,
    evaluation: PropTypes.object,
    optimization: PropTypes.object,
    runId: PropTypes.string,
  }),
  error: PropTypes.string,
  onTrigger: PropTypes.func.isRequired,
  onCancel: PropTypes.func,
  onReset: PropTypes.func.isRequired,
  disabled: PropTypes.bool,
};
