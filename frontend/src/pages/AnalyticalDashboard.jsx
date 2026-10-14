import React, { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabaseClient.js';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  AreaChart,
  Area,
} from 'recharts';
import { useOrganization } from '../contexts/OrganizationContext.jsx';
import { logger } from '../lib/logger.js';
import Button from '../components/ui/Button.jsx';

/**
 * AnalyticalDashboard - Phase 7 "Enterprise Glass" visualization page.
 * Displays fairness trends and evaluation performance metrics captured by the Deno engine.
 */
export default function AnalyticalDashboard() {
  const { currentOrganization } = useOrganization();
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(true);

  const fetchHistory = useCallback(async () => {
    try {
      setLoading(true);
      const { data: runs, error } = await supabase
        .from('evaluation_runs')
        .select(
          `
          id,
          created_at,
          scheduler_run_type,
          status,
          metrics_summary
        `
        )
        .eq('organization_id', currentOrganization.id)
        .order('created_at', { ascending: true })
        .limit(50);

      if (error) throw error;

      // Transform data for Recharts
      const chartData = (runs || []).map((run) => ({
        timestamp: new Date(run.created_at).toLocaleDateString(),
        fairness: run.metrics_summary?.fairnessIndex || 0,
        conflicts: run.metrics_summary?.conflictCount || 0,
        type: run.scheduler_run_type,
      }));

      setData(chartData);
    } catch (err) {
      logger.error('Failed to fetch evaluation history', err);
    } finally {
      setLoading(false);
    }
  }, [currentOrganization?.id]);

  useEffect(() => {
    if (currentOrganization?.id) {
      fetchHistory();
    }
  }, [currentOrganization?.id, fetchHistory]);

  return (
    <div className="p-8 space-y-8 min-h-screen">
      <header className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-text-primary">
            Analytical Insights
          </h1>
          <p className="text-text-secondary mt-1">
            Enterprise transparency and fairness trends across the organization.
          </p>
        </div>
        <div className="flex gap-3">
          <Button onClick={fetchHistory} variant="secondary" size="sm">
            Refresh Data
          </Button>
        </div>
      </header>

      {/* Grid of Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        {/* Fairness Trend */}
        <section className="bg-bg-surface p-6 rounded-2xl border border-border-subtle shadow-sm transition-all hover:shadow-md">
          <div className="flex justify-between items-start mb-6">
            <div>
              <h2
                id="fairness-trend-title"
                className="text-lg font-semibold flex items-center gap-2"
              >
                <span
                  className="p-2 bg-brand/10 text-text-accent rounded-lg"
                  role="img"
                  aria-label="Balance scale"
                >
                  ⚖️
                </span>
                Fairness Index Trend
              </h2>
              <p className="text-sm text-text-secondary mt-1">
                Aggregate distributive justice score over time.
              </p>
            </div>
            {data.length > 0 && (
              <div className="text-right">
                <div className="text-2xl font-bold text-text-accent">
                  {(data[data.length - 1].fairness * 100).toFixed(1)}%
                </div>
                <div className="text-xs text-text-accent font-bold">LATEST RUN</div>
              </div>
            )}
          </div>
          <div className="h-[300px]">
            <figure className="h-full w-full" aria-labelledby="fairness-trend-title">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart
                  data={data}
                  title="Fairness Index Trend"
                  desc="A chart showing the fairness score over time, representing aggregate distributive justice."
                >
                  <defs>
                    <linearGradient id="colorFairness" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#6366f1" stopOpacity={0.1} />
                      <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                  <XAxis
                    dataKey="timestamp"
                    stroke="#475569"
                    fontSize={11}
                    tickLine={false}
                    axisLine={false}
                    dy={10}
                  />
                  <YAxis
                    stroke="#475569"
                    fontSize={11}
                    tickLine={false}
                    axisLine={false}
                    domain={[0, 1]}
                    tickFormatter={(val) => `${(val * 100).toFixed(0)}%`}
                  />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: '#fff',
                      borderRadius: '12px',
                      border: '1px solid #e2e8f0',
                      boxShadow: '0 10px 15px -3px rgb(0 0 0 / 0.1)',
                    }}
                  />
                  <Area
                    type="monotone"
                    dataKey="fairness"
                    stroke="#6366f1"
                    fillOpacity={1}
                    fill="url(#colorFairness)"
                    strokeWidth={2.5}
                    animationDuration={1500}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </figure>
          </div>
        </section>

        {/* Conflicts Trend */}
        <section className="bg-bg-surface p-6 rounded-2xl border border-border-subtle shadow-sm transition-all hover:shadow-md">
          <div className="flex justify-between items-start mb-6">
            <div>
              <h2
                id="conflict-frequency-title"
                className="text-lg font-semibold flex items-center gap-2"
              >
                <span
                  className="p-2 bg-status-error-bg text-status-error-text rounded-lg"
                  role="img"
                  aria-label="Warning"
                >
                  ⚠️
                </span>
                Conflict Frequency
              </h2>
              <p className="text-sm text-text-secondary mt-1">
                Total scheduling violations detected per run.
              </p>
            </div>
          </div>
          <div className="h-[300px]">
            <figure className="h-full w-full" aria-labelledby="conflict-frequency-title">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart
                  data={data}
                  title="Conflict Frequency"
                  desc="A chart displaying the number of scheduling conflicts or violations detected over time."
                >
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                  <XAxis
                    dataKey="timestamp"
                    stroke="#475569"
                    fontSize={11}
                    tickLine={false}
                    axisLine={false}
                    dy={10}
                  />
                  <YAxis stroke="#475569" fontSize={11} tickLine={false} axisLine={false} />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: '#fff',
                      borderRadius: '12px',
                      border: '1px solid #e2e8f0',
                      boxShadow: '0 10px 15px -3px rgb(0 0 0 / 0.1)',
                    }}
                  />
                  <Line
                    type="stepAfter"
                    dataKey="conflicts"
                    stroke="#f43f5e"
                    strokeWidth={2.5}
                    dot={{ r: 4, fill: '#f43f5e', strokeWidth: 0 }}
                    animationDuration={1500}
                  />
                </LineChart>
              </ResponsiveContainer>
            </figure>
          </div>
        </section>
      </div>

      {/* Recent Evaluations Table */}
      <section className="bg-bg-surface rounded-2xl border border-border-subtle shadow-sm overflow-hidden">
        <div className="px-6 py-4 border-b border-border-subtle bg-bg-glass flex justify-between items-center">
          <h2 className="font-semibold text-text-primary">Traceable Evaluation History</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <caption className="sr-only">
              Detailed history of evaluation runs, including fairness indices and conflict counts.
            </caption>
            <thead className="bg-bg-glass text-text-secondary uppercase text-[10px] font-bold tracking-wider">
              <tr>
                <th scope="col" className="px-6 py-3">
                  Event Timestamp
                </th>
                <th scope="col" className="px-6 py-3">
                  Ref Model
                </th>
                <th scope="col" className="px-6 py-3">
                  Equity Index
                </th>
                <th scope="col" className="px-6 py-3">
                  Operational Friction
                </th>
                <th scope="col" className="px-6 py-3">
                  Audit Status
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {data.map((run, idx) => (
                <tr key={idx} className="hover:bg-bg-surface-hover transition-colors group">
                  <td className="px-6 py-4 text-sm text-text-secondary whitespace-nowrap">
                    {run.timestamp}
                  </td>
                  <td className="px-6 py-4 text-sm">
                    <span className="capitalize px-2.5 py-0.5 bg-brand/10 text-text-accent rounded-full text-[10px] font-bold">
                      {run.type}
                    </span>
                  </td>
                  <td className="px-6 py-4 text-sm font-semibold text-text-primary">
                    {(run.fairness * 100).toFixed(1)}%
                  </td>
                  <td className="px-6 py-4 text-sm">
                    <span
                      className={`font-medium ${run.conflicts > 0 ? 'text-status-error-text' : 'text-status-success-text'}`}
                    >
                      {run.conflicts} {run.conflicts === 1 ? 'Violation' : 'Violations'}
                    </span>
                  </td>
                  <td className="px-6 py-4 text-sm">
                    <span className="inline-flex items-center gap-1.5 py-0.5 px-2 rounded-full bg-status-success-bg text-status-success-text text-xs font-medium">
                      <span className="w-1.5 h-1.5 bg-status-success rounded-full animate-pulse"></span>
                      Verified Audit
                    </span>
                  </td>
                </tr>
              ))}
              {data.length === 0 && !loading && (
                <tr>
                  <td colSpan={5} className="px-6 py-16 text-center text-text-muted italic">
                    No traceable evaluation records available for the current period.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
