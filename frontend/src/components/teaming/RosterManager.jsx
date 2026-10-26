import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DndContext,
  DragOverlay,
  closestCorners,
  KeyboardSensor,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, ShieldAlert, ArrowRight, ArrowRightLeft } from 'lucide-react';
import Badge from '../ui/Badge.jsx';
import Button from '../ui/Button.jsx';
import MovePlayerDialog from './MovePlayerDialog.jsx';
import { useConflicts } from '../../hooks/useConflicts.js';
import { coachLabel } from '../../utils/teamCoaches.js';
import { findTeamOfPlayer, movePlayerToTeam, reorderWithinTeam } from '../../utils/rosterMoves.js';

const playerNameOf = (player) =>
  player.name || `${player.first_name || ''} ${player.last_name || ''}`.trim() || 'Unknown Player';

/**
 * One player's row: the full name and skill (they wrap, never clip), the marks, a drag handle
 * and a Move button. The handle is its own button, so the row holds no nested control and a
 * keyboard reaches both: Space on the handle lifts the player, and Move opens the dialog that
 * is the non-drag way to do the same (AGENTS.md section 9).
 *
 * @param {{ player: any, onRequestMove?: (player: any) => void }} props
 */
const PlayerCard = ({ player, onRequestMove }) => {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: player.id,
    data: player,
  });

  // A dynamic drag offset: the one inline style the row carries.
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  const playerName = playerNameOf(player);
  const playerSkill = player.skill || player.skillRating || player.skill_tier || 'Unrated';

  return (
    <li
      ref={setNodeRef}
      style={style}
      data-testid={`player-card-${player.id}`}
      aria-label={`${playerName}, Skill: ${playerSkill}${player.assignment_source === 'manual' ? ', manually assigned' : ''}${player.isCoachingLead ? ', coaching lead' : ''}${player.eligibilityNotChecked ? ', eligibility not checked' : ''}`}
      className={`roster-row${isDragging ? ' dragging' : ''}`}
    >
      <button
        type="button"
        ref={setActivatorNodeRef}
        className="roster-handle"
        aria-label={`Drag ${playerName}`}
        {...attributes}
        {...listeners}
      >
        <GripVertical size={16} aria-hidden="true" />
      </button>
      <div className="roster-who">
        <span className="roster-name">{playerName}</span>
        <span className="roster-detail">
          <span>Skill: {playerSkill}</span>
          {player.assignment_source === 'manual' && <Badge tone="warning">manual</Badge>}
          {/* Phase B6: a parent volunteers to coach. A mark only: a lead is not a coach. */}
          {player.isCoachingLead && (
            <Badge tone="neutral" title="Coaching lead: a parent volunteers to coach">
              lead
            </Badge>
          )}
          {/* Phase B3: placed with no age to check; a flag, never a hold. */}
          {player.eligibilityNotChecked && <Badge tone="warning">eligibility not checked</Badge>}
        </span>
      </div>
      {onRequestMove && (
        <Button
          variant="secondary"
          size="sm"
          icon={ArrowRightLeft}
          data-roster-move={player.id}
          aria-label={`Move ${playerName} to another team`}
          onClick={() => onRequestMove(player)}
        >
          Move
        </Button>
      )}
    </li>
  );
};

// Governance: Memoize individual player rows to prevent unnecessary re-renders during drag transitions
export const SortablePlayer = React.memo(PlayerCard);

/**
 * One team's card. It grows with its roster (no scroll box of its own: a nested scroller is
 * what clipped the old cards), and takes the width the grid gives it.
 *
 * @param {{ team: any, players: any[], onRequestMove?: (player: any) => void }} props
 */
