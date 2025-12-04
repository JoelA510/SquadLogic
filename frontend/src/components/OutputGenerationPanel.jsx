import React, { useState } from 'react';
import { generateScheduleExports } from '../../../src/outputGeneration';
import { uploadScheduleExport } from '../../../src/storageSupabase';

// Placeholder for Supabase client injection or context
// In a real app, use a hook like useSupabaseClient()
// For now, we'll assume a prop or global client, or just simulate the upload if no client.
const MOCK_UPLOAD = !import.meta.env.VITE_SUPABASE_URL;

export default function OutputGenerationPanel({
    teams = [],
    practiceAssignments = [],
    gameAssignments = [],
    supabaseClient, // Pass this in from App or Context
}) {
    const [generated, setGenerated] = useState(null);
    const [status, setStatus] = useState('idle'); // idle, generating, uploading, success, error
    const [message, setMessage] = useState('');

    const handleGenerate = () => {
        try {
            setStatus('generating');
            setMessage('Generating CSVs...');

            // Small timeout to allow UI to update before heavy sync work
            // TODO: If schedule sizes grow significantly, move generateScheduleExports
            // into a Web Worker to avoid blocking the main thread.
            setTimeout(() => {
                const exports = generateScheduleExports({
                    teams,
                    practiceAssignments,
                    gameAssignments,
                });
                setGenerated(exports);
                setStatus('idle');
                setMessage('CSVs generated successfully.');
            }, 50);
        } catch (err) {
            console.error('Generation error:', err);
            setStatus('error');
            setMessage(`Generation failed: ${err.message}`);
        }
    };

    const handleUpload = async () => {
        if (!generated) return;
        if (!supabaseClient && !MOCK_UPLOAD) {
            setStatus('error');
            setMessage('Supabase client not available for upload.');
            return;
        }

        setStatus('uploading');
        setMessage('Uploading to Storage...');

        try {
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const uploads = [];

            // Upload Master
            uploads.push(
                uploadFile(
                    supabaseClient,
                    `master-schedule-${timestamp}.csv`,
                    generated.master.csv
                )
            );

            // Upload Per-Team (limit to first 5 for demo/speed if needed, or all)
            // Uploading all might be slow in browser. Let's do all for correctness.
            for (const teamExport of generated.perTeam) {
                uploads.push(
                    uploadFile(
                        supabaseClient,
                        `teams/${teamExport.teamId}-${timestamp}.csv`,
                        teamExport.csv
                    )
                );
            }

            await Promise.all(uploads);

            setStatus('success');
            setMessage(`Uploaded ${uploads.length} files to 'exports' bucket.`);
        } catch (err) {
            console.error('Upload error:', err);
            setStatus('error');
            setMessage(`Upload failed: ${err.message}`);
        }
    };

    const uploadFile = async (client, path, content) => {
        if (MOCK_UPLOAD) {
            console.log(`[Mock Upload] ${path} (${content.length} bytes)`);
            return Promise.resolve({ path });
        }
        return uploadScheduleExport({
            supabaseClient: client,
            bucket: 'exports',
            path,
            file: content,
        });
    };

    const downloadCsv = (filename, content) => {
        const blob = new Blob([content], { type: 'text/csv' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    };

    return (
        <div className="glass-panel p-6 rounded-xl border border-white/10 relative overflow-hidden">
            <div className="absolute inset-0 bg-gradient-to-br from-orange-500/5 to-red-500/5 pointer-events-none" />

            <div className="relative z-10">
                <h2 className="text-xl font-bold text-white mb-4 flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-orange-400 shadow-[0_0_10px_rgba(251,146,60,0.5)]" />
                    Output Generation
                </h2>

                <div className="flex flex-col gap-4">
                    <div className="flex gap-4">
                        <button
                            onClick={handleGenerate}
                            disabled={status === 'generating' || status === 'uploading'}
                            className="bg-white/10 hover:bg-white/20 text-white px-4 py-2 rounded-lg transition-colors"
                        >
                            {status === 'generating' ? 'Generating...' : 'Generate CSVs'}
                        </button>

                        {generated && (
                            <button
                                onClick={handleUpload}
                                disabled={status === 'uploading'}
                                className="bg-orange-500 hover:bg-orange-400 text-white px-4 py-2 rounded-lg shadow-lg shadow-orange-500/20 transition-all"
                            >
                                {status === 'uploading' ? 'Uploading...' : 'Upload to Storage'}
                            </button>
                        )}
                    </div>

                    {generated && (
                        <div className="bg-white/5 rounded-lg p-4 border border-white/5 mt-2">
                            <div className="flex justify-between items-center mb-2">
                                <h3 className="text-sm font-medium text-white">Generated Files</h3>
                                <button
                                    onClick={() => downloadCsv('master-schedule.csv', generated.master.csv)}
                                    className="text-xs text-blue-400 hover:text-blue-300"
                                >
                                    Download Master CSV
                                </button>
                            </div>
                            <div className="text-xs text-white/50 font-mono">
                                <div>Master Schedule: {generated.master.rows.length} rows</div>
                                <div>Team Schedules: {generated.perTeam.length} files</div>
                            </div>
                        </div>
                    )}

                    <div className="text-sm min-h-[20px]">
                        {status === 'error' && <span className="text-red-400">{message}</span>}
                        {status === 'success' && <span className="text-green-400">{message}</span>}
                        {(status === 'generating' || status === 'uploading') && <span className="text-orange-400 animate-pulse">{message}</span>}
                    </div>
                </div>
            </div>
        </div>
    );
}
