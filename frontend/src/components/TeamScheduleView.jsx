import React from 'react';
import PropTypes from 'prop-types';
import { formatTime, formatDate } from '../utils/formatters.js';

export default function TeamScheduleView({ assignments, teamId, timezone }) {
    if (!assignments || !teamId) {
        return (
            <div className="text-text-muted p-4 text-center">
                Select a team to view schedule.
            </div>
        );
    }

    // Assignments structure: { slotId, start, end, homeTeamId, awayTeamId, fieldId }
    const teamGames = assignments.filter(
        game => game.homeTeamId === teamId || game.awayTeamId === teamId
    ).sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());

    if (teamGames.length === 0) {
        return (
            <div className="text-text-muted p-4 text-center">
                No games scheduled for this team.
            </div>
        );
    }

    return (
        <div className="space-y-3">
            {teamGames.map((game, index) => {
                const isHome = game.homeTeamId === teamId;
                const opponent = isHome ? game.awayTeamId : game.homeTeamId;
                const date = new Date(game.start);

                // Format date as "Sat, Oct 14"
                const dateStr = formatDate(game.start, timezone);

                return (
                    <div
                        key={`${game.slotId}-${index}`}
                        className="flex justify-between items-center p-3 bg-bg-surface border border-border-subtle rounded-md hover:border-border-default transition-colors"
                    >
                        <div>
                            <div className="font-medium text-text-primary">
                                <span className={isHome ? "text-brand-400" : "text-text-secondary"}>
                                    {isHome ? 'Vs' : '@'}
                                </span> {opponent}
                            </div>
                            <div className="text-xs text-text-secondary mt-0.5">
                                {dateStr} • {formatTime(game.start, timezone)}
                            </div>
                        </div>
                        <div className="text-xs font-mono text-text-muted bg-bg-base px-2 py-1 rounded">
                            Field {game.fieldId}
                        </div>
                    </div>
                );
            })}
        </div>
    );
}

TeamScheduleView.propTypes = {
    assignments: PropTypes.arrayOf(PropTypes.shape({
        slotId: PropTypes.string,
        start: PropTypes.string,
        homeTeamId: PropTypes.string,
        awayTeamId: PropTypes.string,
        fieldId: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
    })),
    teamId: PropTypes.string,
    timezone: PropTypes.string
};
