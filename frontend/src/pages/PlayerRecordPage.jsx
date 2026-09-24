import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Calendar, Check, ChevronRight, Clock, Flag, Shield, Star } from 'lucide-react';
import Page from '../components/chrome/Page.jsx';
import Tabs from '../components/ui/Tabs.jsx';
import Badge from '../components/ui/Badge.jsx';
import Button from '../components/ui/Button.jsx';
import Avatar from '../components/ui/Avatar.jsx';
import Toggle from '../components/ui/Toggle.jsx';
import InlineField from '../components/ui/InlineField.jsx';
import { useToast } from '../components/ui/ToastHost.jsx';
import { supabase } from '../lib/supabaseClient.js';
import { useOrganization } from '../contexts/OrganizationContext.jsx';
import { useFeatures } from '../hooks/useFeatures.js';
import { FEATURE_FLAGS } from '../constants/featureFlags.js';
import { divisionDisplayName } from '../utils/divisions.js';
import { STATUS_TONE } from '../constants/playerStatus.js';
import { logger } from '../lib/logger.js';
import LoadingScreen from '../components/LoadingScreen.jsx';

function Stars({ n = 0 }) {
  if (!n) return <span className="muted">Unrated</span>;
  return (
    <span style={{ display: 'inline-flex', gap: 1, color: 'var(--accent-amber)' }}>
      {Array.from({ length: n }, (_, index) => (
        <Star key={index} size={14} fill="currentColor" aria-hidden="true" />
      ))}
    </span>
  );
}

/**
 * Player record — hero + tabs (Overview / Guardians / Team & Schedule /
 * Compliance). Inline edits persist through admin_update_player.
 */
