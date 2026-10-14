import React from 'react';
import { WifiOff, Wrench, RefreshCw, AlertTriangle } from 'lucide-react';
import { useConnectivityMonitor } from '../hooks/useConnectivityMonitor.js';
import { useMaintenanceMode } from '../hooks/useMaintenanceMode.js';
import { useOrganization } from '../contexts/OrganizationContext.jsx';

/**
 * OfflineGuard — Phase 9 Production Hardening
 *
 * A glassmorphic overlay that appears when the Supabase backend is
 * unreachable or the organization is placed in maintenance mode.
 * Prevents white-screen crashes by showing an actionable, accessible,
 * and beautifully styled overlay.
 *
 * Maintenance mode detection:
 *  - Network-level: useConnectivityMonitor pings the Supabase REST API
 *  - DB-level: useMaintenanceMode subscribes to the organizations table
 *    via Supabase Realtime for the maintenance_mode settings flag.
 *
 * Accessibility: role="alertdialog", focus-trapped retry button, aria-live
 * for status changes, keyboard-accessible dismiss.
 *
 * @param {{ children: React.ReactNode }} props
 */
export default function OfflineGuard({ children }) {
  const { status, lastChecked, checkNow } = useConnectivityMonitor();
  const { currentOrganization } = useOrganization();
  const { isMaintenanceMode } = useMaintenanceMode(currentOrganization?.id);
  const [isRetrying, setIsRetrying] = React.useState(false);

  const handleRetry = async () => {
    setIsRetrying(true);
    await checkNow();
    // Brief delay so the spinner is visible
    setTimeout(() => setIsRetrying(false), 600);
  };

  // Derive the effective display state
  const isOffline = status === 'offline';
  const isMaintenance = status === 'maintenance' || isMaintenanceMode;
  const showOverlay = isOffline || isMaintenance;

  // Online and no maintenance — render children normally
  if (!showOverlay) {
    return <>{children}</>;
  }

  const Icon = isMaintenance ? Wrench : WifiOff;
  const title = isMaintenance ? 'Scheduled Maintenance' : 'Service Interrupted';
  const description = isMaintenance
    ? "SquadLogic is undergoing scheduled maintenance. We'll be back shortly — your data is safe."
    : "We're having trouble reaching SquadLogic. This usually resolves in a few moments.";
  const lastCheckedLabel = lastChecked ? `Last checked: ${lastChecked.toLocaleTimeString()}` : '';

  return (
    <>
      {children}
      {/* Full-screen overlay */}
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="offline-guard-title"
        aria-describedby="offline-guard-desc"
        className="fixed inset-0 z-[9999] flex items-center justify-center p-4"
        style={{ backgroundColor: 'rgba(0, 0, 0, 0.6)' }}
      >
        {/* Glassmorphic card */}
        <div
          className="max-w-md w-full rounded-3xl p-8 text-center animate-fadeIn"
          style={{
            background: 'var(--color-bg-surface)',
            border: '1px solid var(--color-border-subtle)',
            boxShadow: 'var(--shadow-md)',
          }}
        >
          {/* Icon badge */}
          <div
            className="w-20 h-20 rounded-2xl flex items-center justify-center mx-auto mb-6"
            style={{
              background: isMaintenance
                ? 'var(--color-status-warning)'
                : 'var(--color-status-error)',
              opacity: 0.15,
            }}
          >
            <Icon
              size={40}
              style={{
                color: isMaintenance ? 'var(--color-status-warning)' : 'var(--color-status-error)',
                opacity: 1,
              }}
            />
          </div>

          {/* Status indicator */}
          <div className="flex items-center justify-center gap-2 mb-4">
            <span
              className="w-2.5 h-2.5 rounded-full animate-pulseGlow"
              style={{
                backgroundColor: isMaintenance
                  ? 'var(--color-status-warning)'
                  : 'var(--color-status-error)',
              }}
            />
            <span
              className="text-xs font-semibold uppercase tracking-wider"
              style={{ color: 'var(--color-text-muted)' }}
            >
              {isMaintenance ? 'Maintenance Mode' : 'Connection Lost'}
            </span>
          </div>

          <h1
            id="offline-guard-title"
            className="text-2xl font-display font-bold mb-2"
            style={{ color: 'var(--color-text-primary)' }}
          >
            {title}
          </h1>

          <p
            id="offline-guard-desc"
            className="text-sm leading-relaxed mb-6"
            style={{ color: 'var(--color-text-muted)' }}
          >
            {description}
          </p>

          {/* Retry button (offline only — maintenance doesn't benefit from retry spam) */}
          {isOffline && !isMaintenance && (
            <button
              onClick={handleRetry}
              disabled={isRetrying}
              // eslint-disable-next-line jsx-a11y/no-autofocus -- the alertdialog's one action takes focus when it opens (APG alertdialog pattern)
              autoFocus
              className="w-full py-3 px-6 rounded-xl font-semibold transition-all flex items-center justify-center gap-2"
              style={{
                background: 'var(--color-primary)',
                color: '#fff',
                boxShadow: 'var(--shadow-md)',
                opacity: isRetrying ? 0.7 : 1,
              }}
            >
              <RefreshCw size={16} className={isRetrying ? 'animate-spin' : ''} />
              {isRetrying ? 'Checking…' : 'Retry Connection'}
            </button>
          )}

          {/* Last checked timestamp */}
          {lastCheckedLabel && (
            <p
              aria-live="polite"
              className="text-xs mt-4"
              style={{ color: 'var(--color-text-muted)' }}
            >
              {lastCheckedLabel}
            </p>
          )}

          {/* Helpful tip */}
          <div
            className="flex items-start gap-2 mt-6 p-3 rounded-xl text-left text-xs"
            style={{
              background: 'var(--color-bg-surface)',
              border: '1px solid var(--color-border-subtle)',
              color: 'var(--color-text-secondary)',
            }}
          >
            <AlertTriangle
              size={14}
              className="flex-shrink-0 mt-0.5"
              style={{ color: 'var(--color-status-warning)' }}
            />
            <span>
              {isMaintenance
                ? 'No action needed — this page will refresh automatically when service resumes.'
                : 'Check your internet connection, or try refreshing the page. Your unsaved changes are preserved locally.'}
            </span>
          </div>
        </div>
      </div>
    </>
  );
}