export function TeamColumn({ team, players, onRequestMove }) {
  // 8.2: every coach, none of them labelled head — from the one producer the
  // override picker uses, reconciled once per team rather than on every render.
  const coachText = useMemo(() => coachLabel(team, 'Coach: Vacant'), [team]);

  // The whole list is the drop target, so a team with no players can still be dropped on.
  const { setNodeRef, isOver } = useDroppable({
    id: team.id,
    data: { type: 'Column', team },
  });

  const headingId = `roster-team-${team.id}`;
  const over = players.length > 14;

  return (
    <section
      className={`card roster-card${isOver ? ' drop-target' : ''}`}
      data-testid={`team-column-${team.id}`}
      aria-labelledby={headingId}
    >
      <header className="roster-card-head">
        <div className="roster-card-title-row">
          <h3 id={headingId} className="roster-card-title">
            {team.name}
          </h3>
          <Badge tone={over ? 'warning' : 'info'}>
            {players.length} {players.length === 1 ? 'Player' : 'Players'}
          </Badge>
        </div>
        {team.division && <p className="roster-card-meta">{team.division}</p>}
        <p className="roster-card-meta">{coachText}</p>
        <a href={`/team/${team.id}`} className="text-link roster-card-link">
          View team portal <ArrowRight size={12} aria-hidden="true" />
        </a>
      </header>

      <ul ref={setNodeRef} className="roster-list" aria-labelledby={headingId}>
        <SortableContext items={players.map((p) => p.id)} strategy={verticalListSortingStrategy}>
          {players.map((player) => (
            <SortablePlayer key={player.id} player={player} onRequestMove={onRequestMove} />
          ))}
        </SortableContext>
        {players.length === 0 && (
          <li className="roster-empty">No players yet. Drop a player here, or use Move.</li>
        )}
      </ul>
    </section>
  );
}

const ALL_DIVISIONS = '';

