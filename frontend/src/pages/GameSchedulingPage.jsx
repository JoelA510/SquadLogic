import React from 'react';
import GameReadinessPanel from '../components/GameReadinessPanel';
import { useDashboardData } from '../hooks/useDashboardData.js';
import { useTheme } from '../contexts/ThemeContext.jsx';

export default function GameSchedulingPage() {
    const { game } = useDashboardData();
    const { timezone } = useTheme();

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
        </div>
    );
}
