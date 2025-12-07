import React, { useState, useEffect } from 'react';
import Papa from 'papaparse';
import { UploadCloud, FileText, CheckCircle, AlertCircle, Bell } from 'lucide-react';
import { PERSISTENCE_THEMES } from '../utils/themes.js';
import { useImport } from '../contexts/ImportContext';
import Button from './ui/Button';
import ProgressBar from './ui/ProgressBar';

export default function ImportPanel({ onImport }) {
    const [isDragging, setIsDragging] = useState(false);
    const [file, setFile] = useState(null);
    const [error, setError] = useState(null);
    const [previewData, setPreviewData] = useState(null);
    const [importType, setImportType] = useState('players'); // players, coaches, fields

    const {
        isImporting,
        progress,
        importStatus,
        startImport,
        resetImport,
        notifyOnComplete,
        setNotifyOnComplete,
        importedPlayers,
        importedCoaches,
        importedFields
    } = useImport();

    const theme = PERSISTENCE_THEMES.green; // Use green theme for ingestion

    // Reset local state when import completes or is reset
    useEffect(() => {
        if (importStatus === 'idle' && !isImporting) {
            setFile(null);
            setPreviewData(null);
        }
    }, [importStatus, isImporting]);

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

    const handleStartImport = () => {
        if (file) {
            startImport(file, importType);
        }
    };

    const getImportedCount = (type) => {
        switch (type) {
            case 'players': return importedPlayers?.totalRows || 0;
            case 'coaches': return importedCoaches?.totalRows || 0;
            case 'fields': return importedFields?.totalRows || 0;
            default: return 0;
        }
    };

    // If import is in progress or completed, show status view
    if (isImporting || importStatus === 'completed') {
        return (
            <section className="glass-panel p-8 rounded-xl border border-border-subtle relative overflow-hidden mb-10">
                <div className={`absolute inset-0 bg-gradient-to-br ${theme.gradientFrom} ${theme.gradientTo} pointer-events-none opacity-50`} />

                <div className="relative z-10 flex flex-col items-center justify-center text-center py-8">
                    {importStatus === 'completed' ? (
                        <div className="mb-6 w-20 h-20 rounded-full bg-green-500/20 flex items-center justify-center animate-fadeIn">
                            <CheckCircle className="w-10 h-10 text-green-400" />
                        </div>
                    ) : (
                        <div className="mb-6 w-20 h-20 rounded-full bg-blue-500/20 flex items-center justify-center animate-pulse">
                            <UploadCloud className="w-10 h-10 text-blue-400" />
                        </div>
                    )}

                    <h2 className="text-3xl font-display font-bold text-text-primary mb-2">
                        {importStatus === 'completed' ? 'Import Complete!' : 'Importing Data...'}
                    </h2>

                    <p className="text-text-secondary mb-8 max-w-md">
                        {importStatus === 'completed'
                            ? `Successfully imported ${previewData?.totalRows || 0} ${importType}.`
                            : `Processing your ${importType} file. You can navigate away, the import will continue in the background.`
                        }
                    </p>

                    <div className="w-full max-w-lg mb-8">
                        <ProgressBar
                            progress={progress}
                            label={importStatus === 'completed' ? 'Done' : 'Processing...'}
                        />
                    </div>

                    {importStatus === 'completed' ? (
                        <div className="flex gap-4">
                            <Button
                                variant="secondary"
                                size="lg"
                                onClick={() => {
                                    if (onImport && previewData) {
                                        onImport(previewData, importType);
                                    }
                                    resetImport('all'); // Or just reset current type? For now reset UI state
                                    setFile(null);
                                    setPreviewData(null);
                                }}
                            >
                                Upload Another File
                            </Button>
                            <Button
                                variant="primary"
                                size="lg"
                                onClick={() => {
                                    if (onImport && previewData) {
                                        onImport(previewData, importType);
                                    }
                                    resetImport('all');
                                }}
                            >
                                Continue
                            </Button>
                        </div>
                    ) : (
                        <div className="flex items-center gap-3 bg-bg-surface px-4 py-2 rounded-lg border border-border-subtle">
                            <div className={`w-2 h-2 rounded-full ${notifyOnComplete ? 'bg-green-400 shadow-[0_0_8px_rgba(74,222,128,0.8)]' : 'bg-text-muted/20'}`} />
                            <label className="flex items-center gap-2 text-sm text-text-secondary cursor-pointer select-none">
                                <input
                                    type="checkbox"
                                    className="hidden"
                                    checked={notifyOnComplete}
                                    onChange={(e) => setNotifyOnComplete(e.target.checked)}
                                />
                                Email me when complete
                            </label>
                        </div>
                    )}
                </div>
            </section>
        );
    }

    return (
        <section className="glass-panel p-6 rounded-xl border border-border-subtle relative overflow-hidden mb-10">
            <div className={`absolute inset-0 bg-gradient-to-br ${theme.gradientFrom} ${theme.gradientTo} pointer-events-none`} />

            <div className="relative z-10">
                <div className="flex justify-between items-start mb-6">
                    <div>
                        <h2 className="text-2xl font-bold text-text-primary mb-2 flex items-center gap-2">
                            <span className={`w-2 h-2 rounded-full ${theme.dotColor} ${theme.shadowColor}`} />
                            Data Ingestion
                        </h2>
                        <p className="text-text-secondary max-w-prose leading-relaxed">
                            Import GotSport registration data to populate teams and players.
                        </p>
                    </div>
                    <div className="flex items-center gap-2">
                        <button
                            className={`p-2 rounded-lg transition-colors ${notifyOnComplete ? 'bg-blue-500/20 text-blue-400' : 'bg-bg-surface text-text-muted hover:text-text-primary'}`}
                            onClick={() => setNotifyOnComplete(!notifyOnComplete)}
                            title="Notify when complete"
                        >
                            <Bell size={20} />
                        </button>
                    </div>
                </div>

                {/* Type Selector */}
                <div className="flex gap-4 mb-8">
                    {['players', 'coaches', 'fields'].map((type) => (
                        <button
                            key={type}
                            onClick={() => {
                                setImportType(type);
                                setFile(null);
                                setPreviewData(null);
                                setError(null);
                            }}
                            className={`
                                flex-1 p-4 rounded-xl border transition-all duration-200 text-left relative overflow-hidden group
                                ${importType === type
                                    ? 'bg-blue-500/10 border-blue-500/50 shadow-[0_0_20px_rgba(56,189,248,0.1)]'
                                    : 'bg-bg-surface border-border-subtle hover:bg-bg-surface-hover hover:border-border-highlight'
                                }
                            `}
                        >
                            <div className="relative z-10">
                                <div className="flex justify-between items-center mb-1">
                                    <span className={`font-semibold capitalize ${importType === type ? 'text-blue-400' : 'text-text-primary'}`}>
                                        {type}
                                    </span>
                                    {getImportedCount(type) > 0 && (
                                        <span className="text-xs bg-green-500/20 text-green-400 px-2 py-0.5 rounded-full flex items-center gap-1">
                                            <CheckCircle size={10} />
                                            {getImportedCount(type)}
                                        </span>
                                    )}
                                </div>
                                <p className="text-xs text-text-muted">
                                    {type === 'players' && 'Upload player registration data'}
                                    {type === 'coaches' && 'Upload coach assignments'}
                                    {type === 'fields' && 'Upload field configurations'}
                                </p>
                            </div>
                        </button>
                    ))}
                </div>

                {!previewData ? (
                    <div
                        className={`border-2 border-dashed rounded-xl p-12 text-center transition-all duration-300 ${isDragging
                            ? 'border-blue-400 bg-blue-500/10 scale-[1.02]'
                            : 'border-border-subtle hover:border-border-highlight bg-bg-surface hover:bg-bg-surface-hover'
                            }`}
                        onDragOver={handleDragOver}
                        onDragLeave={handleDragLeave}
                        onDrop={handleDrop}
                    >
                        <div className="flex flex-col items-center gap-6 animate-fadeIn">
                            <div className={`p-6 rounded-full transition-colors duration-300 ${isDragging ? 'bg-blue-500/20' : 'bg-bg-surface'}`}>
                                <UploadCloud className={`w-12 h-12 transition-colors duration-300 ${isDragging ? 'text-blue-400' : 'text-text-muted'}`} />
                            </div>
                            <div>
                                <p className="text-xl font-medium text-text-primary mb-2">
                                    Drag and drop your CSV file here
                                </p>
                                <p className="text-sm text-text-secondary">
                                    or <label className="text-blue-400 hover:text-blue-300 cursor-pointer font-semibold hover:underline transition-colors">
                                        browse files
                                        <input type="file" className="hidden" accept=".csv" onChange={handleFileSelect} />
                                    </label>
                                </p>
                            </div>
                            {getImportedCount(importType) > 0 && (
                                <div className="bg-amber-500/10 border border-amber-500/20 text-amber-400 px-4 py-2 rounded-lg text-sm mt-2 flex items-center gap-2 max-w-md">
                                    <AlertCircle size={16} className="shrink-0" />
                                    <span>
                                        Warning: {importType} data already exists. Uploading a new file will overwrite existing data and any manual overrides.
                                    </span>
                                </div>
                            )}
                            {error && (
                                <div className="bg-red-500/10 border border-red-500/20 text-red-400 px-4 py-2 rounded-lg text-sm mt-2 animate-slideUp flex items-center gap-2">
                                    <AlertCircle size={16} />
                                    {error}
                                </div>
                            )}
                        </div>
                    </div>
                ) : (
                    <div className="bg-bg-surface border border-border-subtle rounded-lg overflow-hidden animate-fadeIn">
                        <div className="p-4 border-b border-border-subtle flex justify-between items-center bg-bg-surface">
                            <div className="flex items-center gap-3">
                                <div className="p-2 bg-blue-500/20 rounded-lg">
                                    <FileText className="text-blue-400" size={20} />
                                </div>
                                <div>
                                    <h3 className="text-lg font-semibold text-text-primary">{file.name}</h3>
                                    <p className="text-sm text-text-secondary">{previewData.totalRows} rows detected</p>
                                </div>
                            </div>
                            <div className="flex gap-3">
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => { setFile(null); setPreviewData(null); }}
                                >
                                    Cancel
                                </Button>
                                <Button
                                    variant="primary"
                                    size="sm"
                                    onClick={handleStartImport}
                                >
                                    Start Import
                                </Button>
                            </div>
                        </div>
                        <div className="overflow-x-auto">
                            <table className="w-full text-left text-sm text-text-secondary">
                                <thead className="bg-bg-surface text-xs uppercase font-semibold text-text-muted">
                                    <tr>
                                        {previewData.headers.slice(0, 5).map((header, i) => (
                                            <th key={i} className="px-4 py-3">{header}</th>
                                        ))}
                                        {previewData.headers.length > 5 && <th className="px-4 py-3">...</th>}
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-border-subtle">
                                    {previewData.rows.map((row, i) => (
                                        <tr key={i} className="hover:bg-bg-surface-hover transition-colors">
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
                        <div className="p-2 text-center text-xs text-text-muted bg-bg-surface border-t border-border-subtle">
                            Showing first 5 rows preview
                        </div>
                    </div>
                )}
            </div>
        </section >
    );
}
