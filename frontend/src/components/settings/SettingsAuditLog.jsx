import React, { useEffect, useState, useMemo } from 'react';
import { supabase } from '../../lib/supabaseClient.js';
import { useOrganization } from '../../contexts/OrganizationContext.jsx';
import { Loader2, Search, AlertCircle, Clock, User, ArrowRight } from 'lucide-react';
import { logger } from '../../lib/logger.js';
import { isAdminRole } from '../../constants/permissions.js';

/**
 * @typedef {Object} AuditLogEntry
 * @property {string} id - Unique identifier for the audit entry.
 * @property {string} created_at - Timestamp of the event.
 * @property {string} action - Action performed (e.g., 'settings.updated').
 * @property {string} resource_type - Type of resource affected.
 * @property {string} resource_id - UUID of the affected resource.
 * @property {Object} metadata - JSON blob containing change details (old/new values).
 * @property {string} actor_name - Full name of the user who performed the action.
 * @property {string} actor_email - Email address of the user who performed the action.
 */

/**
 * SettingsAuditLog Component
 *
 * Renders a searchable, filtered table of administrative audit events.
 * Specifically tracks 'settings.updated' and 'feature_flags.updated' actions.
 * Access is restricted to organization administrators via both UI logic and database-level checks.
 *
 * @returns {React.ReactElement} The rendered audit log view.
 */
