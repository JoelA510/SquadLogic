import React, { useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { preparePracticePersistenceSnapshot } from '../../../src/practicePersistenceSnapshot';
import { PRACTICE_PERSISTENCE_URL } from '../config';
import PersistencePanel from './PersistencePanel';

export default function PracticePersistencePanel({
    assignments = [],
    slots = [],
    overrides = [],
    runMetadata = {},
    runId,
}) {
    const { session } = useAuth();
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
            const token = session?.access_token;
            const authHeaders = token ? { Authorization: `Bearer ${token}` } : {};

            const response = await fetch(PRACTICE_PERSISTENCE_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...authHeaders,
                },
                body: JSON.stringify({
                    snapshot,
                    overrides,
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
        <PersistencePanel
            title="Practice Persistence"
            colorTheme="blue"
            stats={[
                { label: 'Assignments', value: snapshot.preparedAssignmentRows },
                { label: 'Overrides', value: snapshot.manualOverrides.length },
            ]}
            onSync={handleSync}
            status={status}
            message={message}
        />
    );
}
