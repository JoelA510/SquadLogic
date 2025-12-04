import React, { useState } from 'react';
import { preparePracticePersistenceSnapshot } from '../../../src/practicePersistenceSnapshot';
import { persistTeamSnapshot } from '../utils/teamPersistenceClient'; // We can reuse the client for now if we make the URL configurable, or create a new one.
// Actually, let's create a local helper or reuse the pattern.
// For simplicity, I'll inline the fetch call or assume a generic 'persistSnapshot' client exists.
// Checking teamPersistenceClient.js might be good, but I'll write a generic fetcher here for now.

const PERSISTENCE_URL = import.meta.env.VITE_SUPABASE_PERSISTENCE_URL
    ? `${import.meta.env.VITE_SUPABASE_PERSISTENCE_URL}/practice-persistence`
    : 'http://localhost:54321/functions/v1/practice-persistence';

export default function PracticePersistencePanel({
    assignments = [],
    slots = [],
    overrides = [],
    runMetadata = {},
    runId,
}) {
    const [status, setStatus] = useState('idle'); // idle, syncing, success, error
    const [message, setMessage] = useState('');

    const snapshot = preparePracticePersistenceSnapshot({
        assignments,
        slots,
        practiceOverrides: overrides,
        runId,
        runMetadata,
    });

    const handleSync = async () => {
        setStatus('syncing');
        setMessage('Syncing to Supabase...');

        try {
            // TODO: Add Auth header once we have the session
            const response = await fetch(PERSISTENCE_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    // 'Authorization': `Bearer ${session.access_token}`
                },
                body: JSON.stringify({
                    snapshot,
                    overrides, // Pass raw overrides if needed by backend, though snapshot has them normalized
                    runMetadata,
                }),
            });

            const result = await response.json();

            if (!response.ok) {
                throw new Error(result.message || 'Failed to sync');
            }

            setStatus('success');
            setMessage(`Success! Persisted ${result.data?.assignmentsPersisted ?? 0} assignments.`);
        } catch (err) {
            console.error('Persistence error:', err);
            setStatus('error');
            setMessage(err.message);
        }
    };

    return (
        <div className="glass-panel p-6 rounded-xl border border-white/10 relative overflow-hidden">
            <div className="absolute inset-0 bg-gradient-to-br from-blue-500/5 to-purple-500/5 pointer-events-none" />

            <div className="relative z-10">
                <h2 className="text-xl font-bold text-white mb-4 flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-blue-400 shadow-[0_0_10px_rgba(96,165,250,0.5)]" />
                    Practice Persistence
                </h2>

                <div className="grid grid-cols-2 gap-4 mb-6">
                    <div className="bg-white/5 rounded-lg p-3 border border-white/5">
                        <div className="text-xs text-white/50 uppercase tracking-wider mb-1">Assignments</div>
                        <div className="text-2xl font-mono text-white">{snapshot.preparedAssignmentRows}</div>
                    </div>
                    <div className="bg-white/5 rounded-lg p-3 border border-white/5">
                        <div className="text-xs text-white/50 uppercase tracking-wider mb-1">Overrides</div>
                        <div className="text-2xl font-mono text-white">{snapshot.manualOverrides.length}</div>
                    </div>
                </div>

                <div className="flex items-center justify-between">
                    <div className="text-sm">
                        {status === 'error' && <span className="text-red-400">{message}</span>}
                        {status === 'success' && <span className="text-green-400">{message}</span>}
                        {status === 'syncing' && <span className="text-blue-400 animate-pulse">{message}</span>}
                        {status === 'idle' && <span className="text-white/50">Ready to sync</span>}
                    </div>

                    <button
                        onClick={handleSync}
                        disabled={status === 'syncing'}
                        className={`
              px-4 py-2 rounded-lg font-medium transition-all duration-200
              ${status === 'syncing'
                                ? 'bg-white/10 text-white/50 cursor-not-allowed'
                                : 'bg-blue-500 hover:bg-blue-400 text-white shadow-lg shadow-blue-500/20'
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
