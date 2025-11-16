export const gameReadinessSnapshot = {
  generatedAt: '2024-07-15T12:20:00Z',
  summary: {
    totalGames: 18,
    divisionsCovered: 3,
    scheduledRate: 0.9444,
    unscheduledMatchups: 1,
    teamsWithByes: 2,
    sharedSlotAlerts: 1,
  },
  unscheduled: [
    {
      reason: 'lightning postponement',
      weekIndex: 3,
      matchup: 'U10-T01 vs U10-T02',
      note: 'Field 1 unavailable; awaiting reschedule window',
    },
  ],
  byes: [
    {
      division: 'U12',
      weekIndex: 4,
      teamIds: ['U12-T02', 'U12-T03'],
    },
  ],
  warnings: [
    {
      type: 'coach-conflict',
      severity: 'error',
      message: 'Coach Marie is double-booked in week 2.',
      details: {
        coachId: 'coach-marie',
        weekIndex: 2,
        games: [
          { teamId: 'U8-T01', slotId: 'FIELD-1-SAT-0900' },
          { teamId: 'U10-T02', slotId: 'FIELD-2-SAT-0915' },
        ],
      },
    },
    {
      type: 'shared-slot-imbalance',
      severity: 'warning',
      message: 'Shared slot FIELD-1-SAT-1100 is 75% allocated to U10.',
      details: {
        slotId: 'FIELD-1-SAT-1100',
        dominantDivision: 'U10',
        dominantShare: 0.75,
        totalAssignments: 4,
        breakdown: [
          { division: 'U10', count: 3 },
          { division: 'U12', count: 1 },
        ],
      },
    },
  ],
  fieldHighlights: [
    {
      fieldId: 'Field 1',
      games: 7,
      divisions: ['U8', 'U10'],
      note: 'Maintains even cadence across morning windows.',
    },
    {
      fieldId: 'Field 2',
      games: 5,
      divisions: ['U10', 'U12'],
      note: 'Hosts the outstanding shared-slot imbalance flagged above.',
    },
  ],
};