export default function PlayerRecordPage() {
  const { playerId } = useParams();
  const navigate = useNavigate();
  const { currentOrganization } = useOrganization();
  const { isEnabled, genderModel } = useFeatures();
  const toast = useToast();
  const [player, setPlayer] = useState(null);
  const [divisions, setDivisions] = useState([]);
  const [teams, setTeams] = useState([]);
  const [practices, setPractices] = useState([]);
  const [practicesFailed, setPracticesFailed] = useState(false);
  const [games, setGames] = useState([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('overview');

  const orgId = currentOrganization?.id;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!orgId || !playerId) return;
      setLoading(true);
      try {
        const [playerRes, divisionsRes, teamsRes] = await Promise.all([
          supabase.from('players').select('*').eq('id', playerId),
          supabase.from('divisions').select('*').eq('organization_id', orgId),
          supabase.from('teams').select('*').eq('organization_id', orgId),
        ]);
        if (cancelled) return;
        const found = (playerRes.data || [])[0] || null;
        setPlayer(found);
        setDivisions(divisionsRes.data || []);
        setTeams(teamsRes.data || []);
        if (found?.team_id) {
          const [practicesRes, gamesRes] = await Promise.all([
            // Team ownership of practices lives on practice_assignments
            // (practice_slots has no team_id column).
            supabase
              .from('practice_assignments')
              .select(
                'id, slot:practice_slots!practice_slot_id (day_of_week, start_time, end_time)'
              )
              .eq('team_id', found.team_id)
              .limit(10),
            supabase
              .from('games')
              .select(
                `id, start_time, score_home, score_away,
                 home_team:home_team_id (id, name), away_team:away_team_id (id, name)`
              )
              .or(`home_team_id.eq.${found.team_id},away_team_id.eq.${found.team_id}`)
              .order('start_time', { ascending: true })
              .limit(10),
          ]);
          if (!cancelled) {
            if (practicesRes.error) {
              logger.error('[PlayerRecord] practices read failed:', practicesRes.error);
            }
            setPracticesFailed(Boolean(practicesRes.error));
            setPractices(practicesRes.data || []);
            setGames(gamesRes.data || []);
          }
        }
      } catch (err) {
        logger.error('[PlayerRecord] load failed:', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [orgId, playerId]);

  const save = useCallback(
    async (patch) => {
      const previous = player;
      setPlayer((current) => ({ ...current, ...patch }));
      const { error } = await supabase.rpc('admin_update_player', {
        p_player_id: playerId,
        p_patch: patch,
      });
      if (error) {
        logger.error('[PlayerRecord] save failed:', error);
        setPlayer(previous);
        toast(error.message || 'Save failed', 'warning');
      } else {
        toast('Saved', 'success');
      }
    },
    [player, playerId, toast]
  );

  const guardians = useMemo(
    () => (Array.isArray(player?.guardian_contacts) ? player.guardian_contacts : []),
    [player]
  );

  const saveGuardian = (index, field, value) => {
    const next = guardians.map((entry, i) => (i === index ? { ...entry, [field]: value } : entry));
    save({ guardian_contacts: next });
  };

  const addGuardian = () => {
    save({ guardian_contacts: [...guardians, {}] });
  };

  if (loading) return <LoadingScreen />;
  if (!player) {
    return (
      <Page>
        <div className="empty">Player not found</div>
      </Page>
    );
  }

  const name = `${player.first_name || ''} ${player.last_name || ''}`.trim() || 'Unnamed player';
  const team = teams.find((entry) => entry.id === player.team_id);
  const division = divisions.find((entry) => entry.id === player.division_id);
  const divisionLabel = division ? divisionDisplayName(division.name, genderModel) : null;
  const status = player.status || 'active';

  // Rosters are per-division: only offer teams from the player's division
  // (the admin RPC rejects cross-division assignments).
  const teamOptions = [
    { value: '', label: 'Unassigned' },
    ...teams
      .filter((entry) => entry.division_id === player.division_id)
      .map((entry) => ({ value: entry.id, label: entry.name })),
  ];
  const statusOptions = ['active', 'pending', 'inactive']
    .concat(isEnabled(FEATURE_FLAGS.WAITLIST) ? ['waitlist'] : [])
    .map((value) => ({ value, label: value[0].toUpperCase() + value.slice(1) }));

  const complianceItems = [
    ['Registration fee', 'paid'],
    ['Liability waiver', 'waiver_received'],
    ...(isEnabled(FEATURE_FLAGS.MEDICAL_FORMS) ? [['Medical form', 'medical_form_received']] : []),
  ];

  const tabs = [
    { id: 'overview', label: 'Overview' },
    { id: 'guardians', label: 'Guardians' },
    { id: 'schedule', label: 'Team & Schedule' },
    { id: 'compliance', label: 'Compliance' },
  ];

  return (
    <Page
      header={
        <div className="page-head" style={{ paddingBottom: 0 }}>
          <nav className="crumbs" aria-label="Breadcrumb">
            <Link to="/players">Players</Link>
            <ChevronRight size={12} aria-hidden="true" />
            <span style={{ color: 'var(--text-secondary)', fontWeight: 600 }}>{name}</span>
          </nav>
          <div
            className="record-hero"
            style={{ border: 'none', padding: '8px 0 0', background: 'transparent' }}
          >
            <Avatar name={name} />
            <div style={{ flex: 1, minWidth: 0, marginLeft: 4 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <h1 className="page-title">{name}</h1>
                <Badge tone={STATUS_TONE[status] || 'neutral'} dot>
                  {status}
                </Badge>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 6 }}>
                {divisionLabel && <Badge tone="info">{divisionLabel}</Badge>}
                {team ? (
                  <Link className="linklike" to={`/team/${team.id}`} style={{ fontSize: 13 }}>
                    <Shield size={13} style={{ verticalAlign: -2 }} aria-hidden="true" />{' '}
                    {team.name}
                  </Link>
                ) : (
                  <span className="muted" style={{ fontSize: 13 }}>
                    Unassigned
                  </span>
                )}
                <span className="muted">·</span>
                <span className="muted" style={{ fontSize: 13 }}>
                  #{player.jersey_number ?? '—'}
                </span>
              </div>
            </div>
            {team && (
              <Button variant="secondary" size="sm" onClick={() => navigate(`/team/${team.id}`)}>
                Open team
              </Button>
            )}
          </div>
          <Tabs tabs={tabs} activeTab={tab} onChange={setTab} label="Player record sections" />
        </div>
      }
    >
      <div style={{ maxWidth: 860 }}>
        {tab === 'overview' && (
          <div className="card">
            <div className="card-body">
              <div className="rf-grid">
                <InlineField
                  label="First name"
                  value={player.first_name}
                  onSave={(v) => save({ first_name: v })}
                />
                <InlineField
                  label="Last name"
                  value={player.last_name}
                  onSave={(v) => save({ last_name: v })}
                />
                <InlineField
                  label="Gender"
                  value={player.gender}
                  type="select"
                  options={[
                    { value: 'm', label: 'Male' },
                    { value: 'f', label: 'Female' },
                  ]}
                  onSave={(v) => save({ gender: v })}
                  render={(v) => (v === 'm' ? 'Male' : v === 'f' ? 'Female' : null)}
                />
                <InlineField label="Birth year" value={player.birth_year} editable={false} />
                <InlineField
                  label="Division"
                  value={divisionLabel}
                  editable={false}
                  render={() => (divisionLabel ? <Badge tone="info">{divisionLabel}</Badge> : null)}
                />
                <InlineField
                  label="Team"
                  value={player.team_id || ''}
                  type="select"
                  options={teamOptions}
                  onSave={(v) => save({ team_id: v || null })}
                  render={() => (team ? team.name : <span className="muted">Unassigned</span>)}
                />
                <InlineField
                  label="Jersey #"
                  value={player.jersey_number}
                  type="number"
                  onSave={(v) => save({ jersey_number: v })}
                />
                <InlineField
                  label="Status"
                  value={status}
                  type="select"
                  options={statusOptions}
                  onSave={(v) => save({ status: v })}
                  render={(v) => (
                    <Badge tone={STATUS_TONE[v] || 'neutral'} dot>
                      {v}
                    </Badge>
                  )}
                />
                {isEnabled(FEATURE_FLAGS.YEARS_PLAYED) && (
                  <InlineField
                    label="Years played"
                    value={player.years_played}
                    type="number"
                    onSave={(v) => save({ years_played: v })}
                  />
                )}
                {isEnabled(FEATURE_FLAGS.PLAYER_RATING) && (
                  <InlineField
                    label="Rating"
                    value={player.rating}
                    type="select"
                    options={[1, 2, 3, 4, 5].map((n) => ({
                      value: String(n),
                      label: '★'.repeat(n),
                    }))}
                    onSave={(v) => save({ rating: Number(v) })}
                    render={(v) => <Stars n={Number(v) || 0} />}
                  />
                )}
                {isEnabled(FEATURE_FLAGS.BUDDY_REQUESTS) && (
                  <InlineField
                    label="Buddy request"
                    value={player.buddy_request}
                    onSave={(v) => save({ buddy_request: v })}
                    placeholder="None"
                  />
                )}
                {isEnabled(FEATURE_FLAGS.COACHING_INTEREST) && (
                  <InlineField
                    label="Guardian will coach"
                    value={player.willing_to_coach ? 'true' : 'false'}
                    type="select"
                    options={[
                      { value: 'true', label: 'Yes' },
                      { value: 'false', label: 'No' },
                    ]}
                    onSave={(v) => save({ willing_to_coach: v === 'true' })}
                    render={() => (
                      <Badge tone={player.willing_to_coach ? 'success' : 'neutral'}>
                        {player.willing_to_coach ? 'Yes' : 'No'}
                      </Badge>
                    )}
                  />
                )}
              </div>
            </div>
          </div>
        )}

        {tab === 'guardians' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {guardians.length === 0 && (
              <div className="card">
                <div className="card-body muted">No guardians on file.</div>
              </div>
            )}
            {guardians.map((guardian, index) => (
              <div className="card" key={index}>
                <div className="card-head">
                  <h3>{index === 0 ? 'Primary guardian' : `Guardian ${index + 1}`}</h3>
                </div>
                <div className="card-body">
                  <div className="rf-grid">
                    <InlineField
                      label="Name"
                      value={guardian.name}
                      onSave={(v) => saveGuardian(index, 'name', v)}
                    />
                    <InlineField
                      label="Email"
                      value={guardian.email}
                      onSave={(v) => saveGuardian(index, 'email', v)}
                    />
                    <InlineField
                      label="Alternate email"
                      value={guardian.alternate_email}
                      onSave={(v) => saveGuardian(index, 'alternate_email', v)}
                      placeholder="None"
                    />
                    <InlineField
                      label="Phone"
                      value={guardian.phone}
                      onSave={(v) => saveGuardian(index, 'phone', v)}
                      placeholder="None"
                    />
                  </div>
                </div>
              </div>
            ))}
            <Button variant="secondary" size="sm" onClick={addGuardian}>
              Add guardian
            </Button>
          </div>
        )}

        {tab === 'schedule' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {team ? (
              <div className="card">
                <div
                  className="card-body"
                  style={{ display: 'flex', alignItems: 'center', gap: 12 }}
                >
                  <Shield size={18} style={{ color: 'var(--primary)' }} aria-hidden="true" />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 700, fontSize: 15 }}>{team.name}</div>
                    <div className="muted" style={{ fontSize: 12.5 }}>
                      {divisionLabel || 'No division'}
                    </div>
                  </div>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => navigate(`/team/${team.id}`)}
                  >
                    Open team
                  </Button>
                </div>
              </div>
            ) : (
              <div className="card">
                <div className="card-body">
                  <span className="muted">Not yet assigned to a team. </span>
                  <Link className="linklike" to="/teams/builder">
                    Open Team Builder
                  </Link>
                </div>
              </div>
            )}
            <div className="card">
              <div className="card-head">
                <Calendar size={17} aria-hidden="true" />
                <h3>Practices</h3>
              </div>
              <div className="card-body flush">
                {practicesFailed ? (
                  <div style={{ padding: 16 }} className="muted" role="alert">
                    Practices could not be loaded.
                  </div>
                ) : practices.length ? (
                  practices.map((assignment, index) => (
                    <div
                      key={assignment.id}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 12,
                        padding: '11px 16px',
                        borderBottom:
                          index < practices.length - 1 ? '1px solid var(--border-soft)' : 'none',
                      }}
                    >
                      <Clock size={15} className="muted" aria-hidden="true" />
                      <span style={{ fontWeight: 600 }}>{assignment.slot?.day_of_week}</span>
                      <span>
                        {assignment.slot?.start_time} – {assignment.slot?.end_time}
                      </span>
                    </div>
                  ))
                ) : (
                  <div style={{ padding: 16 }} className="muted">
                    No practices scheduled.
                  </div>
                )}
              </div>
            </div>
            <div className="card">
              <div className="card-head">
                <Flag size={17} aria-hidden="true" />
                <h3>Games</h3>
              </div>
              <div className="card-body flush">
                {games.length ? (
                  games.map((game, index) => (
                    <div
                      key={game.id}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 12,
                        padding: '11px 16px',
                        borderBottom:
                          index < games.length - 1 ? '1px solid var(--border-soft)' : 'none',
                      }}
                    >
                      <b style={{ width: 88 }}>
                        {game.start_time ? new Date(game.start_time).toLocaleDateString() : '—'}
                      </b>
                      <span>
                        {game.home_team?.name} <span className="muted">vs</span>{' '}
                        {game.away_team?.name}
                      </span>
                      {game.score_home != null && game.score_away != null && (
                        <span style={{ marginLeft: 'auto' }}>
                          <Badge>
                            {game.score_home}–{game.score_away}
                          </Badge>
                        </span>
                      )}
                    </div>
                  ))
                ) : (
                  <div style={{ padding: 16 }} className="muted">
                    No games scheduled.
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {tab === 'compliance' && (
          <div className="card">
            <div className="card-body flush">
              {complianceItems.map(([label, key], index) => (
                <div
                  key={key}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    padding: '15px 18px',
                    borderBottom:
                      index < complianceItems.length - 1 ? '1px solid var(--border-soft)' : 'none',
                  }}
                >
                  <span
                    className="kpi-ico"
                    style={{
                      width: 30,
                      height: 30,
                      background: player[key] ? 'var(--success-weak)' : 'var(--warning-weak)',
                      color: player[key] ? 'var(--success-text)' : 'var(--warning-text)',
                    }}
                  >
                    {player[key] ? (
                      <Check size={16} aria-hidden="true" />
                    ) : (
                      <Clock size={16} aria-hidden="true" />
                    )}
                  </span>
                  <span style={{ flex: 1, fontWeight: 600 }}>{label}</span>
                  <span className="muted" style={{ fontSize: 12.5 }}>
                    {player[key] ? 'Received' : 'Outstanding'}
                  </span>
                  <Toggle
                    checked={!!player[key]}
                    onChange={(v) => save({ [key]: v })}
                    label={label}
                  />
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </Page>
  );
}
