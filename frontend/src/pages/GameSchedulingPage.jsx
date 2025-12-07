import React from 'react';
import GameReadinessPanel from '../components/GameReadinessPanel';
import { useDashboardData } from '../hooks/useDashboardData';

export default function GameSchedulingPage() {
    const { game } = useDashboardData();

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
            />
        </div>
    );
}
