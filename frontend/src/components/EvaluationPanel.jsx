import React, { useState, useEffect, useId } from 'react';
import { logger } from '../lib/logger.js';
import { Loader2, AlertCircle, Save, Activity, ShieldCheck, Zap } from 'lucide-react';
import { useOrganization } from '../contexts/OrganizationContext.jsx';
import { supabase as defaultSupabaseClient } from '../lib/supabaseClient.js';
import { cachedInvoke, edgeFunctionCache } from '../lib/cache.js';
import { PERSISTENCE_TIMEOUT, withPersistenceDeadline } from '../lib/persistenceRequest.js';

// Wave 6b Task 1: 60s TTL for fairness-scoring reads. Rationale: evaluations
// are recomputed as soon as a user edits the schedule (the effect re-fires on
// `practiceData`/`gameData` change — input change => cache key change => miss).
// Within a 60s window with IDENTICAL inputs a repeat render is exactly the
// duplicate call we want to collapse (e.g., brief re-mount, tab switch, or
// double-render in StrictMode).
const FAIRNESS_SCORING_TTL_MS = 60_000;

/**
 * Teams and slots a practice evaluation has to work with. Both are needed: the
 * engine resolves every assignment against them, so with either list empty it
 * drops every row and reports a clean schedule after examining nothing (audit
 * 13.1). Such a request is never sent; the panel says there is nothing to
 * evaluate instead.
 */
function practiceRosterOf(practiceData) {
  const teams = practiceData?.teams?.length ?? 0;
  const slots = practiceData?.slots?.length ?? 0;
  return { teams, slots, evaluable: teams > 0 && slots > 0 };
}

const countOf = (n, noun) => `${n} ${noun}${n === 1 ? '' : 's'}`;

/** The panel's title over one notice: used when there is no score to show. */
function PanelNotice({ titleId, children }) {
  return (
    <section
      className="glass-panel p-6 rounded-xl border border-border-subtle"
      aria-labelledby={titleId}
    >
      <h2 id={titleId} className="text-xl font-display font-bold text-text-primary tracking-tight">
        Fairness Scoring Engine
      </h2>
      {children}
    </section>
  );
}

/**
 * Why a `fairness-scoring` call failed, in the function's own words when it
 * gave any. supabase-js puts the response on `context`; its body carries the
 * Edge's `error` (a validation or clock refusal), which says more than the
 * client's "non-2xx" line.
 */
async function describeFailure(err) {
  const fallback = err?.message || 'unknown error';
  if (typeof err?.context?.json !== 'function') return fallback;
  try {
    const body = await err.context.json();
    return body?.error || body?.message || fallback;
  } catch {
    // Best effort: a body that is absent, consumed or not JSON leaves the
    // client's own message, which is still shown.
    return fallback;
  }
}

/**
 * EvaluationPanel - Enterprise Glass component for real-time fairness scoring.
 * Refined for Phase 7 with composite Deno-based engine support.
 *
 * `supabaseClient` is injected for tests; in normal use the component pulls
 * the shared client from `lib/supabaseClient.js` (which auto-switches between
 * real and mock per CLAUDE.md §7).
 */
