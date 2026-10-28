import { useState, useMemo, useCallback } from 'react';
import { useImport } from '../contexts/ImportContext.jsx';
import { useOrganization } from '../contexts/OrganizationContext.jsx';
import { logger } from '../lib/logger.js';
import { computeAgeGroup } from '@squadlogic/core/ageGroups.js';

export function useTeamAnalysis() {
  const { importedPlayers } = useImport();
  const { currentOrganization, currentSeasonSetting } = useOrganization();
  const [configs, setConfigs] = useState({}); // { programId: { targetTeamSize: 10, ... } }
  const [selectedProgramId, setSelectedProgramId] = useState(null);

  // Reset state when org/season changes (Adjusting state during rendering pattern)
  const orgSeasonKey = `${currentOrganization?.id || ''}-${currentSeasonSetting?.id || ''}`;
  const [prevOrgSeasonKey, setPrevOrgSeasonKey] = useState(orgSeasonKey);

  if (orgSeasonKey !== prevOrgSeasonKey) {
    setPrevOrgSeasonKey(orgSeasonKey);
    setConfigs({});
    setSelectedProgramId(null);
  }

  const processPrograms = useCallback(
    (players) => {
      logger.log('processPrograms called with', players.length, 'players');
      const programMap = {};
      const errors = [];

      players.forEach((player) => {
        if (!player['Birthdate'] || !player['Gender']) {
          errors.push({
            type: 'missing_info',
            message: `Player ${player['First Name']} ${player['Last Name']} missing DOB or Gender`,
            player,
          });
          return;
        }

        const seasonYear = currentSeasonSetting?.season_year || new Date().getFullYear();
        const group = computeAgeGroup({
          dob: player['Birthdate'],
          seasonYear,
          cutoffMode: currentSeasonSetting?.age_cutoff_mode,
          cutoffMonth: currentSeasonSetting?.age_cutoff_month,
          cutoffDay: currentSeasonSetting?.age_cutoff_day,
        });
        if (!group) {
          errors.push({
            type: 'invalid_dob',
            message: `Player ${player['First Name']} ${player['Last Name']} has an unparseable birthdate`,
            player,
          });
          return;
        }
        const gender = player['Gender'] === 'm' ? 'Boys' : 'Girls';
        const uGroup = group.ageGroup;

        const programName = `${uGroup} ${gender}`;
        const programId = programName.replace(/\s+/g, '_').toLowerCase();

        if (!programMap[programId]) {
          programMap[programId] = {
            id: programId,
            name: programName,
            gender,
            ageGroup: uGroup,
            players: [],
          };
        }

        programMap[programId].players.push(player);
      });

      return {
        programs: Object.values(programMap).sort((a, b) => a.name.localeCompare(b.name)),
        errors,
      };
    },
    [
      currentSeasonSetting?.season_year,
      currentSeasonSetting?.age_cutoff_mode,
      currentSeasonSetting?.age_cutoff_month,
      currentSeasonSetting?.age_cutoff_day,
    ]
  );

  // Process imported data into programs and errors (Memoized)
  const { programs: derivedPrograms, errors: derivedErrors } = useMemo(() => {
    if (!importedPlayers?.data) return { programs: [], errors: [] };
    return processPrograms(importedPlayers.data);
  }, [importedPlayers, processPrograms]);

  // Auto-initialize configs and selection when data changes (Effect-less derivation)
  const effectiveSelectedId = useMemo(() => {
    if (selectedProgramId && derivedPrograms.some((p) => p.id === selectedProgramId)) {
      return selectedProgramId;
    }
    return derivedPrograms.length > 0 ? derivedPrograms[0].id : null;
  }, [selectedProgramId, derivedPrograms]);

  const updateConfig = (programId, newConfig) => {
    setConfigs((prev) => ({
      ...prev,
      [programId]: { ...prev[programId], ...newConfig },
    }));
  };

  const stats = useMemo(() => {
    return derivedPrograms.map((p) => {
      const config = configs[p.id] || {
        targetTeamSize: 12,
        minRosterSize: 10,
        maxRosterSize: 14,
        teamCountOverride: null,
      };
      const playerCount = p.players.length;
      const targetSize = config.targetTeamSize || 12;
      const estimatedTeams = config.teamCountOverride || Math.ceil(playerCount / targetSize);

      return {
        ...p,
        playerCount,
        estimatedTeams,
        avgRosterSize: (playerCount / estimatedTeams).toFixed(1),
      };
    });
  }, [derivedPrograms, configs]);

  return {
    programs: stats,
    validationErrors: derivedErrors,
    configs,
    updateConfig,
    selectedProgramId: effectiveSelectedId,
    setSelectedProgramId,
  };
}
