import React, { useState } from 'react';
import Papa from 'papaparse';
import { PERSISTENCE_THEMES } from '../utils/themes.js';

export default function ImportPanel({ onImport }) {
    const [isDragging, setIsDragging] = useState(false);
    const [file, setFile] = useState(null);
    const [error, setError] = useState(null);
    const [previewData, setPreviewData] = useState(null);

    const theme = PERSISTENCE_THEMES.green; // Use green theme for ingestion

    const handleDragOver = (e) => {
        e.preventDefault();
        setIsDragging(true);
    };

    const handleDragLeave = () => {
        setIsDragging(false);
    };

    const handleDrop = (e) => {
        e.preventDefault();
        setIsDragging(false);
        const droppedFile = e.dataTransfer.files[0];
        validateAndReadFile(droppedFile);
    };

    const handleFileSelect = (e) => {
        const selectedFile = e.target.files[0];
        validateAndReadFile(selectedFile);
    };

    const validateAndReadFile = (file) => {
        if (!file) return;
        if (file.type !== 'text/csv' && !file.name.endsWith('.csv')) {
            setError('Please upload a valid CSV file.');
            return;
        }

        setFile(file);
        setError(null);
        parseCSV(file);
    };

    const parseCSV = (file) => {
        Papa.parse(file, {
            header: true,
            skipEmptyLines: true,
            complete: (results) => {
                const { data, meta } = results;
                if (!data || data.length === 0) {
                    setError('CSV file appears to be empty or invalid.');
                    return;
                }

                // Headers are in meta.fields
                const headers = meta.fields || [];
                // Preview the first 5 rows
                const previewRows = data.slice(0, 5);

                setPreviewData({
                    headers,
                    rows: previewRows,
                    totalRows: data.length,
                    fullData: data
                });
            },
            error: (err) => {
                setError(`Error parsing CSV: ${err.message}`);
            }
        });
    };

    const handleImport = () => {
        if (onImport && previewData) {
            onImport(previewData);
            setFile(null);
            setPreviewData(null);
        }
    };

    return (
        <section className="glass-panel p-6 rounded-xl border border-white/10 relative overflow-hidden mb-10">
            <div className={`absolute inset-0 bg-gradient-to-br ${theme.gradientFrom} ${theme.gradientTo} pointer-events-none`} />

            <div className="relative z-10">
                <h2 className="text-2xl font-bold text-white mb-2 flex items-center gap-2">
                    <span className={`w-2 h-2 rounded-full ${theme.dotColor} ${theme.shadowColor}`} />
                    Data Ingestion
                </h2>
                <p className="text-white/70 max-w-prose leading-relaxed mb-6">
                    Import GotSport registration data to populate teams and players.
                </p>

                {!previewData ? (
                    <div
                        className={`border-2 border-dashed rounded-xl p-8 text-center transition-colors ${isDragging
                            ? 'border-green-400 bg-green-400/10'
                            : 'border-white/20 hover:border-white/40 bg-white/5'
                            }`}
                        onDragOver={handleDragOver}
                        onDragLeave={handleDragLeave}
                        onDrop={handleDrop}
                    >
                        <div className="flex flex-col items-center gap-4">
                            <div className="p-4 rounded-full bg-white/10">
                                <svg className="w-8 h-8 text-white/70" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                                </svg>
                            </div>
                            <div>
                                <p className="text-lg font-medium text-white">
                                    Drag and drop your CSV file here
                                </p>
                                <p className="text-sm text-white/50 mt-1">
                                    or <label className="text-green-400 hover:text-green-300 cursor-pointer underline">
                                        browse files
                                        <input type="file" className="hidden" accept=".csv" onChange={handleFileSelect} />
                                    </label>
                                </p>
                            </div>
                            {error && (
                                <p className="text-red-400 text-sm mt-2">{error}</p>
                            )}
                        </div>
                    </div>
                ) : (
                    <div className="bg-white/5 border border-white/10 rounded-lg overflow-hidden">
                        <div className="p-4 border-b border-white/10 flex justify-between items-center">
                            <div>
                                <h3 className="text-lg font-semibold text-white">{file.name}</h3>
                                <p className="text-sm text-white/50">{previewData.totalRows} rows detected</p>
                            </div>
                            <div className="flex gap-2">
                                <button
                                    onClick={() => { setFile(null); setPreviewData(null); }}
                                    className="px-4 py-2 text-sm text-white/70 hover:text-white hover:bg-white/10 rounded-lg transition-colors"
                                >
                                    Cancel
                                </button>
                                <button
                                    onClick={handleImport}
                                    className="px-4 py-2 text-sm bg-green-500 hover:bg-green-600 text-white font-medium rounded-lg shadow-lg transition-colors"
                                >
                                    Import Data
                                </button>
                            </div>
                        </div>
                        <div className="overflow-x-auto">
                            <table className="w-full text-left text-sm text-white/70">
                                <thead className="bg-white/5 text-xs uppercase font-semibold text-white/50">
                                    <tr>
                                        {previewData.headers.slice(0, 5).map((header, i) => (
                                            <th key={i} className="px-4 py-3">{header}</th>
                                        ))}
                                        {previewData.headers.length > 5 && <th className="px-4 py-3">...</th>}
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-white/5">
                                    {previewData.rows.map((row, i) => (
                                        <tr key={i} className="hover:bg-white/5">
                                            {previewData.headers.slice(0, 5).map((header, j) => (
                                                <td key={j} className="px-4 py-3 whitespace-nowrap">
                                                    {row[header]}
                                                </td>
                                            ))}
                                            {previewData.headers.length > 5 && <td className="px-4 py-3">...</td>}
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                        <div className="p-2 text-center text-xs text-white/30 bg-white/5">
                            Showing first 5 rows
                        </div>
                    </div>
                )}
            </div>
        </section>
    );
}
