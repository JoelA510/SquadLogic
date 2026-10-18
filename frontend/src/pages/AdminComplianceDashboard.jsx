import React, { useState, useEffect, useMemo } from 'react';
import { supabase } from '../lib/supabaseClient.js';
import { useOrganization } from '../contexts/OrganizationContext.jsx';
import { useAuth } from '../contexts/AuthContext.jsx';
import {
  Search,
  CheckCircle2,
  AlertCircle,
  ClipboardCheck,
  History,
  Eye,
  Check,
} from 'lucide-react';
import { logger } from '../lib/logger.js';
import DataGrid from '../components/grid/DataGrid.jsx';
import { usePlayersData } from '../hooks/usePlayersData.js';
import { useFeatures } from '../hooks/useFeatures.js';
import { FEATURE_FLAGS } from '../constants/featureFlags.js';
import { divisionDisplayName } from '../utils/divisions.js';

/**
 * One-click compliance toggle cell (paid / waiver / medical). Audited via
 * the admin_update_player RPC with optimistic UI from usePlayersData.
 */
function ComplianceToggle({ row, field, onToggle }) {
  const on = !!row[field];
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={`${field.replace(/_/g, ' ')} for ${row._name}`}
      className={`badge ${on ? 'success' : 'neutral'}`}
      style={{ cursor: 'pointer', border: 'none' }}
      onClick={() => onToggle(row.id, field, !on)}
    >
      {on ? <Check size={11} aria-hidden="true" /> : null}
      {on ? 'Received' : 'Missing'}
    </button>
  );
}

