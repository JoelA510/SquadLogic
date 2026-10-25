import React, { useRef, useState } from 'react';
import PropTypes from 'prop-types';
import {
  GripVertical,
  Link2,
  Minus,
  MoreHorizontal,
  Star,
  Users,
  UserRoundCheck,
} from 'lucide-react';
import Avatar from '../ui/Avatar.jsx';
import Dropdown from '../ui/Dropdown.jsx';
import { teamBalanceMetrics } from '@squadlogic/core/balanceSignals.js';

function PlayerChip({ player, signalKind, teams, onMove, currentTeamId }) {
  const [dragging, setDragging] = useState(false);
  const name = `${player.first_name || ''} ${player.last_name || ''}`.trim();
  const sigLabel = signalKind === 'years' ? `${player.years_played || 0}y` : null;

  const moveItems = [
    {
      id: 'pool',
      label: 'Unassigned pool',
      icon: Minus,
      checked: !currentTeamId,
      onSelect: () => onMove(player.id, null),
    },
    ...teams.map((team) => ({
      id: team.id,
      label: team.name,
      checked: currentTeamId === team.id,
      onSelect: () => onMove(player.id, team.id),
    })),
  ];

  return (
    <div
      className={`pchip ${dragging ? 'dragging' : ''}`}
      draggable
      onDragStart={(event) => {
        event.dataTransfer.setData('text/plain', player.id);
        event.dataTransfer.effectAllowed = 'move';
        setDragging(true);
      }}
      onDragEnd={() => setDragging(false)}
    >
      <span className="pchip-grip" title="Drag to move">
        <GripVertical size={13} aria-hidden="true" />
      </span>
      <Avatar name={name || '?'} size="sm" />
      <span className="pchip-name">{name}</span>
      {/* A coaching lead (Phase B6): a parent volunteers to coach. A mark, not a coach. */}
      {player.willing_to_coach && (
        <span className="pchip-sig" title="Coaching lead: a parent volunteers to coach">
          <UserRoundCheck size={13} aria-hidden="true" />
          Lead
        </span>
      )}
      {player.buddy_request && (
        <span className="pchip-ico" title={`Buddy: ${player.buddy_request}`}>
          <Link2 size={13} aria-hidden="true" />
        </span>
      )}
      {signalKind === 'rating' && (
        <span className="pchip-sig">
          <Star
            size={11}
            style={{ color: 'var(--accent-amber)', fill: 'currentColor' }}
            aria-hidden="true"
          />
          {player.rating ?? '–'}
        </span>
      )}
      {sigLabel && <span className="pchip-sig">{sigLabel}</span>}
      <Dropdown
        header="Move to"
        items={moveItems}
        renderTrigger={({ toggle, triggerProps }) => (
          <button
            type="button"
            className="row-act"
            style={{ width: 22, height: 22 }}
            aria-label={`Move ${name}`}
            onClick={toggle}
            {...triggerProps}
          >
            <MoreHorizontal size={14} aria-hidden="true" />
          </button>
        )}
      />
    </div>
  );
}

PlayerChip.propTypes = {
  player: PropTypes.object.isRequired,
  signalKind: PropTypes.string.isRequired,
  teams: PropTypes.array.isRequired,
  onMove: PropTypes.func.isRequired,
  currentTeamId: PropTypes.string,
};

function BalanceColumn({
  title,
  players,
  capacity = null,
  signalKind,
  teams,
  onMove,
  currentTeamId = null,
  isPool = false,
}) {
  const [over, setOver] = useState(false);
  const dragDepth = useRef(0);
  const metrics = teamBalanceMetrics(players);
  const overCap = capacity && players.length > capacity;

  return (
    <section
      className={`balance-col ${isPool ? 'pool' : ''} ${over ? 'drag-over' : ''}`}
      aria-label={title}
      onDragEnter={(event) => {
        event.preventDefault();
        dragDepth.current += 1;
        setOver(true);
      }}
      onDragLeave={() => {
        dragDepth.current -= 1;
        if (dragDepth.current <= 0) {
          dragDepth.current = 0;
          setOver(false);
        }
      }}
      onDragOver={(event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
      }}
      onDrop={(event) => {
        event.preventDefault();
        dragDepth.current = 0;
        setOver(false);
        const playerId = event.dataTransfer.getData('text/plain');
        if (playerId) onMove(playerId, currentTeamId);
      }}
    >
      <div className="bc-head">
        <div className="bc-title">
          {!isPool && <span className="team-dot" style={{ background: 'var(--primary)' }} />}
          {isPool && <Users size={15} className="muted" aria-hidden="true" />}
          <span
            style={{
              flex: 1,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {title}
          </span>
        </div>
        <div className="bc-metrics">
          <span className="bc-metric" style={overCap ? { color: 'var(--danger-text)' } : undefined}>
            {players.length}
            {capacity ? `/${capacity}` : ''}
          </span>
          {!isPool && signalKind === 'rating' && (
            <span className="bc-metric">★ {metrics.avgRating.toFixed(1)}</span>
          )}
          {!isPool && signalKind === 'years' && (
            <span className="bc-metric">{metrics.avgYears.toFixed(1)}y avg</span>
          )}
          {!isPool && (
            <span className="bc-metric">
              {metrics.boys}B·{metrics.girls}G
            </span>
          )}
        </div>
      </div>
      <div className="bc-body">
        {players.length === 0 && (
          <div className="muted" style={{ fontSize: 12, textAlign: 'center', padding: '12px 0' }}>
            {isPool ? 'All placed 🎉' : over ? 'Drop here' : 'Empty — drag players here'}
          </div>
        )}
        {players.map((player) => (
          <PlayerChip
            key={player.id}
            player={player}
            signalKind={signalKind}
            teams={teams}
            onMove={onMove}
            currentTeamId={currentTeamId}
          />
        ))}
      </div>
    </section>
  );
}

BalanceColumn.propTypes = {
  title: PropTypes.string.isRequired,
  players: PropTypes.array.isRequired,
  capacity: PropTypes.number,
  signalKind: PropTypes.string.isRequired,
  teams: PropTypes.array.isRequired,
  onMove: PropTypes.func.isRequired,
  currentTeamId: PropTypes.string,
  isPool: PropTypes.bool,
};

/**
 * The Team Builder board: an unassigned pool plus one droppable column per
 * team. Drag chips between columns or use each chip's "Move to" menu
 * (keyboard/screen-reader path). Pure presentation — `onMove` persists.
 */
export default function BalanceBoard({ pool, teams, playersByTeam, signalKind, onMove }) {
  return (
    <div className="balance-board" style={{ flex: 1, minHeight: 0 }}>
      <BalanceColumn
        title="Unassigned"
        players={pool}
        signalKind={signalKind}
        teams={teams}
        onMove={onMove}
        currentTeamId={null}
        isPool
      />
      {teams.map((team) => (
        <BalanceColumn
          key={team.id}
          title={team.name}
          capacity={team.max_roster_size || team.capacity || null}
          players={playersByTeam.get(team.id) || []}
          signalKind={signalKind}
          teams={teams}
          onMove={onMove}
          currentTeamId={team.id}
        />
      ))}
    </div>
  );
}

BalanceBoard.propTypes = {
  pool: PropTypes.array.isRequired,
  teams: PropTypes.array.isRequired,
  playersByTeam: PropTypes.instanceOf(Map).isRequired,
  signalKind: PropTypes.string.isRequired,
  onMove: PropTypes.func.isRequired,
};
