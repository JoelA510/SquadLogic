import React from 'react';

export default function PersistencePanel({
    title,
    stats = [], // Array of { label, value }
    onSync,
    status, // 'idle', 'syncing', 'success', 'error'
    message,
    colorTheme = 'blue', // 'blue' or 'green'
}) {
    const isGreen = colorTheme === 'green';
    const colorClass = isGreen ? 'green' : 'blue';
    const gradientFrom = isGreen ? 'from-green-500/5' : 'from-blue-500/5';
    const gradientTo = isGreen ? 'to-emerald-500/5' : 'to-purple-500/5';
    const dotColor = isGreen ? 'bg-green-400' : 'bg-blue-400';
    const shadowColor = isGreen ? 'shadow-[0_0_10px_rgba(74,222,128,0.5)]' : 'shadow-[0_0_10px_rgba(96,165,250,0.5)]';
    const btnBg = isGreen ? 'bg-green-500 hover:bg-green-400' : 'bg-blue-500 hover:bg-blue-400';
    const btnShadow = isGreen ? 'shadow-green-500/20' : 'shadow-blue-500/20';
    const statusText = isGreen ? 'text-green-400' : 'text-blue-400';

    return (
        <div className="glass-panel p-6 rounded-xl border border-white/10 relative overflow-hidden">
            <div className={`absolute inset-0 bg-gradient-to-br ${gradientFrom} ${gradientTo} pointer-events-none`} />

            <div className="relative z-10">
                <h2 className="text-xl font-bold text-white mb-4 flex items-center gap-2">
                    <span className={`w-2 h-2 rounded-full ${dotColor} ${shadowColor}`} />
                    {title}
                </h2>

                <div className={`grid grid-cols-${stats.length} gap-4 mb-6`}>
                    {stats.map((stat, idx) => (
                        <div key={idx} className="bg-white/5 rounded-lg p-3 border border-white/5">
                            <div className="text-xs text-white/50 uppercase tracking-wider mb-1">{stat.label}</div>
                            <div className="text-2xl font-mono text-white">{stat.value}</div>
                        </div>
                    ))}
                </div>

                <div className="flex items-center justify-between">
                    <div className="text-sm">
                        {status === 'error' && <span className="text-red-400">{message}</span>}
                        {status === 'success' && <span className="text-green-400">{message}</span>}
                        {status === 'syncing' && <span className={`${statusText} animate-pulse`}>{message}</span>}
                        {status === 'idle' && <span className="text-white/50">Ready to sync</span>}
                    </div>

                    <button
                        onClick={onSync}
                        disabled={status === 'syncing'}
                        className={`
              px-4 py-2 rounded-lg font-medium transition-all duration-200
              ${status === 'syncing'
                                ? 'bg-white/10 text-white/50 cursor-not-allowed'
                                : `${btnBg} text-white shadow-lg ${btnShadow}`
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
