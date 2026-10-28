import React, { useState, useEffect, useMemo } from 'react';
import { supabase } from '../lib/supabaseClient.js';
import { fetchAllPages } from '../lib/pagedFetch.js';
import DataErrorBanner from '../components/ui/DataErrorBanner.jsx';
import { useOrganization } from '../contexts/OrganizationContext.jsx';
import { useEnterpriseMetrics } from '../contexts/AnalyticsContext.jsx';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  Cell,
} from 'recharts';
import { Download, Users, ShieldCheck, Lock } from 'lucide-react';
import { logger } from '../lib/logger.js';
import { CHART_BAR_CURSOR, CHART_SERIES } from '../constants/chartTheme.js';

/**
 * Accessible Data Table for Screen Readers.
 * Uses the .sr-only utility to remain hidden visually while providing
 * structured data to assistive technology.
 */
const AccessibleDataTable = ({ title, data, columns }) => (
  <div className="sr-only">
    <h4 id={`table-desc-${title.replace(/\s+/g, '-').toLowerCase()}`}>{title} Data Table</h4>
    <table aria-labelledby={`table-desc-${title.replace(/\s+/g, '-').toLowerCase()}`}>
      <thead>
        <tr>
          {columns.map((col) => (
            <th key={col.key} scope="col">
              {col.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {data.map((row, i) => (
          <tr key={i}>
            {columns.map((col) => (
              <td key={col.key}>{row[col.key]}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

export default function EnterpriseDashboard() {
  const { currentOrganization, currentSeasonSetting, seasonSettingsLoading } = useOrganization();
  const seasonId = currentSeasonSetting?.id;
  const [players, setPlayers] = useState([]);
  const [_teamsData, _setTeamsData] = useState([]);
  const [metrics, setMetrics] = useState({
    teams: 0,
    users: 0,
  });
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [exporting, _setExporting] = useState(false);
  const [selectedMapping, setSelectedMapping] = useState('');

  const orgSchema = currentOrganization?.settings?.custom_schema || {};

  useEffect(() => {
    async function loadData() {
      if (!currentOrganization?.id || seasonSettingsLoading) return;
      if (!seasonId) {
        // No season to describe (20261108010000: players belong to one season).
        setPlayers([]);
        setLoading(false);
        return;
      }
      try {
        // Independent reads, sent together rather than one after another.
        const orgId = currentOrganization.id;
        // Players are paged: an unranged select is cut at the server's row cap (1000), and the
        // distributions below would describe the first thousand as the whole league. A page
        // that fails throws, so the charts never draw from part of the players.
        const [pData, { data: orgData }] = await Promise.all([
          fetchAllPages(() =>
            supabase
              .from('players')
              .select('id, custom_attributes, team_id, division')
              .eq('organization_id', orgId)
              .eq('season_settings_id', seasonId)
          ),
          // One row per season of the organization: the season the header shows.
          supabase
            .from('view_org_metrics')
            .select('*')
            .eq('organization_id', orgId)
            .eq('season_settings_id', seasonId)
            .single(),
        ]);
        setLoadError(null);
        setPlayers(pData);

        if (orgData) {
          setMetrics({
            teams: orgData.total_teams,
            users: orgData.total_users,
          });
        }
      } catch (err) {
        logger.error(err);
        setPlayers([]);
        setLoadError(err?.message || 'Players could not be loaded.');
      } finally {
        setLoading(false);
      }
    }
    loadData();
  }, [currentOrganization?.id, seasonId, seasonSettingsLoading]);

  const { aggregates, isLowSample, maskedFields } = useEnterpriseMetrics(players, orgSchema);

  // Governance: Stabilize attribute options to prevent dropdown flicker
  const attributeOptions = useMemo(
    () => Object.keys(aggregates).filter((key) => !maskedFields.includes(key)),
    [aggregates, maskedFields]
  );

  useEffect(() => {
    if (!selectedMapping && attributeOptions.length > 0) {
      setSelectedMapping(attributeOptions[0]);
    }
  }, [attributeOptions, selectedMapping]);

  // Heavy Computation: Memoize dynamic chart data to maintain 60FPS during re-renders
  const dynamicChartData = useMemo(() => {
    if (!selectedMapping || !aggregates[selectedMapping]) return [];
    const counts = aggregates[selectedMapping].counts;
    return Object.keys(counts)
      .map((val) => ({
        name: val,
        value: counts[val],
      }))
      .sort((a, b) => b.value - a.value);
  }, [selectedMapping, aggregates]);

  const handleExportDummy = () => {
    alert('Export triggered');
  };

  if (loading) {
    return (
      <div className="text-center p-8 animate-pulse text-text-secondary">
        Initializing Enterprise Analytics...
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto space-y-8 animate-fadeIn">
      <DataErrorBanner
        message={
          loadError && `Players could not be loaded, so nothing below is shown: ${loadError}`
        }
      />
      {/* Header */}
      <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-display font-bold text-text-primary">
            Enterprise Dashboard
          </h1>
          <p className="text-text-secondary">Multi-Dimensional Analytics & Predictive Modularity</p>
        </div>
        <button
          onClick={handleExportDummy}
          disabled={exporting}
          className="glass-button px-6 py-2.5 shadow-lg flex items-center gap-2"
        >
          <Download size={18} /> {exporting ? 'Processing...' : 'Export Analytics'}
        </button>
      </div>

      {/* K-Anonymity Warning */}
      {isLowSample && (
        <div className="p-4 bg-status-warning-bg border border-status-warning/50 text-status-warning-text rounded-xl text-sm font-medium flex items-center gap-2 shadow-lg">
          <Lock size={16} /> Sub-population threshold active (K-Anonymity rules applied). Aggregated
          charting features are masked.
        </div>
      )}

      {/* Primary KPI Row */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="bg-bg-surface border border-border-subtle bg-bg-glass rounded-2xl p-6 shadow-md relative overflow-hidden group">
          <div className="absolute top-0 right-0 w-32 h-32 bg-brand-glow rounded-full blur-[60px] opacity-30 transition-transform group-hover:scale-150" />
          <div className="flex flex-col relative z-10">
            <span className="text-text-muted text-sm font-bold uppercase tracking-wider mb-2 flex items-center gap-2">
              <Users size={16} /> Total Players
            </span>
            <span className="text-4xl font-black tracking-tight text-text-primary">
              {players.length}
            </span>
          </div>
        </div>
        <div className="bg-bg-surface border border-border-subtle bg-bg-glass rounded-2xl p-6 shadow-md relative overflow-hidden group">
          <div className="absolute top-0 right-0 w-32 h-32 bg-status-success rounded-full blur-[60px] opacity-20 transition-transform group-hover:scale-150" />
          <div className="flex flex-col relative z-10">
            <span className="text-text-muted text-sm font-bold uppercase tracking-wider mb-2 flex items-center gap-2">
              <ShieldCheck size={16} /> Active Teams
            </span>
            <span className="text-4xl font-black tracking-tight text-text-primary">
              {metrics.teams}
            </span>
          </div>
        </div>
      </div>

      {/* Visualizations Row */}
      <div className="grid grid-cols-1 gap-6">
        {/* Dynamic Attribute Chart */}
        <div className="bg-bg-surface border border-border-subtle bg-bg-glass rounded-2xl p-6 shadow-md flex flex-col relative">
          <div className="flex items-center justify-between mb-6">
            <h3 className="text-lg font-bold text-text-primary">Fluid Attributes Distribution</h3>
            {attributeOptions.length > 0 && !isLowSample && (
              <select
                aria-label="Attribute to chart"
                className="bg-bg-surface border border-border-highlight rounded-lg px-3 py-1.5 text-sm text-text-primary focus:border-brand outline-none"
                value={selectedMapping}
                onChange={(e) => setSelectedMapping(e.target.value)}
              >
                {attributeOptions.map((opt) => (
                  <option key={opt} value={opt}>
                    {opt.replace(/_/g, ' ').toUpperCase()}
                  </option>
                ))}
              </select>
            )}
          </div>

          <div className="h-80 w-full relative">
            {isLowSample ? (
              <div className="absolute inset-0 flex flex-col items-center justify-center p-6 text-center z-10 glass-panel rounded-xl">
                <Lock size={32} className="text-text-muted mb-4" />
                <h4 className="text-text-primary font-bold mb-2">Data Masked for Privacy</h4>
                <p className="text-text-muted text-sm max-w-sm">
                  Insufficient dataset size triggers K-Anonymity protective masking. To view dynamic
                  distributions, ensure there are at least 3 players registered.
                </p>
              </div>
            ) : attributeOptions.length === 0 ? (
              <div className="absolute inset-0 flex items-center justify-center text-text-muted">
                No custom schema attributes detected.
              </div>
            ) : (
              <>
                <AccessibleDataTable
                  title={`${selectedMapping.replace(/_/g, ' ')} Distribution`}
                  data={dynamicChartData}
                  columns={[
                    { key: 'name', label: 'Attribute Value' },
                    { key: 'value', label: 'Player Count' },
                  ]}
                />
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={dynamicChartData}
                    margin={{ top: 20, right: 30, left: 0, bottom: 5 }}
                    role="img"
                    aria-label={`Bar chart showing distribution of players by ${selectedMapping.replace(/_/g, ' ')}.`}
                  >
                    <CartesianGrid
                      strokeDasharray="3 3"
                      stroke="var(--color-border-subtle)"
                      vertical={false}
                    />
                    <XAxis
                      dataKey="name"
                      stroke="var(--color-text-muted)"
                      tick={{ fill: 'var(--color-text-muted)' }}
                    />
                    <YAxis
                      stroke="var(--color-text-muted)"
                      tick={{ fill: 'var(--color-text-muted)' }}
                    />
                    <Tooltip
                      cursor={CHART_BAR_CURSOR}
                      contentStyle={{
                        backgroundColor: 'var(--color-bg-surface)',
                        borderColor: 'var(--color-border-subtle)',
                        borderRadius: '12px',
                      }}
                      itemStyle={{ color: 'var(--color-text-primary)' }}
                    />
                    <Bar
                      dataKey="value"
                      name="Players"
                      fill="var(--color-primary)"
                      radius={[6, 6, 0, 0]}
                      animationDuration={800}
                    >
                      {dynamicChartData.map((entry, index) => (
                        <Cell
                          key={`cell-${index}`}
                          fill={CHART_SERIES[index % CHART_SERIES.length]}
                        />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
