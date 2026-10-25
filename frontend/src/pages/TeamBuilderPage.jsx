import React, { useEffect, useMemo, useState } from 'react';
import { History, Link2, RefreshCw, Star, Target, Users, Zap } from 'lucide-react';
import Page from '../components/chrome/Page.jsx';
import PageHeader from '../components/chrome/PageHeader.jsx';
import BalanceBoard from '../components/teaming/BalanceBoard.jsx';
import Button from '../components/ui/Button.jsx';
import Toggle from '../components/ui/Toggle.jsx';
import { useToast } from '../components/ui/ToastHost.jsx';
import { mapInChunks } from '../utils/asyncChunks.js';
import { supabase } from '../lib/supabaseClient.js';
import { useOrganization } from '../contexts/OrganizationContext.jsx';
import { usePlayersData } from '../hooks/usePlayersData.js';
import { useFeatures } from '../hooks/useFeatures.js';
import { FEATURE_FLAGS } from '../constants/featureFlags.js';
import { divisionFilters } from '../utils/divisions.js';
import {
  balanceSignalKind,
  buddyStats,
  serpentineAssign,
} from '@squadlogic/core/balanceSignals.js';
import { logger } from '../lib/logger.js';
import LoadingScreen from '../components/LoadingScreen.jsx';

/**
 * Team Builder — drag-and-drop roster balancing per division. Auto-balance
 * runs the serpentine signal balancer (buddy + coach-parent aware); every
 * placement (manual or auto) persists through the audited
 * admin_update_player RPC with optimistic UI.
 */
