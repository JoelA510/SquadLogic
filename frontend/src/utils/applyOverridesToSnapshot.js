export function applyOverridesToSnapshot(snapshot, overrides = []) {
  if (!snapshot || typeof snapshot !== 'object') {
    return snapshot;
  }

  const appliedOverrides = overrides.filter((entry) => entry?.status === 'applied');
  const teamIdMap = snapshot.payload?.teamIdMap;

  const updatedTeamRows = Array.isArray(snapshot.payload?.teamRows)
    ? snapshot.payload.teamRows.map((team) => {
        const overridesForTeam = appliedOverrides.filter((entry) => {
          if (!entry?.teamId) return false;

          let supabaseTeamId;

          if (teamIdMap && typeof teamIdMap.get === 'function') {
            supabaseTeamId = teamIdMap.get(entry.teamId);
          } else if (teamIdMap && typeof teamIdMap === 'object') {
            supabaseTeamId = teamIdMap[entry.teamId];
          }

          const resolvedId = supabaseTeamId ?? entry.teamId;

          return resolvedId === team.id;
        });

        if (overridesForTeam.length === 0) {
          return team;
        }

        return overridesForTeam.reduce((currentTeam, entry) => {
          switch (entry.field) {
            case 'name':
              return { ...currentTeam, name: entry.value };
            case 'coachId':
              return { ...currentTeam, coach_id: entry.value };
            default:
              return currentTeam;
          }
        }, team);
      })
    : snapshot.payload?.teamRows;

  return {
    ...snapshot,
    manualOverrides: overrides,
    preparedTeamRows: Array.isArray(updatedTeamRows)
      ? updatedTeamRows.length
      : snapshot.preparedTeamRows,
    payload: snapshot.payload
      ? {
          ...snapshot.payload,
          teamRows: updatedTeamRows,
        }
      : snapshot.payload,
  };
}

