import React, { useState, useMemo } from 'react';
import { runScheduleEvaluations } from '../../../src/evaluationPipeline';
import { persistEvaluation } from '../../../src/evaluationPersistence';

export default function EvaluationPanel({
    practiceData,
    gameData,
    supabaseClient,
}) {
    const [persisting, setPersisting] = useState(false);
    const [message, setMessage] = useState('');

    // Run evaluation on-the-fly when inputs change
    const evaluation = useMemo(() => {
        try {
            return runScheduleEvaluations({
                practice: practiceData,
                games: gameData,
            });
        } catch (err) {
            console.error('Evaluation failed:', err);
            return null;
        }
    }, [practiceData, gameData]);

    const handleSave = async () => {
        if (!evaluation) return;
        if (!supabaseClient) {
            setMessage('Supabase client not available.');
            return;
        }

        setPersisting(true);
        setMessage('Saving snapshot...');

        try {
            await persistEvaluation({
                supabaseClient,
                evaluationResult: evaluation,
                createdBy: 'admin-ui', // Replace with real user ID if available
            });
            setMessage('Evaluation snapshot saved.');
            setTimeout(() => setMessage(''), 3000);
        } catch (err) {
            console.error('Persistence error:', err);
            setMessage(`Save failed: ${err.message}`);
        } finally {
            setPersisting(false);
        }
    };

    if (!evaluation) {
        return null;
    }

    const statusColor = {
        'ok': 'bg-green-500',
        'attention-needed': 'bg-yellow-500',
        'action-required': 'bg-red-500',
    }[evaluation.status] || 'bg-gray-500';

    const statusLabel = {
        'ok': 'Ready',
        'attention-needed': 'Warnings',
        'action-required': 'Errors',
    }[evaluation.status] || 'Unknown';

    return (
        <div className="glass-panel p-6 rounded-xl border border-white/10 relative overflow-hidden">
            <div className="absolute inset-0 bg-gradient-to-br from-indigo-500/5 to-blue-500/5 pointer-events-none" />

            <div className="relative z-10 flex items-center justify-between">
                <div>
                    <h2 className="text-xl font-bold text-white flex items-center gap-2">
                        <span className={`w-2 h-2 rounded-full ${statusColor} shadow-[0_0_10px_currentColor]`} />
                        Evaluation Pipeline
                    </h2>
                    <div className="text-sm text-white/50 mt-1">
                        Status: <span className="text-white font-medium">{statusLabel}</span> · {evaluation.issues.length} issues found
                    </div>
                </div>

                <div className="flex items-center gap-4">
                    {message && <span className="text-sm text-white/70 animate-fade-in">{message}</span>}

                    <button
                        onClick={handleSave}
                        disabled={persisting}
                        className="bg-indigo-500 hover:bg-indigo-400 text-white px-4 py-2 rounded-lg shadow-lg shadow-indigo-500/20 transition-all disabled:opacity-50"
                    >
                        {persisting ? 'Saving...' : 'Save Snapshot'}
                    </button>
                </div>
            </div>

            {evaluation.issues.length > 0 && (
                <div className="mt-4 space-y-2 max-h-40 overflow-y-auto pr-2 custom-scrollbar">
                    {evaluation.issues.map((issue, idx) => (
                        <div key={idx} className={`text-xs p-2 rounded border ${issue.severity === 'error'
                                ? 'bg-red-500/10 border-red-500/20 text-red-200'
                                : 'bg-yellow-500/10 border-yellow-500/20 text-yellow-200'
                            }`}>
                            <span className="font-bold uppercase tracking-wider opacity-70 mr-2">{issue.category}</span>
                            {issue.message}
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
