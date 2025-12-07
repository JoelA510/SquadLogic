import { useState, useEffect, useMemo } from 'react';
import { useImport } from '../contexts/ImportContext';

export function useTeamAnalysis() {
    const { importedPlayers } = useImport();
    const [programs, setPrograms] = useState([]);
    const [validationErrors, setValidationErrors] = useState([]);
    const [configs, setConfigs] = useState({}); // { programId: { targetTeamSize: 10, ... } }
    const [selectedProgramId, setSelectedProgramId] = useState(null);

    // Process imported data into programs
    useEffect(() => {
        if (!importedPlayers?.data) return;

        const processed = processPrograms(importedPlayers.data);
        setPrograms(processed.programs);
        setValidationErrors(processed.errors);

        // Initialize configs
        const initialConfigs = {};
        processed.programs.forEach(p => {
            initialConfigs[p.id] = {
                targetTeamSize: 12, // Default
                minRosterSize: 10,
                maxRosterSize: 14,
                teamCountOverride: null
            };
        });
        setConfigs(initialConfigs);
    }, [importedPlayers]);

    const processPrograms = (players) => {
        const programMap = {};
        const errors = [];

        players.forEach(player => {
            // Basic validation
            if (!player['Birthdate'] || !player['Gender']) {
                errors.push({
                    type: 'missing_info',
                    message: `Player ${player['First Name']} ${player['Last Name']} missing DOB or Gender`,
                    player
                });
                return;
            }

            // Determine Program (Age Group + Gender)
            // Logic: Calculate Age based on Season (assuming 2025 for now, should be dynamic)
            const dob = new Date(player['Birthdate']);
            const age = 2025 - dob.getFullYear();
            const gender = player['Gender'] === 'm' ? 'Boys' : 'Girls';

            // Simple U-grouping logic (e.g., U10 = ages 8-9)
            // This is a simplification, real logic might be more complex
            let uGroup = 'U' + (Math.ceil(age / 2) * 2);
            if (age < 4) uGroup = 'U4';

            const programName = `${uGroup} ${gender}`;
            const programId = programName.replace(/\s+/g, '_').toLowerCase();

            if (!programMap[programId]) {
                programMap[programId] = {
                    id: programId,
                    name: programName,
                    gender,
                    ageGroup: uGroup,
                    players: []
                };
            }

            programMap[programId].players.push(player);

            // Validation: Age Mismatch (Example)
            // if (age > 10 && uGroup === 'U10') ...
        });

        return {
            programs: Object.values(programMap).sort((a, b) => a.name.localeCompare(b.name)),
            errors
        };
    };

    const updateConfig = (programId, newConfig) => {
        setConfigs(prev => ({
            ...prev,
            [programId]: { ...prev[programId], ...newConfig }
        }));
    };

    const stats = useMemo(() => {
        return programs.map(p => {
            const config = configs[p.id] || {};
            const playerCount = p.players.length;
            const targetSize = config.targetTeamSize || 12;
            const estimatedTeams = config.teamCountOverride || Math.ceil(playerCount / targetSize);

            return {
                ...p,
                playerCount,
                estimatedTeams,
                avgRosterSize: (playerCount / estimatedTeams).toFixed(1)
            };
        });
    }, [programs, configs]);

    return {
        programs: stats,
        validationErrors,
        configs,
        updateConfig,
        selectedProgramId,
        setSelectedProgramId
    };
}
