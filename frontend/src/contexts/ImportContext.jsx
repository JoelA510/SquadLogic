import React, { createContext, useContext, useState, useEffect } from 'react';
import { supabase } from '../utils/supabaseClient';
import Papa from 'papaparse';

const ImportContext = createContext();

export function useImport() {
    return useContext(ImportContext);
}

export function ImportProvider({ children }) {
    const [isImporting, setIsImporting] = useState(false);
    const [progress, setProgress] = useState(0);
    const [importStatus, setImportStatus] = useState(() => {
        return localStorage.getItem('importStatus') || 'idle';
    }); // idle, importing, completed, error
    const [importLogs, setImportLogs] = useState([]);
    const [notifyOnComplete, setNotifyOnComplete] = useState(false);

    // Multi-type state
    const [importedPlayers, setImportedPlayers] = useState(null);
    const [importedCoaches, setImportedCoaches] = useState(null);
    const [importedFields, setImportedFields] = useState(null);
    const [importedData, setImportedData] = useState(null); // Legacy/General

    // Load initial state from Supabase
    useEffect(() => {
        const loadFromSupabase = async () => {
            try {
                const { data: { user } } = await supabase.auth.getUser();
                if (!user) return;

                const { data, error } = await supabase
                    .from('imports')
                    .select('*')
                    .eq('user_id', user.id)
                    .order('created_at', { ascending: false });

                if (error) throw error;

                if (data) {
                    // Map latest imports to state
                    const latestPlayers = data.find(i => i.import_type === 'players');
                    const latestCoaches = data.find(i => i.import_type === 'coaches');
                    const latestFields = data.find(i => i.import_type === 'fields');

                    if (latestPlayers) setImportedPlayers(latestPlayers.data);
                    if (latestCoaches) setImportedCoaches(latestCoaches.data);
                    if (latestFields) setImportedFields(latestFields.data);

                    // Legacy support: set importedData to players if available
                    if (latestPlayers) setImportedData(latestPlayers.data);
                }
            } catch (e) {
                console.error('Failed to load imports from Supabase:', e);
            }
        };

        loadFromSupabase();
    }, []);

    // Helper for safe storage
    const saveToStorage = (key, value) => {
        try {
            localStorage.setItem(key, JSON.stringify(value));
        } catch (e) {
            if (e.name === 'QuotaExceededError' || e.code === 22) {
                console.warn(`Storage quota exceeded for ${key}. Persistence disabled for this item.`);
                addLog(`Warning: Data too large to save locally. It will be lost on refresh.`);
            } else {
                console.error(`Failed to save ${key} to localStorage`, e);
            }
        }
    };

    const startImport = async (file, type = 'players') => {
        setIsImporting(true);
        setImportStatus('importing');
        setProgress(0);
        setImportLogs([]);
        addLog(`Starting import for ${type} from ${file.name}...`);

        try {
            // 1. Parse CSV client-side
            addLog('Parsing CSV data...');
            Papa.parse(file, {
                header: true,
                skipEmptyLines: true,
                complete: async (results) => {
                    const { data } = results;
                    addLog(`Parsed ${data.length} rows.`);

                    const importData = {
                        fileName: file.name,
                        totalRows: data.length,
                        timestamp: new Date(),
                        data: data
                    };

                    // 2. Save to Supabase DB
                    addLog('Saving to database...');
                    const { data: { user } } = await supabase.auth.getUser();

                    if (user) {
                        const { error: insertError } = await supabase
                            .from('imports')
                            .insert({
                                user_id: user.id,
                                file_name: file.name,
                                import_type: type,
                                data: importData
                            });

                        if (insertError) throw insertError;
                        addLog('Saved to database successfully.');
                    } else {
                        addLog('Warning: User not authenticated, data will not be saved to DB.');
                    }

                    // Update local state
                    if (type === 'players') setImportedPlayers(importData);
                    if (type === 'coaches') setImportedCoaches(importData);
                    if (type === 'fields') setImportedFields(importData);
                    setImportedData(importData); // Legacy

                    completeImport(type);
                },
                error: (err) => {
                    addLog(`Error parsing CSV: ${err.message}`);
                    setImportStatus('error');
                    setIsImporting(false);
                }
            });

        } catch (err) {
            console.error('Import error:', err);
            addLog(`Import failed: ${err.message}`);
            setImportStatus('error');
            setIsImporting(false);
        }
    };

    const completeImport = (type) => {
        setIsImporting(false);
        setImportStatus('completed');
        localStorage.setItem('importStatus', 'completed'); // Keep status in local storage for UI flow
        addLog(`Import for ${type} completed successfully.`);

        if (notifyOnComplete) {
            // Simulate email notification
            console.log('Sending email notification...');
            addLog('Email notification sent.');
        }
    };

    const addLog = (message) => {
        setImportLogs(prev => [...prev, { timestamp: new Date(), message }]);
    };

    const resetImport = async (type = 'all') => {
        if (type === 'all') {
            setIsImporting(false);
            setImportStatus('idle');
            localStorage.removeItem('importStatus');
            setImportLogs([]);
            setImportedData(null);
            setImportedPlayers(null);
            setImportedCoaches(null);
            setImportedFields(null);

            // Optional: Delete from DB? For now, just clearing local state is safer/simpler for "reset"
            // If we wanted to delete, we'd need the ID.
        } else {
            // Reset specific type
            if (type === 'players') setImportedPlayers(null);
            if (type === 'coaches') setImportedCoaches(null);
            if (type === 'fields') setImportedFields(null);
        }
    };

    const value = {
        isImporting,
        progress,
        importStatus,
        importLogs,
        notifyOnComplete,
        setNotifyOnComplete,
        startImport,
        resetImport,
        importedData,
        setImportedData,
        importedPlayers,
        setImportedPlayers,
        importedCoaches,
        setImportedCoaches,
        importedFields,
        setImportedFields
    };

    return (
        <ImportContext.Provider value={value}>
            {children}
        </ImportContext.Provider>
    );
}
