import React from 'react';
import PropTypes from 'prop-types';
import { AlertTriangle, X } from 'lucide-react';

/**
 * The banner a page shows when `useDashboardData` could not load.
 *
 * **Extracted rather than written five times.** `WorkflowPage` was the only
 * consumer of that hook to read its `error`, and it rendered the banner
 * inline with hardcoded Tailwind reds (`bg-red-500/10 border-red-500
 * text-red-500`) and no `role`. Four more pages and one hook needed the same
 * surface, so copying that markup would have multiplied both faults by five.
 * The classes here are the token-backed status utilities `GameConflictBanner`
 * already uses (`--color-status-error*` → `--danger*`), so the banner
 * re-themes in dark mode instead of staying a fixed 500-weight red, and it
 * introduces no new colour.
 *
 * **The message is rendered verbatim, with no lead-in.** The component is fed
 * two different kinds of string and a fixed heading would be wrong over one
 * of them: `useDashboardData`'s fetch error (a database message such as
 * "permission denied for table scheduler_runs") and, on `DashboardPage`, the
 * `location.state.error` that `ProtectedRoute` redirects there with
 * ("Unauthorized access"). The hook already supplies
 * `'Failed to load dashboard data.'` for errors that carry no readable
 * message, which is where that framing belongs.
 *
 * **Scope of `useDashboardData`'s message, stated so callers do not over-read
 * it.** That error is `firstErrorMessage([teamError, practiceError,
 * gameError])` — one string for three independent reads. A page that renders
 * only one of the three (`TeamAnalysisPage` reads `team`;
 * `GameSchedulingPage` does not read `practice`) will therefore show this
 * banner for a source it does not display, and where two reads fail it shows
 * the first in that fixed order rather than the one the page is about. That
 * is over-reporting, in the opposite direction to the defect this component
 * exists to fix, and narrowing it means per-source errors on the hook —
 * deliberately out of this change, which was scoped not to alter the hook's
 * contract. Recorded rather than left for a reader to discover.
 *
 * **`onDismiss` is optional and the button only exists when it is passed.**
 * Dismissal is `WorkflowPage`'s requirement alone, because only that page
 * merges a one-shot navigation error into the banner. The hook's `error` is
 * live state that clears itself when the fetch recovers, so on the pages that
 * show nothing else here a dismiss control would need its own
 * occurrence-scoped latch to avoid becoming a one-way mute — for no gain over
 * a banner that closes on its own.
 *
 * @param {Object} props
 * @param {string|null|undefined} props.message - Rendered verbatim; falsy renders nothing.
 * @param {() => void} [props.onDismiss] - Omit for a self-clearing banner (no dismiss button).
 * @param {string} [props.className] - Extra layout classes (spacing only).
 */
export default function DataErrorBanner({ message, onDismiss = undefined, className = '' }) {
  if (!message) return null;

  const classes = [
    'flex items-start justify-between gap-3 rounded-xl border border-status-error',
    'bg-status-error-bg p-4 text-sm text-text-primary',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div role="alert" data-testid="data-error-banner" className={classes}>
      <p className="flex items-start gap-2 m-0">
        <AlertTriangle size={18} aria-hidden="true" className="mt-0.5 shrink-0 text-status-error" />
        <span>{message}</span>
      </p>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss error"
          className="icon-btn shrink-0"
        >
          <X size={16} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

DataErrorBanner.propTypes = {
  message: PropTypes.string,
  onDismiss: PropTypes.func,
  className: PropTypes.string,
};
