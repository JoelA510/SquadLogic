import React, { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowRight,
  Calendar,
  CheckCircle2,
  Flag,
  History,
  Home,
  Info,
  Layers,
  Shield,
  Sparkles,
  User,
  Workflow,
} from 'lucide-react';
import Page from '../components/chrome/Page.jsx';
import PageHeader from '../components/chrome/PageHeader.jsx';
import Badge from '../components/ui/Badge.jsx';
import Button from '../components/ui/Button.jsx';
import Avatar from '../components/ui/Avatar.jsx';
import LoadingScreen from '../components/LoadingScreen.jsx';
import { supabase } from '../lib/supabaseClient.js';
import { fetchAllPages } from '../lib/pagedFetch.js';
import { useAuth } from '../contexts/AuthContext.jsx';
import { useOrganization } from '../contexts/OrganizationContext.jsx';
import { usePermission } from '../hooks/usePermission.js';
import { useSetupProgress } from '../hooks/useSetupProgress.js';
import DataErrorBanner from '../components/ui/DataErrorBanner.jsx';
import { useFeatures } from '../hooks/useFeatures.js';
import { divisionDisplayName } from '../utils/divisions.js';
import { logger } from '../lib/logger.js';
import { isAdminRole } from '../constants/permissions.js';
import { useMyCoachedTeams } from '../hooks/useMyCoachedTeams.js';
import CoachScheduleCard from '../components/coach/CoachScheduleCard.jsx';
import DivisionTeamsCard from '../components/coach/DivisionTeamsCard.jsx';

/**
 * `tone` names a colour token (`--primary`, `--accent-teal`, ...) defined for both themes in
 * index.css, so the icon re-themes; the tile behind it is that colour at 12%.
 */
function KPI({ icon: Icon, tone, label, value, sub = null }) {
  const color = `var(--${tone})`;
  return (
    <div className="kpi">
      <div className="kpi-top">
        <span
          className="kpi-ico"
          style={{ background: `color-mix(in srgb, ${color} 12%, transparent)`, color }}
        >
          <Icon size={16} aria-hidden="true" />
        </span>
        {label}
      </div>
      <div className="kpi-val tnum">{value}</div>
      {sub && <div className="kpi-delta flat">{sub}</div>}
    </div>
  );
}

