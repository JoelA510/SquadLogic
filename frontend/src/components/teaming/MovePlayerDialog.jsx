import React, { useMemo, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import Modal from '../ui/Modal.jsx';
import Button from '../ui/Button.jsx';

/**
 * The non-drag way to move a player between teams (AGENTS.md section 9: every drag-and-drop has
 * an alternative). One dialog for the whole editor, not a menu per player: a league of 128
 * teams would put 128 options behind each of 1,259 players. Destination teams are grouped by
 * division in a native `select`, which a keyboard and a screen reader already operate (type to
 * jump to a team).
 *
 * The caller keys it by player, so each player starts with nothing chosen.
 *
 * @param {Object} props
 * @param {{ id: string|number, name: string } | null} props.player - null closes the dialog
 * @param {Array<{ id: string|number, name: string, division?: string, players: any[] }>} props.teams
 * @param {string|number|null} props.currentTeamId
 * @param {() => void} props.onClose
 * @param {(destTeamId: string|number) => void} props.onMove
 */
export default function MovePlayerDialog({ player, teams, currentTeamId, onClose, onMove }) {
  const [destination, setDestination] = useState('');
  const selectRef = useRef(null);

  const groups = useMemo(() => {
    const byDivision = new Map();
    for (const team of teams) {
      const division = team.division ? String(team.division) : 'No division';
      if (!byDivision.has(division)) byDivision.set(division, []);
      byDivision.get(division).push(team);
    }
    return [...byDivision.entries()];
  }, [teams]);

  const chosen = teams.find((team) => String(team.id) === destination);

  return (
    <Modal
      open={Boolean(player)}
      onClose={onClose}
      title={`Move ${player?.name ?? 'player'}`}
      initialFocusRef={selectRef}
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={!chosen}
            onClick={() => chosen && onMove(chosen.id)}
          >
            Move player
          </Button>
        </>
      }
    >
      <div className="field">
        <label htmlFor="roster-move-destination">Destination team</label>
        <select
          id="roster-move-destination"
          ref={selectRef}
          className="select"
          value={destination}
          onChange={(event) => setDestination(event.target.value)}
        >
          <option value="">Choose a team</option>
          {groups.map(([division, divisionTeams]) => (
            <optgroup key={division} label={division}>
              {divisionTeams.map((team) => (
                <option
                  key={team.id}
                  value={String(team.id)}
                  disabled={String(team.id) === String(currentTeamId)}
                >
                  {`${team.name} (${team.players.length} ${team.players.length === 1 ? 'player' : 'players'})${
                    String(team.id) === String(currentTeamId) ? ', current team' : ''
                  }`}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </div>
    </Modal>
  );
}

MovePlayerDialog.propTypes = {
  player: PropTypes.shape({
    id: PropTypes.oneOfType([PropTypes.string, PropTypes.number]).isRequired,
    name: PropTypes.string,
  }),
  teams: PropTypes.arrayOf(PropTypes.object).isRequired,
  currentTeamId: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
  onClose: PropTypes.func.isRequired,
  onMove: PropTypes.func.isRequired,
};
