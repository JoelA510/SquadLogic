import React, { useState } from 'react';
import PropTypes from 'prop-types';
import { useAuth } from '../contexts/AuthContext.jsx';
import { prepareGamePersistenceSnapshot } from '@squadlogic/core/gamePersistenceSnapshot.js';
import { GAME_PERSISTENCE_URL } from '../config.js';
import PersistencePanel from './PersistencePanel.jsx';

export default function GamePersistencePanel({
    assignments = [],
    runMetadata = {},
    runId,
}) {
    const { session } = useAuth();
    const [status, setStatus] = useState('idle'); // idle, syncing, success, error
    const [message, setMessage] = useState('');

    const snapshot = prepareGamePersistenceSnapshot({
        assignments,
        runId,
        runMetadata,
    });

    const handleSync = async () => {
        setStatus('syncing');
        setMessage('Syncing to Supabase...');

        try {
            const token = session?.access_token;
            if (!token) {
                throw new Error('Authentication required');
            }
            const authHeaders = { Authorization: `Bearer ${token}` };

            const response = await fetch(GAME_PERSISTENCE_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...authHeaders,
                },
                body: JSON.stringify({
                    snapshot,
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
            title="Game Persistence"
            colorTheme="green"
            stats={[
                { label: 'Assignments', value: snapshot.preparedAssignmentRows },
            ]}
            onSync={handleSync}
            status={status}
            message={message}
        />
    );
}

GamePersistencePanel.propTypes = {
    assignments: PropTypes.array,
    runMetadata: PropTypes.object,
    runId: PropTypes.string,
};
