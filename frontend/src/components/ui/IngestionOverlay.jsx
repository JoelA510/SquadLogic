import React, { useEffect, useState } from 'react';
import { useImport } from '../../contexts/ImportContext.jsx';
import { Activity, CheckCircle, AlertCircle, X, ChevronRight, BarChart3 } from 'lucide-react';

export function IngestionOverlay() {
  const { isImporting, progress, activeJob, importStatus } = useImport();
  const [isVisible, setIsVisible] = useState(false);
  const [isMinimized, setIsMinimized] = useState(false);

  useEffect(() => {
    const settled =
      importStatus === 'ready_to_apply' ||
      importStatus === 'completed' ||
      importStatus === 'completed_with_warnings' ||
      importStatus === 'failed';
    if (isImporting || (activeJob && !settled)) {
      const timer = setTimeout(() => setIsVisible(true), 0);
      return () => clearTimeout(timer);
    } else if (settled) {
      const timer = setTimeout(() => setIsVisible(false), 5000);
      return () => clearTimeout(timer);
    }
  }, [isImporting, activeJob, importStatus]);

  if (!isVisible) return null;

  const getStatusColor = () => {
    if (importStatus === 'failed' || importStatus === 'error') return 'text-status-error-text';
    if (importStatus === 'completed') return 'text-status-success-text';
    return 'text-text-accent';
  };

  const getStatusIcon = () => {
    if (importStatus === 'failed' || importStatus === 'error')
      return <AlertCircle className="w-5 h-5" aria-hidden="true" />;
    if (importStatus === 'completed') return <CheckCircle className="w-5 h-5" aria-hidden="true" />;
    return <Activity className="w-5 h-5 animate-pulse" aria-hidden="true" />;
  };

  const overlayTitle = activeJob?.job_type === 'fields' ? 'Field Ingestion' : 'Registration Sync';

  return (
    <div
      className={`fixed bottom-6 right-6 z-50 transition-all duration-500 ease-in-out transform ${
        isVisible ? 'translate-y-0 opacity-100' : 'translate-y-10 opacity-0'
      }`}
    >
      <div
        className={`glass-panel-enterprise p-0 overflow-hidden w-80 border border-border-subtle ${
          isImporting ? 'animate-squadlogic-pulse' : ''
        }`}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-border-subtle bg-bg-glass">
          <div className="flex items-center gap-3">
            <div className={`p-2 rounded-lg bg-bg-glass ${getStatusColor()}`}>
              {getStatusIcon()}
            </div>
            <div>
              <h3 className="text-sm font-bold text-text-primary tracking-tight">{overlayTitle}</h3>
              <p className="text-[10px] uppercase tracking-widest text-text-muted font-semibold">
                Enterprise Observability
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              aria-label={isMinimized ? 'Expand import status' : 'Minimize import status'}
              aria-expanded={!isMinimized}
              onClick={() => setIsMinimized(!isMinimized)}
              className="p-1.5 hover:bg-bg-surface-hover rounded-md transition-colors text-text-muted"
            >
              <ChevronRight
                className={`w-4 h-4 transition-transform duration-300 ${isMinimized ? 'rotate-90' : '-rotate-90'}`}
                aria-hidden="true"
              />
            </button>
            <button
              type="button"
              aria-label="Dismiss import status"
              onClick={() => setIsVisible(false)}
              className="p-1.5 hover:bg-bg-surface-hover rounded-md transition-colors text-text-muted"
            >
              <X className="w-4 h-4" aria-hidden="true" />
            </button>
          </div>
        </div>

        {!isMinimized && (
          <div className="p-4 space-y-4 bg-gradient-to-b from-transparent to-black/20">
            {/* Progress Section */}
            <div className="space-y-2">
              <div className="flex justify-between text-xs font-medium">
                <span className="text-text-muted">Real-time Progress</span>
                <span className={getStatusColor()}>{progress}%</span>
              </div>
              <div className="h-1.5 w-full bg-bg-glass rounded-full overflow-hidden">
                <div
                  role="progressbar"
                  aria-label={`${overlayTitle} progress`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={progress}
                  className={`h-full transition-all duration-300 ease-out bg-gradient-to-r from-sky-500 to-indigo-500 shadow-[0_0_8px_rgba(14,165,233,0.5)]`}
                  style={{ width: `${progress}%` }}
                />
              </div>
            </div>

            {/* Metrics Grid */}
            <div className="grid grid-cols-2 gap-3">
              <div className="p-3 rounded-xl bg-bg-glass border border-border-subtle space-y-1">
                <p className="text-[10px] text-text-muted font-bold uppercase tracking-wider">
                  Efficiency
                </p>
                <div className="flex items-center gap-2">
                  <BarChart3 className="w-4 h-4 text-text-accent" aria-hidden="true" />
                  <span className="text-sm font-bold text-text-primary">
                    {activeJob?.efficiency_metadata?.efficiency || '100'}%
                  </span>
                </div>
              </div>
              <div className="p-3 rounded-xl bg-bg-glass border border-border-subtle space-y-1">
                <p className="text-[10px] text-text-muted font-bold uppercase tracking-wider">
                  Latency
                </p>
                <div className="flex items-center gap-1.5">
                  <Activity className="w-4 h-4 text-status-success-text" aria-hidden="true" />
                  <span className="text-sm font-bold text-text-primary">
                    {activeJob?.efficiency_metadata?.latency?.toFixed(1) || '0.0'}ms
                  </span>
                </div>
              </div>
            </div>

            {/* Ingestion Meta */}
            {importStatus === 'importing' && (
              <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-sky-500/10 border border-sky-500/20">
                <div
                  className="w-1.5 h-1.5 rounded-full bg-sky-400 animate-pulse"
                  aria-hidden="true"
                />
                <span className="text-[10px] text-text-accent font-bold uppercase tracking-widest">
                  Live Broadcast Active
                </span>
              </div>
            )}

            {importStatus === 'completed' && (
              <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
                <CheckCircle className="w-3 h-3 text-status-success-text" aria-hidden="true" />
                <span className="text-[10px] text-status-success-text font-bold uppercase tracking-widest">
                  Ingestion Certified
                </span>
              </div>
            )}

            {/* Phase 5: Needs Confirmation (Indigo Accent) */}
            {activeJob?.efficiency_metadata?.needs_confirmation?.length > 0 && (
              <div className="space-y-2 pt-2 border-t border-border-subtle">
                <div className="flex items-center gap-2">
                  <AlertCircle className="w-3 h-3 text-text-accent" aria-hidden="true" />
                  <span className="text-[10px] text-text-accent font-bold uppercase tracking-widest">
                    Manual Confirmation Required
                  </span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {activeJob.efficiency_metadata.needs_confirmation.map((header) => (
                    <span
                      key={header}
                      className="px-2 py-0.5 rounded text-[9px] font-bold bg-indigo-500/10 text-text-accent border border-indigo-500/20"
                    >
                      {header}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