const SettingsAuditLog = () => {
  const { currentOrganization, orgMember } = useOrganization();
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterAction, setFilterAction] = useState('all');

  // The page reads through get_settings_audit_log, which is_org_admin() gates.
  const isAdmin = isAdminRole(orgMember?.role);

  useEffect(() => {
    if (!currentOrganization?.id || !isAdmin) {
      setLoading(false);
      return;
    }

    const fetchLogs = async () => {
      setLoading(true);
      setError(null);
      try {
        const { data, error: fetchError } = await supabase.rpc('get_settings_audit_log', {
          p_organization_id: currentOrganization.id,
        });

        if (fetchError) throw fetchError;
        setLogs(data || []);
      } catch (err) {
        logger.error('Failed to fetch audit logs:', err);
        setError('Failed to load audit logs. Please try again later.');
      } finally {
        setLoading(false);
      }
    };

    fetchLogs();
  }, [currentOrganization?.id, isAdmin]);

  /**
   * Filters logs based on search query and action type.
   */
  const filteredLogs = useMemo(() => {
    return logs.filter((log) => {
      const actorMatch =
        log.actor_name?.toLowerCase().includes(searchQuery.toLowerCase()) ||
        log.actor_email?.toLowerCase().includes(searchQuery.toLowerCase());

      const contentMatch = JSON.stringify(log.metadata)
        .toLowerCase()
        .includes(searchQuery.toLowerCase());

      const matchesSearch = actorMatch || contentMatch;
      const matchesAction = filterAction === 'all' || log.action === filterAction;

      return matchesSearch && matchesAction;
    });
  }, [logs, searchQuery, filterAction]);

  /**
   * Formats values for display in the 'Changes' column.
   * @param {any} val - The value to format.
   * @returns {string} Formatted string representation.
   */
  const formatValue = (val) => {
    if (val === null || val === undefined) return 'None';
    if (typeof val === 'object') return JSON.stringify(val);
    if (typeof val === 'boolean') return val ? 'Enabled' : 'Disabled';
    return String(val);
  };

  /**
   * Renders the change details from audit metadata.
   * Handles both field-specific diffs and generic metadata blobs.
   *
   * @param {Object} metadata - The audit metadata object.
   */
  const renderChange = (metadata) => {
    if (!metadata) return <span className="text-text-muted">No details</span>;

    const { old: oldVal, new: newVal, field } = metadata;

    // If we have a standard field diff (common in our settings/flags updates)
    if (field && (oldVal !== undefined || newVal !== undefined)) {
      return (
        <div className="flex flex-col gap-1">
          <div className="text-[10px] font-bold text-text-muted uppercase tracking-tighter opacity-50">
            Property: {field}
          </div>
          <div className="flex items-center gap-2 text-xs">
            <span className="px-1.5 py-0.5 rounded bg-red-500/10 text-status-error-text line-through border border-red-500/10">
              {formatValue(oldVal)}
            </span>
            <ArrowRight size={12} className="text-text-muted shrink-0" />
            <span className="px-1.5 py-0.5 rounded bg-green-500/10 text-status-success-text border border-green-500/10 font-medium">
              {formatValue(newVal)}
            </span>
          </div>
        </div>
      );
    }

    // Fallback for complex metadata structure
    return (
      <pre className="text-[10px] text-text-muted bg-bg-glass p-2 rounded max-h-24 overflow-y-auto font-mono scrollbar-thin">
        {JSON.stringify(metadata, null, 2)}
      </pre>
    );
  };

  if (!isAdmin) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <div className="w-16 h-16 rounded-full bg-red-500/10 flex items-center justify-center text-status-error-text mb-4 border border-red-500/20">
          <AlertCircle size={32} />
        </div>
        <h3 className="text-xl font-semibold text-text-primary mb-2">Access Denied</h3>
        <p className="text-text-secondary max-w-md">
          Administrative privileges are required to view the organization audit trail.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-fadeIn">
      {/* Header & Controls */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div className="relative flex-1 w-full">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" size={18} />
          <input
            type="text"
            placeholder="Search by user, email, or change content..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full bg-bg-surface border border-border-subtle rounded-lg pl-10 pr-4 py-2.5 text-sm text-text-primary focus:outline-none focus:border-brand-400 focus:ring-1 focus:ring-brand-400/20 transition-all shadow-sm"
          />
        </div>
        <div className="flex gap-2 w-full md:w-auto">
          <select
            value={filterAction}
            onChange={(e) => setFilterAction(e.target.value)}
            className="flex-1 md:flex-none bg-bg-surface border border-border-subtle rounded-lg px-4 py-2.5 text-sm text-text-primary focus:outline-none focus:border-brand-400 transition-colors cursor-pointer"
          >
            <option value="all">All Actions</option>
            <option value="settings.updated">General Settings</option>
            <option value="feature_flags.updated">Feature Flags</option>
          </select>
        </div>
      </div>

      {loading ? (
        <div className="flex flex-col items-center justify-center py-32">
          <Loader2 className="animate-spin text-text-accent mb-4" size={40} />
          <p className="text-text-muted animate-pulse">Synchronizing audit trail...</p>
        </div>
      ) : error ? (
        <div className="p-6 rounded-xl bg-red-500/5 border border-red-500/20 text-status-error-text flex items-start gap-4">
          <AlertCircle size={24} className="shrink-0" />
          <div className="space-y-1">
            <p className="font-semibold">Sync Error</p>
            <p className="text-sm opacity-80">{error}</p>
          </div>
        </div>
      ) : filteredLogs.length === 0 ? (
        <div className="text-center py-32 border-2 border-dashed border-border-subtle rounded-2xl bg-bg-glass">
          <Clock size={48} className="mx-auto text-text-muted mb-4 opacity-10" />
          <p className="text-text-secondary font-semibold text-lg">No audit events found</p>
          <p className="text-text-muted text-sm mt-1 max-w-xs mx-auto">
            {searchQuery
              ? `No results matching "${searchQuery}" in ${filterAction === 'all' ? 'any category' : filterAction.replace('.', ' ')}.`
              : 'Security and configuration changes will be logged here automatically.'}
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-border-subtle bg-bg-glass shadow-md">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-border-subtle bg-bg-glass">
                  <th className="px-6 py-4 text-[11px] font-bold text-text-muted uppercase tracking-widest">
                    Timestamp
                  </th>
                  <th className="px-6 py-4 text-[11px] font-bold text-text-muted uppercase tracking-widest">
                    Actor
                  </th>
                  <th className="px-6 py-4 text-[11px] font-bold text-text-muted uppercase tracking-widest">
                    Action Type
                  </th>
                  <th className="px-6 py-4 text-[11px] font-bold text-text-muted uppercase tracking-widest">
                    Change Details
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle">
                {filteredLogs.map((log) => (
                  <tr key={log.id} className="hover:bg-bg-glass transition-all group">
                    <td className="px-6 py-5 whitespace-nowrap">
                      <div className="flex flex-col">
                        <span className="text-sm text-text-primary font-medium">
                          {new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(
                            new Date(log.created_at)
                          )}
                        </span>
                        <span className="text-xs text-text-muted opacity-60">
                          {new Intl.DateTimeFormat(undefined, { timeStyle: 'short' }).format(
                            new Date(log.created_at)
                          )}
                        </span>
                      </div>
                    </td>
                    <td className="px-6 py-5">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-xl bg-brand-500/10 flex items-center justify-center text-text-accent border border-brand-500/20 group-hover:scale-105 transition-transform shadow-inner">
                          <User size={16} />
                        </div>
                        <div className="flex flex-col min-w-0">
                          <span className="text-sm font-semibold text-text-primary truncate">
                            {log.actor_name}
                          </span>
                          <span className="text-xs text-text-muted truncate opacity-70">
                            {log.actor_email}
                          </span>
                        </div>
                      </div>
                    </td>
                    <td className="px-6 py-5 whitespace-nowrap">
                      <span
                        className={`px-2.5 py-1 rounded-lg text-[10px] font-bold uppercase tracking-tight border ${
                          log.action === 'feature_flags.updated'
                            ? 'bg-purple-500/10 text-text-accent border-purple-500/20'
                            : 'bg-blue-500/10 text-text-accent border-blue-500/20'
                        }`}
                      >
                        {log.action.split('.')[0]}
                      </span>
                    </td>
                    <td className="px-6 py-5">{renderChange(log.metadata)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="px-6 py-4 bg-bg-glass border-t border-border-subtle flex justify-between items-center">
            <span className="text-xs text-text-muted">
              Showing {filteredLogs.length} of {logs.length} events
            </span>
            <div className="text-[10px] text-text-muted/40 uppercase font-bold tracking-widest flex items-center gap-2">
              <Clock size={10} /> Immutable Audit Trail
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default SettingsAuditLog;
