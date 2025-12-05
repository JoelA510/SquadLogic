import React from 'react';

import { PERSISTENCE_THEMES } from '../utils/themes.js';

const GRID_COLS = {
    1: 'grid-cols-1',
    2: 'grid-cols-2',
    3: 'grid-cols-3',
    4: 'grid-cols-4',
};

export default function PersistencePanel({
    title,
    stats = [], // Array of { label, value }
    onSync,
    status, // 'idle', 'syncing', 'success', 'error'
    message,
    colorTheme = 'blue', // 'blue' or 'green'
}) {
    const theme = PERSISTENCE_THEMES[colorTheme] || PERSISTENCE_THEMES.blue;
    const gridClass = GRID_COLS[stats.length] || 'grid-cols-1';

    return (
        <div className="glass-panel p-6 rounded-xl border border-white/10 relative overflow-hidden">
            <div className={`absolute inset-0 bg-gradient-to-br ${theme.gradientFrom} ${theme.gradientTo} pointer-events-none`} />

            <div className="relative z-10">
                <h2 className="text-xl font-bold text-white mb-4 flex items-center gap-2">
                    <span className={`w-2 h-2 rounded-full ${theme.dotColor} ${theme.shadowColor}`} />
                    {title}
                </h2>

                <div className={`grid ${gridClass} gap-4 mb-6`}>
                    {stats.length > 0 ? stats.map((stat, idx) => (
                        <div key={idx} className="bg-white/5 rounded-lg p-3 border border-white/5">
                            <div className="text-xs text-white/50 uppercase tracking-wider mb-1">{stat.label}</div>
                            <div className="text-2xl font-mono text-white">{stat.value}</div>
                        </div>
                    )) : (
                        <div className="col-span-full p-4 text-center text-white/30 italic border border-dashed border-white/10 rounded-lg">
                            No statistics available.
                        </div>
                    )}
                </div>

                <div className="flex items-center justify-between">
                    <div className="text-sm">
                        {status === 'error' && <span className="text-red-400">{message}</span>}
                        {status === 'success' && <span className="text-green-400">{message}</span>}
                        {status === 'syncing' && <span className={`${theme.statusText} animate-pulse`}>{message}</span>}
                        {status === 'idle' && <span className="text-white/50">Ready to sync</span>}
                    </div>

                    <button
                        onClick={onSync}
                        disabled={status === 'syncing'}
                        className={`
              px-4 py-2 rounded-lg font-medium transition-all duration-200
              ${status === 'syncing'
                                ? 'bg-white/10 text-white/50 cursor-not-allowed'
                                : `${theme.btnBg} text-white shadow-lg ${theme.btnShadow}`
                            }
            `}
                    >
                        {status === 'syncing' ? 'Syncing...' : 'Sync to Supabase'}
                    </button>
                </div>
            </div>
        </div>
    );
}