export default function EvaluationPanel({
  practiceData = null,
  gameData = null,
  supabaseClient = defaultSupabaseClient,
}) {
  const { currentOrganization } = useOrganization();
  const [evaluation, setEvaluation] = useState(null);
  const [loading, setLoading] = useState(false);
  const [persisting, setPersisting] = useState(false);
  const [message, setMessage] = useState('');
  // Why the last evaluation failed, and for which inputs: a failure clears the
  // previous result, so a stale score is never shown as the current
  // schedule's, and it is shown only while those inputs are still the ones on
  // the page.
  const [failure, setFailure] = useState(
    /** @type {{ reason: string, practiceData: any, gameData: any } | null} */ (null)
  );
  const titleId = useId();
  const practiceRoster = practiceRosterOf(practiceData);
  const nothingToEvaluate = Boolean(practiceData) && !gameData && !practiceRoster.evaluable;

  // Trigger server-side evaluation when inputs change
  useEffect(() => {
    let active = true;

    const triggerEvaluation = async () => {
      // Logic requirement: Require at least one data source. A practice
      // schedule without teams or slots is not one (see `practiceRosterOf`).
      const evaluablePractice = practiceData && practiceRosterOf(practiceData).evaluable;
      if (!evaluablePractice && !gameData) {
        setEvaluation(null);
        setFailure(null);
        setLoading(false);
        return;
      }

      setLoading(true);
      try {
        // Wave 6b Task 1: TTL-cached invoke. Cache key includes organization_id
        // + all payload inputs, so different orgs + different payloads never
        // share a cache entry.
        const payload = {
          // Use `organization_id` (snake) for the cache key — `organizationId`
          // remains in the request body for Edge Function compatibility.
          organization_id: currentOrganization?.id,
          organizationId: currentOrganization?.id,
          practice: evaluablePractice
            ? {
                assignments: practiceData.assignments || [],
                teams: practiceData.teams || [],
                slots: practiceData.slots || [],
                unassigned: practiceData.unassigned || [],
                // The season's saved exceptions, when the page sent them (M4.7 follow-up).
                ...(practiceData.exceptions !== undefined
                  ? { exceptions: practiceData.exceptions }
                  : {}),
              }
            : null,
          games: gameData
            ? {
                games: gameData.games || [],
                teams: gameData.teams || [],
              }
            : null,
          persist: false,
        };
        const { data, error } = await cachedInvoke({
          functionName: 'fairness-scoring',
          params: payload,
          invoker: (name, opts) => supabaseClient.functions.invoke(name, opts),
          ttlMs: FAIRNESS_SCORING_TTL_MS,
        });

        if (error) throw error;
        if (active) {
          setEvaluation(data);
          setFailure(null);
        }
      } catch (err) {
        logger.error('Edge Function Evaluation failed:', err);
        // Nothing retries: said as it is, with no score beside it.
        const reason = await describeFailure(err);
        if (active) {
          setEvaluation(null);
          setFailure({ reason, practiceData, gameData });
        }
      } finally {
        if (active) setLoading(false);
      }
    };

    const debounceTimer = setTimeout(triggerEvaluation, 800);
    return () => {
      active = false;
      clearTimeout(debounceTimer);
    };
  }, [practiceData, gameData, supabaseClient, currentOrganization?.id]);

  const handleSave = async () => {
    if (!evaluation || !supabaseClient) return;

    setPersisting(true);
    setMessage('Hardening results in audit trail...');

    const invalidateCachedReads = () =>
      edgeFunctionCache.invalidateByPrefix(
        `fairness-scoring:${currentOrganization?.id ?? 'no-org'}:`
      );

    try {
      // Under the persistence deadline (plan M2.5's, `lib/persistenceRequest.js`):
      // "Hardening results..." used to spin forever on a request that never
      // answered. Its timeout is the request's own, not `invoke`'s, whose abort
      // surfaces as "Failed to send a request", wrong for a request that was sent.
      const { error } = await withPersistenceDeadline(
        (signal) =>
          supabaseClient.functions.invoke('fairness-scoring', {
            body: {
              organizationId: currentOrganization?.id,
              practice: practiceData,
              games: gameData,
              persist: true,
              metadata: {
                source: 'EvaluationPanel_ManualSave',
                timestamp: new Date().toISOString(),
              },
            },
            signal,
          }),
        { label: 'the save', bareMessages: true }
      );

      if (error) throw error;

      // Wave 6b Task 1: invalidate this org's cached fairness-scoring reads
      // after a persist — the server-side side-effect means prior cached
      // "persist: false" scores may be stale against a new audit trail.
      invalidateCachedReads();

      setMessage('A-1 Audit: Evaluation persisted successfully.');
      setTimeout(() => setMessage(''), 4000);
    } catch (err) {
      logger.error('Edge Function Persistence failed:', err);
      if (err?.code === PERSISTENCE_TIMEOUT) {
        // The save may still have landed after the panel stopped waiting, so
        // the cached reads are dropped as after a save that answered: the next
        // read is the server's, not one from before it.
        invalidateCachedReads();
        setMessage(
          `It is not known whether the evaluation was saved: ${err.message}. ` +
            'Check the audit trail before saving it again.'
        );
      } else {
        setMessage(`Save sync failed: ${await describeFailure(err)}`);
      }
    } finally {
      setPersisting(false);
    }
  };

  // No inputs (the page is still reading, or a read failed): nothing is shown,
  // and a score from earlier inputs is not left on screen while the debounced
  // effect catches up.
  if (!practiceData && !gameData) {
    return null;
  }

  if (nothingToEvaluate) {
    return (
      <PanelNotice titleId={titleId}>
        <p role="status" className="text-sm text-text-primary mt-1.5 font-medium">
          Nothing to evaluate: {countOf(practiceRoster.teams, 'team')} /{' '}
          {countOf(practiceRoster.slots, 'slot')}
        </p>
        <p className="text-sm text-text-muted mt-1">
          Fairness and coach conflicts need at least one team and one practice slot that can be
          placed on the season&apos;s clock, so no score is shown.
        </p>
      </PanelNotice>
    );
  }

  // Enterprise Glass Loading Skeleton
  if (loading && !evaluation) {
    return (
      <div
        className="glass-panel p-6 rounded-xl border border-border-subtle animate-pulse transition-all duration-500"
        role="status"
        aria-busy="true"
        aria-label="Fairness scoring engine is evaluating data"
      >
        <div className="flex items-center gap-6">
          <div className="w-12 h-12 rounded-lg bg-bg-glass flex items-center justify-center border border-border-subtle">
            <Activity
              className="w-6 h-6 text-indigo-400 rotate-12 transition-transform duration-1000 animate-spin"
              aria-hidden="true"
            />
          </div>
          <div className="flex-1 space-y-3">
            <div className="h-5 w-48 bg-bg-surface-hover rounded-full" />
            <div className="h-4 w-64 bg-bg-glass rounded-full" />
          </div>
          <div className="h-10 w-32 bg-bg-glass rounded-lg" />
        </div>
      </div>
    );
  }

  const failedForTheseInputs =
    failure && failure.practiceData === practiceData && failure.gameData === gameData;
  if (failedForTheseInputs && !evaluation && !loading) {
    return (
      <PanelNotice titleId={titleId}>
        <p role="alert" className="text-sm text-status-error mt-1.5 font-medium">
          The evaluation failed, so nothing was checked: {failure.reason}
        </p>
      </PanelNotice>
    );
  }

  if (!evaluation && !loading) {
    return null;
  }

  const statusConfig = {
    ok: {
      label: 'SLA Compliant',
      color: 'text-emerald-400',
      glow: 'shadow-emerald-500/20',
      bg: 'bg-emerald-500/10',
      border: 'border-emerald-500/20',
      icon: <ShieldCheck size={18} />,
    },
    'attention-needed': {
      label: 'Optimizations Available',
      color: 'text-amber-400',
      glow: 'shadow-amber-500/20',
      bg: 'bg-amber-500/10',
      border: 'border-amber-500/20',
      icon: <Zap size={18} />,
    },
    'action-required': {
      label: 'Critical Violation',
      color: 'text-rose-400',
      glow: 'shadow-rose-500/20',
      bg: 'bg-rose-500/10',
      border: 'border-rose-500/20',
      icon: <AlertCircle size={18} />,
    },
  };

  const currentStatus = statusConfig[evaluation?.status] || statusConfig.ok;
  const score = evaluation?.metrics?.combinedScore * 100 || 0;
  // What the engine examined, shown so a clean result can be told apart from
  // an empty one. Present only when the response carries a practice result.
  const practiceSummary = evaluation?.practice?.summary ?? null;
  const coachConflictCount = evaluation?.practice?.coachConflicts?.length ?? 0;

  return (
    <section
      className="glass-panel p-6 rounded-xl border border-border-subtle relative overflow-hidden transition-all duration-300 hover:shadow-md hover:shadow-indigo-500/10"
      aria-live="polite"
      aria-labelledby={titleId}
    >
      {/* Background Micro-Gradient */}
      <div className="absolute inset-0 bg-gradient-to-br from-indigo-500/10 via-transparent to-blue-500/5 pointer-events-none" />

      <div className="relative z-10 flex flex-wrap items-center justify-between gap-6">
        <div className="flex items-center gap-5">
          <div
            className={`p-3.5 rounded-xl ${currentStatus.bg} border ${currentStatus.border} ${currentStatus.glow} shadow-lg transition-transform hover:scale-110`}
            aria-hidden="true"
          >
            {loading ? (
              <Loader2 className="w-6 h-6 text-text-primary animate-spin" aria-hidden="true" />
            ) : (
              <span className={currentStatus.color}>{currentStatus.icon}</span>
            )}
          </div>
          <div>
            <div className="flex items-center gap-3">
              <h2
                id={titleId}
                className="text-xl font-display font-bold text-text-primary tracking-tight"
              >
                Fairness Scoring Engine
              </h2>
              <span
                className={`text-[10px] uppercase tracking-widest font-bold px-2 py-0.5 rounded-full border ${currentStatus.border} ${currentStatus.color}`}
              >
                {currentStatus.label}
              </span>
            </div>
            <div className="text-sm text-text-muted mt-1.5 flex items-center gap-3">
              <span>
                Fairness Index:{' '}
                <span className="text-text-primary font-mono font-bold">{score.toFixed(1)}%</span>
              </span>
              <span className="w-1 h-1 rounded-full bg-bg-surface-hover" />
              <span>
                Issues:{' '}
                <span
                  className={evaluation?.issues?.length > 0 ? 'text-amber-400' : 'text-emerald-400'}
                >
                  {evaluation?.issues?.length || 0}
                </span>
              </span>
              {practiceSummary && (
                <>
                  <span className="w-1 h-1 rounded-full bg-bg-surface-hover" />
                  <span>
                    Teams evaluated:{' '}
                    <span className="text-text-primary font-mono font-bold">
                      {practiceSummary.totalTeams}
                    </span>
                  </span>
                  <span className="w-1 h-1 rounded-full bg-bg-surface-hover" />
                  <span>
                    With a practice:{' '}
                    <span className="text-text-primary font-mono font-bold">
                      {practiceSummary.assignedTeams}
                    </span>
                  </span>
                  <span className="w-1 h-1 rounded-full bg-bg-surface-hover" />
                  <span>
                    Coach conflicts:{' '}
                    <span
                      className={
                        coachConflictCount > 0 ? 'text-status-warning' : 'text-status-success'
                      }
                    >
                      {coachConflictCount}
                    </span>
                  </span>
                </>
              )}
              {evaluation?.metrics?.executionTimeMs && (
                <>
                  <span className="w-1 h-1 rounded-full bg-bg-surface-hover" />
                  <span className="text-[10px] opacity-40 font-mono tracking-tighter">
                    LATENCY: {evaluation.metrics.executionTimeMs}ms
                  </span>
                </>
              )}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-4">
          {message && (
            <span className="text-[11px] text-indigo-300 animate-fadeIn font-mono font-medium tracking-tight bg-indigo-500/10 px-3 py-1.5 rounded-lg border border-indigo-500/20">
              {message}
            </span>
          )}

          <button
            onClick={handleSave}
            disabled={persisting || loading || !evaluation}
            title="Persist evaluation results to the audit trail"
            aria-busy={persisting}
            aria-describedby="save-audit-desc"
            className="flex items-center gap-2.5 bg-indigo-600 hover:bg-indigo-500 text-white px-6 py-2.5 rounded-lg shadow-md shadow-indigo-600/30 transition-all hover:scale-[1.03] active:scale-[0.97] disabled:opacity-40 disabled:hover:scale-100 disabled:cursor-not-allowed group font-display font-bold"
          >
            {persisting ? (
              <Loader2 size={18} className="animate-spin" aria-hidden="true" />
            ) : (
              <Save
                size={18}
                className="group-hover:translate-y-[-1px] transition-transform"
                aria-hidden="true"
              />
            )}
            <span>{persisting ? 'Hardening...' : 'Sync to Audit'}</span>
          </button>
          <span id="save-audit-desc" className="sr-only">
            Saves the current fairness index and conflict metrics into the permanent cryptographic
            audit trail.
          </span>
        </div>
      </div>

      {evaluation?.issues?.length > 0 && (
        <section
          className="mt-6 space-y-2 max-h-56 overflow-y-auto pr-3 custom-scrollbar"
          aria-label="Evaluation Issue Details"
        >
          <ul className="space-y-2">
            {evaluation.issues.map((issue, idx) => (
              <li
                key={`${issue.category}-${idx}`}
                className={`group flex items-start gap-4 p-3.5 rounded-xl border transition-all hover:translate-x-1 ${
                  issue.severity === 'error'
                    ? 'bg-rose-500/[0.03] border-rose-500/10 text-rose-200/90 hover:bg-rose-500/[0.08]'
                    : 'bg-amber-500/[0.03] border-amber-500/10 text-amber-200/90 hover:bg-amber-500/[0.08]'
                }`}
              >
                <div
                  className={`mt-1.5 w-2 h-2 rounded-full flex-shrink-0 shadow-sm ${issue.severity === 'error' ? 'bg-rose-500 shadow-rose-500/50' : 'bg-amber-500 shadow-amber-500/50'}`}
                  aria-hidden="true"
                />
                <div className="flex-1">
                  <div className="flex items-center justify-between mb-1">
                    <span className="font-bold uppercase tracking-[0.15em] text-[9px] opacity-50">
                      {issue.category.replace('_', ' ')}
                    </span>
                    {/* The engine's `details` is an object (coach-conflict, utilization)
                        that React cannot render; the message already names it. Only a
                        text detail is shown. */}
                    {typeof issue.details === 'string' && issue.details && (
                      <span className="text-[10px] opacity-40 font-mono tracking-tighter italic">
                        {issue.details}
                      </span>
                    )}
                  </div>
                  <p className="text-sm leading-snug font-medium">{issue.message}</p>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </section>
  );
}