function useHomeData() {
  const { currentOrganization } = useOrganization();
  const orgId = currentOrganization?.id;
  const [data, setData] = useState({
    players: [],
    teams: [],
    divisions: [],
    games: [],
    practices: [],
    audit: [],
    loaded: false,
  });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!orgId) return;
      try {
        const [players, teams, divisions, games, practices, auditRes] = await Promise.all([
          fetchAllPages(() => supabase.from('players').select('*').eq('organization_id', orgId)),
          fetchAllPages(() => supabase.from('teams').select('*').eq('organization_id', orgId)),
          fetchAllPages(() => supabase.from('divisions').select('*').eq('organization_id', orgId)),
          fetchAllPages(() =>
            supabase
              .from('games')
              .select(
                `id, start_time, home_team:home_team_id (id, name, division:divisions (name)), away_team:away_team_id (id, name)`
              )
              .eq('organization_id', orgId)
          ),
          fetchAllPages(() =>
            supabase.from('practice_slots').select('id').eq('organization_id', orgId)
          ),
          supabase
            .from('audit_log')
            .select('*')
            .eq('organization_id', orgId)
            .order('created_at', { ascending: false })
            .limit(5),
        ]);
        if (cancelled) return;
        // The audit feed is a minor widget: log a failure but still render
        // the dashboard, unlike the primary reads where partial data would
        // corrupt the KPIs.
        if (auditRes.error) logger.error('[Home] audit feed load failed:', auditRes.error);
        setData({
          players,
          teams,
          divisions,
          games,
          practices,
          audit: auditRes.data || [],
          loaded: true,
        });
      } catch (err) {
        logger.error('[Home] load failed:', err);
        if (!cancelled) setData((current) => ({ ...current, loaded: true }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [orgId]);

  return data;
}

/** Admin Home — the prototype dashboard. */
function AdminHome() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { currentOrganization, currentSeasonSetting } = useOrganization();
  const { genderModel, isEnabled } = useFeatures();
  const setup = useSetupProgress();
  const { players, teams, divisions, games, practices, audit, loaded } = useHomeData();

  const firstName = user?.profile?.first_name || user?.profile?.full_name?.split(' ')[0] || 'there';

  const activePlayers = players.filter((p) => (p.status || 'active') === 'active');
  const unassigned = activePlayers.filter((p) => !p.team_id).length;
  const waitlisted = players.filter((p) => p.status === 'waitlist').length;

  const upcoming = useMemo(
    () =>
      games
        .filter((g) => g.start_time && new Date(g.start_time) >= new Date())
        .sort((a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime())
        .slice(0, 5),
    [games]
  );

  const capacityByDivision = useMemo(() => {
    return divisions
      .map((division) => {
        const divisionTeams = teams.filter((team) => team.division_id === division.id);
        const cap = divisionTeams.reduce((total, team) => total + (team.max_roster_size || 10), 0);
        const filled = players.filter(
          (player) => player.division_id === division.id && player.team_id
        ).length;
        return {
          id: division.id,
          label: divisionDisplayName(division.name, genderModel),
          cap,
          filled,
          pct: cap ? Math.min(100, Math.round((filled / cap) * 100)) : 0,
        };
      })
      .filter((entry) => entry.cap > 0)
      .slice(0, 6);
  }, [divisions, teams, players, genderModel]);

  const attention = [
    unassigned > 0 && {
      icon: User,
      color: 'var(--accent-teal)',
      text: `${unassigned} unassigned registrants`,
      action: 'Assign',
      route: '/teams/builder',
    },
    isEnabled('waitlist') &&
      waitlisted > 0 && {
        icon: History,
        color: 'var(--primary)',
        text: `${waitlisted} players on the waitlist`,
        action: 'View',
        route: '/players',
      },
  ].filter(Boolean);

  if (!loaded) return <LoadingScreen />;

  return (
    <Page
      header={
        <PageHeader
          title={`Welcome back, ${firstName}`}
          subtitle={[currentSeasonSetting?.name, currentOrganization?.name]
            .filter(Boolean)
            .join(' · ')}
          icon={
            <span className="page-obj-icon" style={{ background: 'var(--primary)' }}>
              <Home size={20} aria-hidden="true" />
            </span>
          }
          crumbs={['Home']}
          actions={
            <>
              <Button
                variant="secondary"
                size="sm"
                icon={Workflow}
                onClick={() => navigate('/workflow')}
              >
                Run pipeline
              </Button>
              <Button
                variant="primary"
                size="sm"
                icon={Sparkles}
                onClick={() => navigate('/setup')}
              >
                {setup.nextStep ? 'Resume setup' : 'Season Setup'}
              </Button>
            </>
          }
        />
      }
    >
      <div className="kpi-grid" style={{ marginBottom: 18 }}>
        <KPI icon={User} tone="primary" label="Players" value={players.length} />
        <KPI
          icon={Shield}
          tone="accent-violet"
          label="Teams"
          value={teams.length}
          sub={`${divisions.length} divisions`}
        />
        <KPI icon={Calendar} tone="accent-teal" label="Practice slots" value={practices.length} />
        <KPI icon={Flag} tone="accent-amber" label="Games scheduled" value={games.length} />
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1.55fr) minmax(0, 1fr)',
          gap: 18,
          alignItems: 'start',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          <div className="card">
            {/* Above the card head, not inside the body: `SetupChecklist`'s
                rule is that the operator reads this before the number, and
                the card head carries `doneCount/total` — a failed load
                understates that count exactly as it understates the bar. One
                surface is still above this one and is NOT fixed here: the
                page header's primary button reads `Resume setup` off the same
                regressed `nextStep`. Moving an error banner into the page
                header is a chrome change rather than a dashboard one, so it
                is named in the PR instead of done quietly. */}
            <DataErrorBanner message={setup.error} className="m-3 mb-0" />

            <div className="card-head">
              <Sparkles size={18} style={{ color: 'var(--primary)' }} aria-hidden="true" />
              <h3>Season Setup</h3>
              <div className="ch-actions">
                <span className="muted tnum" style={{ fontSize: 12.5, fontWeight: 600 }}>
                  {setup.doneCount}/{setup.total} complete
                </span>
                <Button
                  variant="secondary"
                  size="sm"
                  icon={ArrowRight}
                  onClick={() => navigate('/setup')}
                >
                  Open
                </Button>
              </div>
            </div>
            <div className="card-body">
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
                <div className="bar" style={{ flex: 1 }}>
                  <i style={{ width: `${setup.percent}%` }} />
                </div>
                <span className="tnum" style={{ fontWeight: 700, fontSize: 13 }}>
                  {setup.percent}%
                </span>
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {setup.steps.map((step) => {
                  const isNext = step.id === setup.nextStep?.id;
                  return (
                    <button
                      key={step.id}
                      type="button"
                      onClick={() => navigate(step.route)}
                      className="chip"
                      style={
                        step.done
                          ? {
                              borderColor: 'var(--success)',
                              color: 'var(--success-text)',
                              background: 'var(--success-weak)',
                              cursor: 'pointer',
                            }
                          : isNext
                            ? {
                                borderColor: 'var(--primary)',
                                color: 'var(--primary-text)',
                                background: 'var(--primary-weak)',
                                cursor: 'pointer',
                              }
                            : { cursor: 'pointer' }
                      }
                    >
                      {step.done ? (
                        <CheckCircle2 size={14} aria-hidden="true" />
                      ) : (
                        <ArrowRight size={14} aria-hidden="true" />
                      )}
                      {step.title}
                    </button>
                  );
                })}
              </div>
              {setup.nextStep && (
                <div
                  style={{
                    marginTop: 14,
                    padding: 12,
                    background: 'var(--primary-weak)',
                    borderRadius: 'var(--r-md)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                  }}
                >
                  <Info
                    size={18}
                    style={{ color: 'var(--primary-text)', flex: 'none' }}
                    aria-hidden="true"
                  />
                  <div style={{ flex: 1, fontSize: 13 }}>
                    <b>Up next:</b> {setup.nextStep.title} — {setup.nextStep.description}
                  </div>
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => navigate(setup.nextStep.route)}
                  >
                    Go
                  </Button>
                </div>
              )}
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <Flag size={18} style={{ color: 'var(--accent-amber)' }} aria-hidden="true" />
              <h3>Upcoming games</h3>
              <div className="ch-actions">
                <Link className="linklike" to="/schedule/game">
                  View schedule
                </Link>
              </div>
            </div>
            <div className="card-body flush">
              {upcoming.length === 0 && (
                <div className="muted" style={{ padding: 16, fontSize: 13 }}>
                  No upcoming games — generate the game schedule to fill this in.
                </div>
              )}
              {upcoming.map((game, index) => {
                const date = new Date(game.start_time);
                return (
                  <div
                    key={game.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 12,
                      padding: '11px 16px',
                      borderBottom:
                        index < upcoming.length - 1 ? '1px solid var(--border-soft)' : 'none',
                    }}
                  >
                    <div style={{ textAlign: 'center', width: 44, flex: 'none' }}>
                      <div style={{ fontWeight: 800, fontSize: 15 }} className="tnum">
                        {date.getDate()}
                      </div>
                      <div
                        className="muted"
                        style={{ fontSize: 11, textTransform: 'uppercase', fontWeight: 700 }}
                      >
                        {date.toLocaleDateString(undefined, { month: 'short' })}
                      </div>
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600 }}>
                        {game.home_team?.name} <span className="muted">vs</span>{' '}
                        {game.away_team?.name}
                      </div>
                      <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
                        {date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                      </div>
                    </div>
                    {/* Real client embeds division as { name }; the mock returns a string. */}
                    {(game.home_team?.division?.name || game.home_team?.division) && (
                      <Badge tone="info">
                        {divisionDisplayName(
                          game.home_team.division.name || game.home_team.division,
                          genderModel
                        )}
                      </Badge>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          <div className="card">
            <div className="card-head">
              <Layers size={18} style={{ color: 'var(--accent-violet)' }} aria-hidden="true" />
              <h3>Division capacity</h3>
            </div>
            <div
              className="card-body"
              style={{ display: 'flex', flexDirection: 'column', gap: 13 }}
            >
              {capacityByDivision.length === 0 && (
                <span className="muted" style={{ fontSize: 13 }}>
                  Capacity appears once divisions have teams.
                </span>
              )}
              {capacityByDivision.map((entry) => (
                <div key={entry.id}>
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      fontSize: 12.5,
                      marginBottom: 5,
                    }}
                  >
                    <span style={{ fontWeight: 600 }}>{entry.label}</span>
                    <span className="tnum muted">
                      {entry.filled}/{entry.cap} · {entry.pct}%
                    </span>
                  </div>
                  <div className="bar">
                    <i style={{ width: `${entry.pct}%` }} />
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <AlertTriangle size={18} style={{ color: 'var(--warning)' }} aria-hidden="true" />
              <h3>Needs attention</h3>
            </div>
            <div className="card-body flush">
              {attention.length === 0 && (
                <div className="muted" style={{ padding: 16, fontSize: 13 }}>
                  Nothing needs attention right now. 🎉
                </div>
              )}
              {attention.map((item, index) => (
                <div
                  key={item.text}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 11,
                    padding: '11px 16px',
                    borderBottom:
                      index < attention.length - 1 ? '1px solid var(--border-soft)' : 'none',
                  }}
                >
                  <span
                    className="kpi-ico"
                    style={{
                      background: 'var(--bg-sunken)',
                      color: item.color,
                      width: 26,
                      height: 26,
                    }}
                  >
                    <item.icon size={15} aria-hidden="true" />
                  </span>
                  <span style={{ flex: 1, fontSize: 13, fontWeight: 500 }}>{item.text}</span>
                  <Link className="linklike" to={item.route}>
                    {item.action}
                  </Link>
                </div>
              ))}
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <History size={18} className="muted" aria-hidden="true" />
              <h3>Recent activity</h3>
              <div className="ch-actions">
                <Link className="linklike" to="/admin/audit-logs">
                  Audit log
                </Link>
              </div>
            </div>
            <div className="card-body flush">
              {audit.length === 0 && (
                <div className="muted" style={{ padding: 16, fontSize: 13 }}>
                  No activity recorded yet.
                </div>
              )}
              {audit.map((entry, index) => (
                <div
                  key={entry.id}
                  style={{
                    display: 'flex',
                    gap: 10,
                    padding: '10px 16px',
                    borderBottom:
                      index < audit.length - 1 ? '1px solid var(--border-soft)' : 'none',
                  }}
                >
                  <Avatar name={entry.action || 'event'} size="sm" />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12.5 }}>
                      <b>{entry.action}</b>
                    </div>
                    <div className="muted" style={{ fontSize: 11.5, marginTop: 1 }}>
                      {entry.created_at
                        ? new Date(entry.created_at).toLocaleString(undefined, {
                            month: 'short',
                            day: 'numeric',
                            hour: 'numeric',
                            minute: '2-digit',
                          })
                        : ''}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </Page>
  );
}

/**
 * Coach Home (plan docs/changes/2026-10-22-admin-focus.md, R6): the teams the
 * coach coaches, their own schedule (games and practices), and the teams and
 * coaches of their divisions, names only. No coach directory: coaches see no
 * contact details (R4). Scheduling, score entry and standings are an admin's,
 * so nothing here links to them. Permits are not here yet: Phase C
 * (docs/changes/2026-10-22-phase-c-permits.md) has not been built.
 */
function CoachDashboard() {
  const { currentOrganization } = useOrganization();
  const { teams, loaded, error, previewUserId } = useMyCoachedTeams();
  const orgId = currentOrganization?.id ? String(currentOrganization.id) : null;

  if (!loaded) return <LoadingScreen />;

  return (
    <Page
      header={
        <PageHeader
          title="My Dashboard"
          subtitle="Your teams, schedule, and division at a glance."
          icon={
            <span className="page-obj-icon" style={{ background: 'var(--primary)' }}>
              <Shield size={20} aria-hidden="true" />
            </span>
          }
          crumbs={['Home']}
        />
      }
    >
      <div style={{ maxWidth: 720, display: 'flex', flexDirection: 'column', gap: 16 }}>
        {error && <DataErrorBanner message="Your teams could not be loaded. Try again shortly." />}
        {teams.length > 0
          ? teams.map((team) => (
              <div className="card" key={team.id}>
                <div
                  className="card-body"
                  style={{ display: 'flex', alignItems: 'center', gap: 12 }}
                >
                  <span
                    className="record-avatar"
                    style={{ background: 'var(--primary)', width: 44, height: 44 }}
                  >
                    <Shield size={20} aria-hidden="true" />
                  </span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 700, fontSize: 15 }}>{team.name}</div>
                    <div className="muted" style={{ fontSize: 12.5 }}>
                      Your team — open it for the roster and schedule.
                    </div>
                  </div>
                  <Link to={`/team/${team.id}`} aria-label={`Open ${team.name}`}>
                    <Button variant="primary" size="sm" icon={ArrowRight}>
                      Open team
                    </Button>
                  </Link>
                </div>
              </div>
            ))
          : !error && (
              <div className="card">
                <div className="card-body muted">
                  No team is assigned to you yet — your league admin will assign one.
                </div>
              </div>
            )}
        {teams.length > 0 && <CoachScheduleCard teams={teams} />}
        {orgId && !error && <DivisionTeamsCard orgId={orgId} previewUserId={previewUserId} />}
        <div className="card">
          <div className="card-body" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Link to="/coaches/practice-preferences">
              <Button variant="secondary" size="sm" icon={Calendar}>
                Practice preferences
              </Button>
            </Link>
          </div>
        </div>
      </div>
    </Page>
  );
}

/**
 * Home for a membership whose role SquadLogic no longer has (a stale `parent`
 * or `player`, both removed in 20261024010000): it says so, and reads nothing.
 */
function NoRoleHome() {
  return (
    <Page header={<PageHeader title="My Dashboard" crumbs={['Home']} />}>
      <div className="card" style={{ maxWidth: 720 }}>
        <div className="card-body muted">
          Your account has no role in this organization that SquadLogic recognizes. Ask a league
          administrator to set your role.
        </div>
      </div>
    </Page>
  );
}

/**
 * Home — role-scoped: admins get the league overview, coaches their focused
 * dashboard (there is no parent or player home since 20261024010000; a
 * membership still carrying either gets NoRoleHome). Under role preview the
 * previewed role wins.
 */
export default function DashboardPage() {
  // E2E Testing Error Trigger (resilience scenarios force a render error here)
  if (
    typeof window !== 'undefined' &&
    (window.__FORCE_ERROR__ === true || localStorage.getItem('__FORCE_ERROR__') === 'true')
  ) {
    throw new Error('E2E forced error for resilience testing.');
  }

  const { role } = usePermission();
  const { user, isImpersonating } = useAuth();
  const location = useLocation();
  const effectiveRole = isImpersonating ? user?.profile?.role || role : role;

  // ProtectedRoute redirects here with state.error (e.g. "Unauthorized
  // access"). This was a second hand-rolled red alert -- `role="alert"` on a
  // `.badge danger` sized back up with inline padding -- in the same file
  // that now renders `DataErrorBanner` in the Season Setup card. Two
  // differently-styled reds can appear together (an unauthorized redirect
  // onto a dashboard whose reads are also failing), which is the duplication
  // this PR exists to remove, so it goes through the shared banner too.
  const routeError = location.state?.error;
  const banner = <DataErrorBanner message={routeError} className="mx-6 mt-3" />;

  const Home =
    effectiveRole === 'coach'
      ? CoachDashboard
      : !effectiveRole || isAdminRole(effectiveRole)
        ? AdminHome
        : NoRoleHome;
  return (
    <>
      {banner}
      <Home />
    </>
  );
}