/** Roster-wide compliance grid over players.paid/waiver/medical booleans. */
function PlayerComplianceGrid() {
  const { players, divisions, loading, updatePlayer } = usePlayersData();
  const { isEnabled, genderModel } = useFeatures();
  const [search, setSearch] = useState('');
  const medicalOn = isEnabled(FEATURE_FLAGS.MEDICAL_FORMS);

  const divisionNameById = useMemo(() => {
    const map = new Map();
    divisions.forEach((division) => {
      map.set(division.id, divisionDisplayName(division.name, genderModel));
    });
    return map;
  }, [divisions, genderModel]);

  const rows = useMemo(
    () =>
      players.map((player) => ({
        ...player,
        _name: `${player.first_name || ''} ${player.last_name || ''}`.trim(),
        _division: divisionNameById.get(player.division_id) || '—',
      })),
    [players, divisionNameById]
  );

  const handleToggle = (playerId, field, next) => {
    updatePlayer(playerId, { [field]: next });
  };

  const columns = useMemo(() => {
    /** @type {any[]} */
    const cols = [
      { key: '_name', label: 'Player', width: 200 },
      { key: '_division', label: 'Division', width: 110 },
      {
        key: 'paid',
        label: 'Paid',
        width: 110,
        center: true,
        render: (row) => <ComplianceToggle row={row} field="paid" onToggle={handleToggle} />,
      },
      {
        key: 'waiver_received',
        label: 'Waiver',
        width: 110,
        center: true,
        render: (row) => (
          <ComplianceToggle row={row} field="waiver_received" onToggle={handleToggle} />
        ),
      },
    ];
    if (medicalOn) {
      cols.push({
        key: 'medical_form_received',
        label: 'Medical form',
        width: 120,
        center: true,
        render: (row) => (
          <ComplianceToggle row={row} field="medical_form_received" onToggle={handleToggle} />
        ),
      });
    }
    return cols;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [medicalOn]);

  const outstanding = players.filter(
    (player) =>
      !player.paid || !player.waiver_received || (medicalOn && !player.medical_form_received)
  ).length;

  if (loading || players.length === 0) return null;

  return (
    <div className="card" style={{ overflow: 'hidden' }}>
      <div className="card-head">
        <h3>Roster compliance</h3>
        <span className={`badge ${outstanding ? 'warning' : 'success'}`}>
          {outstanding ? `${outstanding} outstanding` : 'All clear'}
        </span>
      </div>
      <div style={{ height: 380, display: 'flex', flexDirection: 'column' }}>
        <DataGrid
          label="Roster compliance grid"
          columns={columns}
          rows={rows}
          selectable={false}
          dense
          search={search}
          setSearch={setSearch}
          searchKeys={['_name', '_division']}
          emptyText="No players on the roster yet"
        />
      </div>
    </div>
  );
}

export default function AdminComplianceDashboard() {
  const { currentOrganization } = useOrganization();
  const { isAdmin, impersonateUser, isImpersonating, user } = useAuth();
  const [forms, setForms] = useState([]);
  const [selectedFormId, setSelectedFormId] = useState('');
  const [registrations, setRegistrations] = useState([]);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    async function loadForms() {
      if (!currentOrganization?.id) return;
      try {
        const { data, error } = await supabase
          .from('registration_forms')
          .select('id, title, status')
          .eq('organization_id', currentOrganization.id)
          .order('created_at', { ascending: false });
        if (error) throw error;
        setForms(data || []);
        if (data && data.length > 0) {
          setSelectedFormId(data[0].id);
        }
      } catch (err) {
        logger.error(err);
      }
    }
    loadForms();
  }, [currentOrganization?.id]);

  useEffect(() => {
    async function loadRegistrations() {
      if (!currentOrganization?.id || !selectedFormId) return;
      setLoading(true);
      setError(null);
      try {
        const { data, error } = await supabase
          .from('registrations')
          .select(
            `
            id,
            waiver_signed,
            medical_cleared,
            responses,
            created_at,
            players ( id, first_name, last_name ),
            profiles ( id, first_name, last_name, email )
          `
          )
          .eq('organization_id', currentOrganization.id)
          .eq('form_id', selectedFormId);
        if (error) throw error;
        setRegistrations(data || []);
      } catch (err) {
        logger.error(err);
        setError('Failed to load compliance data.');
      } finally {
        setLoading(false);
      }
    }
    loadRegistrations();
  }, [currentOrganization?.id, selectedFormId]);

  const toggleMedicalStatus = async (regId, currentStatus) => {
    if (!currentOrganization?.id) return;
    const newStatus = !currentStatus;
    // Optimistic Update
    setRegistrations((prev) =>
      prev.map((r) => (r.id === regId ? { ...r, medical_cleared: newStatus } : r))
    );

    try {
      const { data, error } = await supabase.rpc('admin_update_registration_medical_status', {
        p_organization_id: currentOrganization.id,
        p_registration_id: regId,
        p_medical_cleared: newStatus,
        p_metadata: {
          ...(isImpersonating && {
            target_user_id: user.profile.id,
            impersonated_by: user.id,
            admin_email: user.email,
          }),
        },
      });
      if (error) throw error;

      const persistedStatus = data?.medical_cleared ?? newStatus;
      setRegistrations((prev) =>
        prev.map((r) => (r.id === regId ? { ...r, medical_cleared: persistedStatus } : r))
      );
    } catch (err) {
      logger.error(err);
      // Rollback
      setRegistrations((prev) =>
        prev.map((r) => (r.id === regId ? { ...r, medical_cleared: currentStatus } : r))
      );
      alert('Failed to update medical status.');
    }
  };

  return (
    <div className="max-w-7xl mx-auto space-y-8 animate-fadeIn">
      <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-display font-bold text-text-primary">
            Compliance Dashboard
          </h1>
          <p className="text-text-secondary">Track waivers, medical clearances, and forms.</p>
        </div>
        <div className="flex gap-4">{/* Future: Add 'Create Form' button */}</div>
      </div>

      {/* Roster-wide compliance booleans (players.paid/waiver/medical) */}
      <PlayerComplianceGrid />

      <div className="bg-bg-surface border border-border-subtle rounded-xl p-6 shadow-md">
        <div className="flex flex-col md:flex-row justify-between items-center gap-4 mb-6">
          <div className="w-full md:w-1/3">
            <label
              htmlFor="form-filter"
              className="block text-xs font-bold text-text-muted uppercase tracking-wider mb-2"
            >
              Filter by Form
            </label>
            <select
              id="form-filter"
              className="w-full bg-bg-app border border-border-highlight text-text-primary text-sm rounded-lg focus:ring-color-primary focus:border-color-primary block p-2.5"
              value={selectedFormId}
              onChange={(e) => setSelectedFormId(e.target.value)}
            >
              {forms.length === 0 && <option value="">No forms available...</option>}
              {forms.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.title}
                </option>
              ))}
            </select>
          </div>
          <div className="w-full md:w-1/4 relative mt-4 md:mt-0">
            <Search
              size={18}
              className="absolute left-3 top-1/2 transform -translate-y-1/2 text-text-muted"
            />
            <input
              type="text"
              placeholder="Search player/parent..."
              className="w-full bg-bg-app border border-border-highlight rounded-lg py-2 pl-10 pr-4 text-sm text-text-primary focus:border-color-primary focus:outline-none focus:ring-1 focus:ring-color-primary"
            />
          </div>
        </div>

        {loading ? (
          <div className="text-center py-12 text-text-muted animate-pulse">
            Loading compliance records...
          </div>
        ) : error ? (
          <div className="text-center py-12 text-status-error">{error}</div>
        ) : registrations.length === 0 ? (
          <div className="text-center py-12 text-text-secondary flex flex-col items-center">
            <ClipboardCheck size={48} className="text-border-highlight mb-4" />
            <p>No registrations found for this form.</p>
          </div>
        ) : (
          <div className="overflow-x-auto border border-border-subtle rounded-xl">
            <table className="w-full text-sm text-left text-text-secondary">
              <thead className="text-xs text-text-muted uppercase bg-bg-app border-b border-border-subtle">
                <tr>
                  <th className="px-6 py-4 font-semibold tracking-wider">Player</th>
                  <th className="px-6 py-4 font-semibold tracking-wider">Parent / Guardian</th>
                  <th className="px-6 py-4 font-semibold tracking-wider text-center">
                    Waiver Signed
                  </th>
                  <th className="px-6 py-4 font-semibold tracking-wider text-center">
                    Medical Clearance
                  </th>
                  <th className="px-6 py-4 font-semibold tracking-wider text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle">
                {registrations.map((reg) => (
                  <tr key={reg.id} className="bg-bg-surface hover:bg-bg-app/50 transition-colors">
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-full bg-brand-glow text-color-primary flex items-center justify-center font-bold text-xs">
                          {reg.players?.first_name?.[0]}
                          {reg.players?.last_name?.[0]}
                        </div>
                        <span className="font-medium text-text-primary">
                          {reg.players?.first_name} {reg.players?.last_name}
                        </span>
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <div className="text-text-primary">
                        {reg.profiles?.first_name} {reg.profiles?.last_name}
                      </div>
                      <div className="text-xs text-text-muted">{reg.profiles?.email}</div>
                    </td>
                    <td className="px-6 py-4 text-center">
                      {reg.waiver_signed ? (
                        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold bg-status-success-bg text-status-success border border-status-success/20">
                          <CheckCircle2 size={12} /> Confirmed
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold bg-status-warning-bg text-status-warning border border-status-warning/20">
                          <AlertCircle size={12} /> Pending
                        </span>
                      )}
                    </td>
                    <td className="px-6 py-4 text-center">
                      <button
                        onClick={() => toggleMedicalStatus(reg.id, reg.medical_cleared)}
                        className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold border transition-all hover:opacity-80 ${reg.medical_cleared ? 'bg-brand-glow bg-brand-600 text-white border-brand-400 shadow-lg shadow-brand-glow/20' : 'bg-bg-surface text-text-muted border-border-highlight hover:border-color-primary/50 hover:text-color-primary'}`}
                        title="Click to toggle medical clearance status"
                      >
                        {reg.medical_cleared ? <CheckCircle2 size={12} /> : <History size={12} />}
                        {reg.medical_cleared ? 'Cleared' : 'Reviewing'}
                      </button>
                    </td>
                    <td className="px-6 py-4 text-right">
                      <div className="flex flex-col items-end gap-1">
                        {isAdmin && reg.profiles?.id && (
                          <button
                            onClick={() => impersonateUser(reg.profiles)}
                            className="flex items-center gap-1.5 px-3 py-1 rounded-md bg-amber-500/10 text-status-warning-text text-xs font-bold border border-amber-500/20 hover:bg-amber-500/20 transition-all"
                            title="View as this parent"
                          >
                            <Eye size={12} /> View As
                          </button>
                        )}
                        <span className="text-[10px] text-text-muted">
                          {new Date(reg.created_at).toLocaleDateString()}
                        </span>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