export default function RosterManager({ initialTeams, onTeamsChange }) {
  const [teams, setTeams] = useState(initialTeams);
  const [syncedFrom, setSyncedFrom] = useState(initialTeams);
  const [activePlayer, setActivePlayer] = useState(null);
  const [announcement, setAnnouncement] = useState('');
  const [moving, setMoving] = useState(null);
  const [division, setDivision] = useState(ALL_DIVISIONS);
  const focusAfterMove = useRef(null);
  const { conflicts, hasConflicts } = useConflicts(teams);

  // CRITICAL FIX: Sync state when async mock data finishes loading (adjusted while rendering,
  // the pattern React documents for state that follows a prop).
  if (initialTeams !== syncedFrom) {
    setSyncedFrom(initialTeams);
    setTeams(initialTeams);
  }

  const commitTeams = (next) => {
    if (next === teams) return;
    setTeams(next);
    onTeamsChange?.(next);
  };

  // After a keyboard move the player's row is on another card: put focus on its Move button, so
  // the keyboard user keeps their place instead of landing on the page.
  useEffect(() => {
    const id = focusAfterMove.current;
    if (id === null) return;
    focusAfterMove.current = null;
    const buttons = document.querySelectorAll('[data-roster-move]');
    for (const button of buttons) {
      if (button instanceof HTMLElement && button.dataset.rosterMove === String(id)) {
        button.focus();
        break;
      }
    }
  }, [teams]);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 5,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const divisions = useMemo(
    () => [
      ...new Set(
        teams
          .map((team) => team.division)
          .filter(Boolean)
          .map(String)
      ),
    ],
    [teams]
  );
  const shownTeams = useMemo(
    () =>
      division === ALL_DIVISIONS
        ? teams
        : teams.filter((team) => String(team.division) === division),
    [teams, division]
  );

  const requestMove = useCallback((player) => setMoving(player), []);

  const handleMove = (destTeamId) => {
    const current = teams;
    const player = moving;
    const source = player ? findTeamOfPlayer(current, player.id) : null;
    const dest = current.find((team) => team.id === destTeamId);
    setMoving(null);
    if (!player || !source || !dest) return;
    focusAfterMove.current = player.id;
    commitTeams(movePlayerToTeam(current, player.id, destTeamId));
    // A destination the division filter hides would unmount the player's row with nothing to
    // take focus (WCAG 2.4.3): show the destination's division, so the row is there to focus.
    const destDivision = dest.division ? String(dest.division) : ALL_DIVISIONS;
    const filterChanged = division !== ALL_DIVISIONS && division !== destDivision;
    if (filterChanged) setDivision(destDivision);
    setAnnouncement(
      `Moved ${playerNameOf(player)} from ${source.name} to ${dest.name}` +
        (filterChanged
          ? destDivision === ALL_DIVISIONS
            ? '. Showing all divisions.'
            : `. Now showing ${destDivision}.`
          : '')
    );
  };

  const handleDragStart = (event) => {
    const team = findTeamOfPlayer(teams, event.active.id);
    if (team) setActivePlayer(team.players.find((p) => p.id === event.active.id));
  };

  const handleDragOver = (event) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const current = teams;
    const sourceTeam = findTeamOfPlayer(current, active.id);
    const destTeam = findTeamOfPlayer(current, over.id) || current.find((t) => t.id === over.id);
    if (!sourceTeam || !destTeam || sourceTeam.id === destTeam.id) return;

    const overIndex = destTeam.players.findIndex((p) => p.id === over.id);
    commitTeams(
      movePlayerToTeam(current, active.id, destTeam.id, overIndex < 0 ? undefined : overIndex)
    );
  };

  const handleDragEnd = (event) => {
    const { active, over } = event;
    const player = activePlayer;
    setActivePlayer(null);
    if (!over) return;

    const current = teams;
    const team = findTeamOfPlayer(current, active.id);
    if (!team) return;
    const name = player ? playerNameOf(player) : 'player';
    const overTeam = findTeamOfPlayer(current, over.id) || current.find((t) => t.id === over.id);
    if (overTeam && overTeam.id === team.id && active.id !== over.id) {
      const from = team.players.findIndex((p) => p.id === active.id);
      const to = team.players.findIndex((p) => p.id === over.id);
      if (to >= 0) {
        commitTeams(reorderWithinTeam(current, team.id, from, to));
        setAnnouncement(`Moved ${name} within ${team.name}`);
        return;
      }
    }
    // The player now sits on the team the drag ended over (handleDragOver moved them there).
    if (player && team.players.some((p) => p.id === active.id)) {
      setAnnouncement(`${name} is on ${team.name}`);
    }
  };

  const movingTeam = moving ? findTeamOfPlayer(teams, moving.id) : null;

  return (
    <div className="w-full">
      {hasConflicts && (
        <section
          aria-label="Roster conflicts"
          className="bg-status-error-bg text-text-primary p-4 border border-status-error rounded-xl mb-6 flex flex-col gap-2 shadow-md"
        >
          <div className="flex items-center gap-2 font-bold uppercase tracking-widest text-status-error">
            <ShieldAlert size={20} aria-hidden="true" />
            Conflict Detected
          </div>
          <ul className="flex flex-col gap-2" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {conflicts.map((c, i) => (
              <li
                key={i}
                className="text-sm bg-bg-glass p-3 rounded-lg border border-status-error/30 flex flex-wrap items-center justify-between gap-2"
              >
                <span className="text-text-secondary">{c.message}</span>
                <Badge tone={c.severity === 'error' ? 'danger' : 'warning'}>{c.type}</Badge>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>

      {divisions.length > 1 && (
        <div className="field roster-filter">
          <label htmlFor="roster-division-filter">Show division</label>
          <select
            id="roster-division-filter"
            className="select"
            value={division}
            onChange={(event) => setDivision(event.target.value)}
          >
            <option value={ALL_DIVISIONS}>{`All divisions (${teams.length} teams)`}</option>
            {divisions.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </div>
      )}

      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        accessibility={{
          screenReaderInstructions: {
            draggable:
              'Press space to lift a player. Use arrow keys to move, enter to drop, escape to cancel. Or use the Move button to choose a team.',
          },
        }}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
      >
        <div className="roster-grid">
          {shownTeams.map((team) => (
            <TeamColumn
              key={team.id}
              team={team}
              players={team.players}
              onRequestMove={requestMove}
            />
          ))}
        </div>

        <DragOverlay>
          {activePlayer ? (
            <div className="roster-row roster-overlay">
              <span className="roster-handle" aria-hidden="true">
                <GripVertical size={16} />
              </span>
              <div className="roster-who">
                <span className="roster-name">{playerNameOf(activePlayer)}</span>
                <span className="roster-detail">Moving player...</span>
              </div>
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>

      <MovePlayerDialog
        key={moving ? String(moving.id) : 'closed'}
        player={moving ? { id: moving.id, name: playerNameOf(moving) } : null}
        teams={teams}
        currentTeamId={movingTeam?.id ?? null}
        onClose={() => setMoving(null)}
        onMove={handleMove}
      />
    </div>
  );
}
