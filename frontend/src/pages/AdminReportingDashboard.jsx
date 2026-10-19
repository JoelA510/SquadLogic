import React, { useState, useEffect } from 'react';
import { supabase } from '../lib/supabaseClient.js';
import { fetchAllPages } from '../lib/pagedFetch.js';
import { formatCsv } from '@squadlogic/core/outputGeneration.js';
import { useOrganization } from '../contexts/OrganizationContext.jsx';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  PieChart,
  Pie,
  Cell,
} from 'recharts';
import { Download, Users, ShieldCheck, MapPin, Activity } from 'lucide-react';
import { logger } from '../lib/logger.js';
import { formatTeamCoaches } from '../utils/teamCoaches.js';

export default function AdminReportingDashboard() {
  const { currentOrganization } = useOrganization();

  const [metrics, setMetrics] = useState({ players: 0, teams: 0, users: 0 });
  const [compliance, setCompliance] = useState([]);
  const [facilities, setFacilities] = useState([]);
  const [standings, setStandings] = useState([]);

  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    async function loadReports() {
      if (!currentOrganization?.id) return;
      setLoading(true);
      setError(null);
      try {
        // The four reads are independent, so they go out together. (The page
        // used to await them one after another, with a fifth, discarded
        // `view_league_standings` read in front of the real one.)
        const orgId = currentOrganization.id;
        const [
          { data: orgData, error: orgErr },
          { data: compData, error: compErr },
          { data: facData, error: facErr },
          // PostgREST can't count over a view without aggregation, so the
          // standings rows are pulled and counted by division in JS below.
          { data: rawStdData },
        ] = await Promise.all([
          supabase.from('view_org_metrics').select('*').eq('organization_id', orgId).single(),
          supabase.from('view_compliance_stats').select('*').eq('organization_id', orgId),
          supabase.from('view_facility_usage').select('*').eq('organization_id', orgId),
          supabase.from('view_league_standings').select('division').eq('organization_id', orgId),
        ]);
        if (orgErr && orgErr.code !== 'PGRST116') throw orgErr; // Ignore no rows error if brand new org
        if (compErr) throw compErr;
        if (facErr) throw facErr;

        if (orgData)
          setMetrics({
            players: orgData.total_players,
            teams: orgData.total_teams,
            users: orgData.total_users,
          });
        setCompliance(compData || []);
        setFacilities(facData || []);

        if (rawStdData) {
          const counts = rawStdData.reduce((acc, curr) => {
            const div = curr.division || 'Unassigned';
            acc[div] = (acc[div] || 0) + 1;
            return acc;
          }, {});
          setStandings(Object.keys(counts).map((key) => ({ name: key, value: counts[key] })));
        }
      } catch (err) {
        logger.error(err);
        setError('Failed to load reporting metrics.');
      } finally {
        setLoading(false);
      }
    }
    loadReports();
  }, [currentOrganization?.id]);

  const handleExportRosters = async () => {
    if (!currentOrganization?.id) return;
    setExporting(true);
    try {
      const teamsData = await fetchAllPages(() =>
        supabase
          .from('teams')
          .select('id, name, division, coach_id, assistant_coach_ids')
          .eq('organization_id', currentOrganization.id)
      );
      // 8.2: the roster export used to print `coach_id` alone, so every
      // co-coach was missing from the artifact the club hands out.
      //
      // Both id columns reference `coaches`, not `profiles` — see
      // `20260331000000_definitive_schema.sql`, where `teams.coach_id` is
      // `REFERENCES public.coaches(id)` and `assistant_coach_ids` is the
      // matching `uuid[]`. The embed here used to read `profiles!coach_id`,
      // which resolves to nothing; it printed a blank coach column before this
      // change and would have printed raw UUIDs after it. `TeamRecordPage`
      // already queries `coaches` and is the contract adopted here.
      const coachIds = [
        ...new Set(
          teamsData
            .flatMap((team) => [team.coach_id, ...(team.assistant_coach_ids ?? [])])
            .filter(Boolean)
        ),
      ];
      // Chunked: `fetchAllPages` pages the *response*, not the filter, and a
      // club with a few hundred coaches would otherwise put every UUID in one
      // query string and take the whole export down with a 414.
      const COACH_ID_BATCH = 200;
      const coachById = new Map();
      for (let start = 0; start < coachIds.length; start += COACH_ID_BATCH) {
        const batch = coachIds.slice(start, start + COACH_ID_BATCH);
        const coachRows = await fetchAllPages(() =>
          supabase.from('coaches').select('id, full_name, email').in('id', batch)
        );
        for (const coach of coachRows) coachById.set(coach.id, coach);
      }
      const playersData = await fetchAllPages(() =>
        supabase
          .from('players')
          .select('id, first_name, last_name, date_of_birth, team_id')
          .eq('organization_id', currentOrganization.id)
      );

      // Roster CSV is built client-side; @squadlogic/core outputGeneration
      // only covers practice/game schedule exports.
      const headers = [
        'Team ID',
        'Team Name',
        'Division',
        'Coaches',
        'Player First Name',
        'Player Last Name',
      ];
      const rows = [];

      teamsData.forEach((team) => {
        const teamPlayers = playersData.filter((p) => p.team_id === team.id);
        const assistantIds = team.assistant_coach_ids ?? [];
        const coaches = formatTeamCoaches({
          id: team.id,
          coach_id: team.coach_id,
          coachName: coachById.get(team.coach_id)?.full_name ?? team.coach_id ?? null,
          coachEmail: coachById.get(team.coach_id)?.email ?? null,
          assistant_coach_ids: assistantIds,
          // Positional, beside the ids: a coach the `coaches` table does not
          // hold (deleted row, or filtered by RLS) keeps their **id** in the
          // cell rather than vanishing from it. This is an admin-only export
          // that an operator can join on, so an id beats both a blank and a
          // silently shorter list; the on-screen helper makes the opposite call
          // for the same reason, and says so.
          assistant_coaches: assistantIds.map((id) => coachById.get(id)?.full_name ?? id),
          assistant_coach_emails: assistantIds.map((id) => coachById.get(id)?.email ?? null),
        });

        if (teamPlayers.length === 0) {
          rows.push({
            'Team ID': team.id,
            'Team Name': team.name,
            Division: team.division || '',
            Coaches: coaches,
            'Player First Name': 'No Players',
            'Player Last Name': '',
          });
        } else {
          teamPlayers.forEach((p) => {
            rows.push({
              'Team ID': team.id,
              'Team Name': team.name,
              Division: team.division || '',
              Coaches: coaches,
              'Player First Name': p.first_name,
              'Player Last Name': p.last_name,
            });
          });
        }
      });

      const csv = formatCsv(headers, rows);

      const blob = new Blob([csv], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `squadlogic-rosters-${new Date().toISOString().split('T')[0]}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      logger.error(err);
      alert('Failed to generate export.');
    } finally {
      setExporting(false);
    }
  };

  const COLORS = [
    'var(--color-primary)',
    'var(--color-status-success)',
    'var(--color-text-accent)',
    'var(--color-brand-400)',
    'var(--color-status-warning)',
  ];

  if (loading)
    return (
      <div className="text-center p-8 animate-pulse text-text-secondary">
        Crunching Season Data...
      </div>
    );

  return (
    <div className="max-w-7xl mx-auto space-y-8 animate-fadeIn">
      <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-display font-bold text-text-primary">Reporting Dashboard</h1>
          <p className="text-text-secondary">High-level operational metrics and exports.</p>
        </div>
        <div className="flex gap-4">
          <button
            onClick={handleExportRosters}
            disabled={exporting}
            className="glass-button px-6 py-2.5 shadow-lg flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Download size={18} /> {exporting ? 'Generating CSV...' : 'Export Rosters CSV'}
          </button>
        </div>
      </div>

      {error && (
        <div className="p-4 bg-status-error-bg border border-status-error/30 text-status-error rounded-xl text-sm font-medium">
          {error}
        </div>
      )}

      {/* Metric Cards Top Row */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div
          className="bg-bg-surface border border-border-highlight rounded-xl p-6 shadow-md relative overflow-hidden group"
          data-testid="metric-card-total-players"
        >
          <div className="absolute top-0 right-0 w-32 h-32 bg-brand-glow rounded-full blur-3xl -mr-10 -mt-10 transition-transform group-hover:scale-110" />
          <div className="flex flex-col">
            <span className="text-text-muted text-sm font-bold uppercase tracking-wider mb-2 flex items-center gap-2">
              <Users size={16} /> Total Players
            </span>
            <span
              className="text-4xl font-black text-text-primary"
              data-testid="metric-value-total-players"
            >
              {metrics.players}
            </span>
            <span className="text-xs text-color-primary mt-2">Active in Organization</span>
          </div>
        </div>
        <div
          className="bg-bg-surface border border-border-highlight rounded-xl p-6 shadow-md relative overflow-hidden group"
          data-testid="metric-card-active-teams"
        >
          <div className="absolute top-0 right-0 w-32 h-32 bg-status-success-bg rounded-full blur-3xl -mr-10 -mt-10 transition-transform group-hover:scale-110" />
          <div className="flex flex-col">
            <span className="text-text-muted text-sm font-bold uppercase tracking-wider mb-2 flex items-center gap-2">
              <ShieldCheck size={16} /> Active Teams
            </span>
            <span
              className="text-4xl font-black text-text-primary"
              data-testid="metric-value-active-teams"
            >
              {metrics.teams}
            </span>
            <span className="text-xs text-status-success mt-2">Current Season</span>
          </div>
        </div>
        <div
          className="bg-bg-surface border border-border-highlight rounded-xl p-6 shadow-md relative overflow-hidden group"
          data-testid="metric-card-staff-admins"
        >
          <div className="absolute top-0 right-0 w-32 h-32 bg-brand-glow rounded-full blur-3xl -mr-10 -mt-10 transition-transform group-hover:scale-110" />
          <div className="flex flex-col">
            <span className="text-text-muted text-sm font-bold uppercase tracking-wider mb-2 flex items-center gap-2">
              <Activity size={16} /> Staff & Admins
            </span>
            <span className="text-4xl font-black text-text-primary">{metrics.users}</span>
            <span className="text-xs text-text-accent mt-2">Registered Profiles</span>
          </div>
        </div>
      </div>

      {/* Charts Row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Compliance Chart */}
        <div className="bg-bg-surface border border-border-subtle rounded-xl p-6 shadow-md">
          <h3 className="text-lg font-bold text-text-primary mb-6">Form Compliance Status</h3>
          <div className="h-64">
            {compliance.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={compliance} margin={{ top: 20, right: 30, left: 0, bottom: 5 }}>
                  <CartesianGrid
                    strokeDasharray="3 3"
                    stroke="var(--color-border-subtle)"
                    vertical={false}
                  />
                  <XAxis
                    dataKey="form_title"
                    stroke="var(--color-text-muted)"
                    tick={{ fill: 'var(--color-text-muted)' }}
                  />
                  <YAxis
                    stroke="var(--color-text-muted)"
                    tick={{ fill: 'var(--color-text-muted)' }}
                  />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: 'var(--color-bg-app)',
                      borderColor: 'var(--color-border-subtle)',
                      borderRadius: '8px',
                    }}
                    itemStyle={{ color: 'var(--color-text-primary)' }}
                  />
                  <Bar
                    dataKey="total_registrations"
                    name="Total Submissions"
                    fill="var(--color-primary)"
                    radius={[4, 4, 0, 0]}
                  />
                  <Bar
                    dataKey="medical_cleared"
                    name="Medical Cleared"
                    fill="var(--color-status-success)"
                    radius={[4, 4, 0, 0]}
                  />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-full flex items-center justify-center text-text-muted">
                No Compliance Data
              </div>
            )}
          </div>
        </div>

        {/* Teams by Division / Facility Pie */}
        <div className="bg-bg-surface border border-border-subtle rounded-xl p-6 shadow-md">
          <h3 className="text-lg font-bold text-text-primary mb-6">Teams by Division</h3>
          <div className="h-64">
            {standings.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={standings}
                    cx="50%"
                    cy="50%"
                    innerRadius={60}
                    outerRadius={80}
                    paddingAngle={5}
                    dataKey="value"
                    label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}
                  >
                    {standings.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip
                    contentStyle={{
                      backgroundColor: 'var(--color-bg-app)',
                      borderColor: 'var(--color-border-subtle)',
                      borderRadius: '8px',
                    }}
                    itemStyle={{ color: 'var(--color-text-primary)' }}
                  />
                </PieChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-full flex items-center justify-center text-text-muted">
                No Division Data
              </div>
            )}
          </div>
        </div>

        {/* Facility Usage Full Width */}
        <div className="bg-bg-surface border border-border-subtle rounded-xl p-6 shadow-md lg:col-span-2">
          <h3 className="text-lg font-bold text-text-primary mb-6 flex items-center gap-2">
            <MapPin size={18} /> Facility Usage (Total Events)
          </h3>
          <div className="h-72">
            {facilities.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={facilities}
                  layout="vertical"
                  margin={{ top: 5, right: 30, left: 40, bottom: 5 }}
                >
                  <CartesianGrid
                    strokeDasharray="3 3"
                    stroke="var(--color-border-subtle)"
                    horizontal={false}
                  />
                  <XAxis type="number" stroke="var(--color-text-muted)" />
                  <YAxis
                    dataKey="field_name"
                    type="category"
                    stroke="var(--color-text-muted)"
                    tick={{ fill: 'var(--color-text-muted)' }}
                    width={100}
                  />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: 'var(--color-bg-app)',
                      borderColor: 'var(--color-border-subtle)',
                      borderRadius: '8px',
                    }}
                  />
                  <Bar
                    dataKey="practice_count"
                    name="Practices"
                    stackId="a"
                    fill="var(--color-primary)"
                    radius={[0, 0, 0, 0]}
                  />
                  <Bar
                    dataKey="game_count"
                    name="Games"
                    stackId="a"
                    fill="var(--color-status-success)"
                    radius={[0, 4, 4, 0]}
                  />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-full flex items-center justify-center text-text-muted">
                No Field Assignments Found
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