export default function TeamBuilderPage() {
  const { currentOrganization } = useOrganization();
  const { players, divisions, loading, updatePlayer } = usePlayersData();
  const { features, isEnabled, genderModel, buddyRule } = useFeatures();
  const toast = useToast();

  const [teams, setTeams] = useState([]);
  const [teamsLoading, setTeamsLoading] = useState(true);
  const [divisionKey, setDivisionKey] = useState(null);
  const [respectBuddies, setRespectBuddies] = useState(true);
  const [respectCoach, setRespectCoach] = useState(true);
  const [working, setWorking] = useState(false);

  const orgId = currentOrganization?.id;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!orgId) return;
      setTeamsLoading(true);
      try {
        const { data, error } = await supabase
          .from('teams')
          .select('*')
          .eq('organization_id', orgId);
        if (!cancelled && !error) setTeams(data || []);
      } catch (err) {
        logger.error('[TeamBuilder] teams load failed:', err);
      } finally {
        if (!cancelled) setTeamsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [orgId]);

  const filters = useMemo(() => divisionFilters(divisions, genderModel), [divisions, genderModel]);

  // Default to the first division that actually has teams.
  const activeKey = useMemo(() => {
    if (divisionKey) return divisionKey;
    const withTeams = filters.find((filter) =>
      teams.some((team) => filter.divisionIds.includes(team.division_id))
    );
    return (withTeams || filters[0])?.key || null;
  }, [divisionKey, filters, teams]);

  const active = filters.find((filter) => filter.key === activeKey) || null;
  const activeIds = useMemo(() => new Set(active?.divisionIds || []), [active]);

  const signalKind = balanceSignalKind(features);

  const divisionTeams = useMemo(
    () => teams.filter((team) => activeIds.has(team.division_id)),
    [teams, activeIds]
  );
  const divisionPlayers = useMemo(
    () =>
      players.filter((player) => activeIds.has(player.division_id) && player.status !== 'waitlist'),
    [players, activeIds]
  );
  const divisionTeamIds = useMemo(
    () => new Set(divisionTeams.map((team) => team.id)),
    [divisionTeams]
  );
  const pool = divisionPlayers.filter(
    (player) => !player.team_id || !divisionTeamIds.has(player.team_id)
  );
  const playersByTeam = useMemo(() => {
    const map = new Map();
    divisionTeams.forEach((team) => map.set(team.id, []));
    divisionPlayers.forEach((player) => {
      if (map.has(player.team_id)) map.get(player.team_id).push(player);
    });
    return map;
  }, [divisionTeams, divisionPlayers]);

  // Buddies are matched as Team Analysis matches them (Phase B5): the resolver, the
  // league's buddy rule, and every player as the roster, so a request or code naming someone
  // off this board is not paired. A player's division is its division id, as the program is
  // in Team Analysis, so a board that folds two divisions (co-ed) pairs nobody across them.
  // With Buddy Requests off, nothing is matched (the tile and the toggle are hidden).
  const buddyRequestsOn = isEnabled(FEATURE_FLAGS.BUDDY_REQUESTS);
  const buddyRoster = useMemo(
    () => players.map((player) => ({ ...player, division: String(player.division_id ?? '') })),
    [players]
  );
  const buddyBoard = useMemo(() => {
    const ids = new Set(divisionPlayers.map((player) => player.id));
    return buddyRoster.filter((player) => ids.has(player.id));
  }, [buddyRoster, divisionPlayers]);
  const buddies = useMemo(
    () =>
      buddyRequestsOn
        ? buddyStats(buddyBoard, { roster: buddyRoster, buddyRule })
        : { requested: 0, satisfied: 0 },
    [buddyRequestsOn, buddyBoard, buddyRoster, buddyRule]
  );

  const handleMove = async (playerId, teamId) => {
    const result = await updatePlayer(playerId, { team_id: teamId });
    if (!result.success) toast(result.error || 'Move failed', 'warning');
  };

  const runAutoBalance = async () => {
    if (divisionTeams.length === 0) {
      toast('No teams in this division yet — generate teams first', 'warning');
      return;
    }
    setWorking(true);
    try {
      const assignments = serpentineAssign({
        players: buddyBoard,
        teams: divisionTeams,
        signalKind,
        respectBuddies: respectBuddies && buddyRequestsOn,
        respectCoach: respectCoach && isEnabled(FEATURE_FLAGS.COACHING_INTEREST),
        roster: buddyRoster,
        buddyRule,
      });
      // The bulk RPC disallows team_id, so each placement is a per-player
      // audited update; run them in bounded-concurrency chunks.
      const moves = assignments.filter(({ playerId, teamId }) => {
        const current = divisionPlayers.find((player) => player.id === playerId);
        return current?.team_id !== teamId;
      });
      await mapInChunks(moves, async ({ playerId, teamId }) => {
        const result = await updatePlayer(playerId, { team_id: teamId });
        if (!result.success) throw new Error(result.error || 'assignment failed');
      });
      await supabase.rpc('record_audit_event', {
        p_organization_id: orgId,
        p_action: 'teams.auto_balanced',
        p_metadata: {
          division: active?.label,
          players: assignments.length,
          teams: divisionTeams.length,
          signal: signalKind,
        },
      });
      toast(
        `Balanced ${assignments.length} players across ${divisionTeams.length} teams`,
        'success'
      );
    } catch (err) {
      logger.error('[TeamBuilder] auto-balance failed:', err);
      toast(err.message || 'Auto-balance failed', 'warning');
    } finally {
      setWorking(false);
    }
  };

  const clearDivision = async () => {
    setWorking(true);
    try {
      const assigned = divisionPlayers.filter((player) => player.team_id);
      await mapInChunks(assigned, async (player) => {
        const result = await updatePlayer(player.id, { team_id: null });
        if (!result.success) throw new Error(result.error || 'clear failed');
      });
      toast('Cleared division — all players returned to pool', 'success');
    } catch (err) {
      logger.error('[TeamBuilder] clear division failed:', err);
      toast(err.message || 'Clear division failed — some players may still be assigned', 'warning');
    } finally {
      setWorking(false);
    }
  };

  if (loading || teamsLoading) return <LoadingScreen />;

  const signalLabel =
    signalKind === 'rating'
      ? 'player rating'
      : signalKind === 'years'
        ? 'years played'
        : 'roster size only';
  const SignalIcon = signalKind === 'rating' ? Star : signalKind === 'years' ? History : Users;

  return (
    <Page
      header={
        <PageHeader
          title="Team Builder"
          subtitle="Auto-balance rosters, then fine-tune by hand — drag players between teams or use a chip's menu."
          icon={
            <span className="page-obj-icon" style={{ background: 'var(--primary)' }}>
              <Target size={20} aria-hidden="true" />
            </span>
          }
          actions={
            <>
              <Button
                variant="secondary"
                size="sm"
                icon={RefreshCw}
                disabled={working}
                onClick={clearDivision}
              >
                Clear division
              </Button>
              <Button
                variant="primary"
                size="sm"
                icon={Zap}
                loading={working}
                onClick={runAutoBalance}
              >
                Auto-balance
              </Button>
            </>
          }
        />
      }
    >
      <div
        style={{ display: 'flex', flexDirection: 'column', minHeight: 0, gap: 14, height: '100%' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <select
            className="select"
            style={{ width: 160, height: 32 }}
            aria-label="Division"
            value={activeKey || ''}
            onChange={(event) => setDivisionKey(event.target.value)}
          >
            {filters.map((filter) => (
              <option key={filter.key} value={filter.key}>
                {filter.label}
              </option>
            ))}
          </select>
          <div
            style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12.5 }}
            className="secondary"
          >
            <SignalIcon size={15} className="muted" aria-hidden="true" />
            Balancing by <b style={{ color: 'var(--text-primary)' }}>{signalLabel}</b>
          </div>
          <div style={{ flex: 1 }} />
          {isEnabled(FEATURE_FLAGS.BUDDY_REQUESTS) && (
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 7,
                fontSize: 12.5,
                fontWeight: 600,
              }}
            >
              <Toggle
                checked={respectBuddies}
                onChange={setRespectBuddies}
                label="Keep buddies together"
              />
              Keep buddies together
            </label>
          )}
          {isEnabled(FEATURE_FLAGS.COACHING_INTEREST) && (
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 7,
                fontSize: 12.5,
                fontWeight: 600,
              }}
            >
              <Toggle
                checked={respectCoach}
                onChange={setRespectCoach}
                label="Spread coach parents"
              />
              Spread coach parents
            </label>
          )}
        </div>

        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <div className="metric-tile" style={{ padding: '8px 14px' }}>
            <span className="tnum" style={{ fontWeight: 800, fontSize: 16 }}>
              {divisionPlayers.length}
            </span>{' '}
            <span className="muted" style={{ fontSize: 12 }}>
              players
            </span>
          </div>
          <div className="metric-tile" style={{ padding: '8px 14px' }}>
            <span className="tnum" style={{ fontWeight: 800, fontSize: 16 }}>
              {divisionTeams.length}
            </span>{' '}
            <span className="muted" style={{ fontSize: 12 }}>
              teams
            </span>
          </div>
          <div
            className="metric-tile"
            style={{
              padding: '8px 14px',
              borderColor: pool.length ? 'var(--warning)' : 'var(--border)',
            }}
          >
            <span
              className="tnum"
              style={{
                fontWeight: 800,
                fontSize: 16,
                color: pool.length ? 'var(--warning-text)' : 'inherit',
              }}
            >
              {pool.length}
            </span>{' '}
            <span className="muted" style={{ fontSize: 12 }}>
              unassigned
            </span>
          </div>
          {isEnabled(FEATURE_FLAGS.BUDDY_REQUESTS) && (
            <div className="metric-tile" style={{ padding: '8px 14px' }}>
              <Link2
                size={13}
                style={{ verticalAlign: -1, color: 'var(--accent-teal)' }}
                aria-hidden="true"
              />{' '}
              <span className="tnum" style={{ fontWeight: 800, fontSize: 16 }}>
                {buddies.satisfied}/{buddies.requested}
              </span>{' '}
              <span className="muted" style={{ fontSize: 12 }}>
                buddies met
              </span>
            </div>
          )}
        </div>

        <BalanceBoard
          pool={pool}
          teams={divisionTeams}
          playersByTeam={playersByTeam}
          signalKind={signalKind}
          onMove={handleMove}
        />
      </div>
    </Page>
  );
}
