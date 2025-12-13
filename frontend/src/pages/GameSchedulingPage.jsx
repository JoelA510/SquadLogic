import React from 'react';
import GameReadinessPanel from '../components/GameReadinessPanel.jsx';
import TeamScheduleView from '../components/TeamScheduleView.jsx';
import { useDashboardData } from '../hooks/useDashboardData.js';
import { useTheme } from '../contexts/ThemeContext.jsx';

export default function GameSchedulingPage() {
    const [selectedTeamId, setSelectedTeamId] = React.useState('');
    const { game, team } = useDashboardData();
    const { timezone } = useTheme();

    const teams = team.teams || [];

    return (
        <div className="animate-fadeIn space-y-8">
            <div className="mb-8">
                <h1 className="text-3xl font-display font-bold text-white mb-2">Game Scheduling</h1>
                <p className="text-white/60">Generate and review game schedules.</p>
            </div>

            <GameReadinessPanel
                gameReadinessSnapshot={game.snapshot}
                gameSummary={game.summary}
                generatedAt={game.generatedAt}
                timezone={timezone}
            />

            <div className="bg-bg-card border border-border-default rounded-lg p-6">
                <div className="flex justify-between items-center mb-4">
                    <h2 className="text-xl font-bold text-text-primary">Team Schedules</h2>
                    <select
                        className="bg-bg-input border border-border-default rounded px-3 py-1.5 text-text-primary"
                        value={selectedTeamId}
                        onChange={(e) => setSelectedTeamId(e.target.value)}
                    >
                        <option value="">Select a team...</option>
                        {teams.map(t => (
                            <option key={t.id} value={t.id}>{t.name} ({t.division})</option>
                        ))}
                    </select>
                </div>

                {selectedTeamId ? (
                    <TeamScheduleView
                        assignments={game.assignments}
                        teamId={selectedTeamId}
                        timezone={timezone}
                    />
                ) : (
                    <div className="text-center text-text-muted py-8 bg-bg-surface rounded border border-border-subtle border-dashed">
                        Select a team to view their schedule
                    </div>
                )}
            </div>
        </div>
    );
}
