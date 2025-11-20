export function applyOverridesToSnapshot(snapshot, overrides = []) {
  if (!snapshot || typeof snapshot !== 'object') {
    return snapshot;
  }

  const appliedOverrides = overrides.filter((entry) => entry?.status === 'applied');

  const updatedTeamRows = Array.isArray(snapshot.payload?.teamRows)
    ? snapshot.payload.teamRows.map((team) => {
        const overridesForTeam = appliedOverrides.filter(
          (entry) => entry.teamId === team.teamId || entry.teamId === team.id,
        );

        if (overridesForTeam.length === 0) {
          return team;
        }

        return overridesForTeam.reduce((currentTeam, entry) => {
          if (entry.field === 'name') {
            return { ...currentTeam, name: entry.value };
          }

          if (entry.field === 'coachId') {
            return { ...currentTeam, coachId: entry.value };
          }

          return currentTeam;
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

