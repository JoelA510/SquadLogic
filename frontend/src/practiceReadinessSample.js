export const practiceReadinessSnapshot = {
  generatedAt: '2024-07-15T12:10:00Z',
  summary: {
    totalTeams: 18,
    assignedTeams: 17,
    unassignedTeams: 1,
    assignmentRate: 0.9444,
    manualFollowUpRate: 0.0556,
  },
  slotUtilization: [
    { slotId: 'F1-TUE-1800', utilization: 1, capacity: 2, assignedCount: 2 },
    { slotId: 'F1-THU-1800', utilization: 0.75, capacity: 4, assignedCount: 3 },
    { slotId: 'F2-WED-1700', utilization: 0.5, capacity: 2, assignedCount: 1 },
  ],
  fairnessConcerns: [
    {
      baseSlotId: 'F1-THU-1800',
      day: 'Thursday',
      representativeStart: '2024-08-22T18:00:00Z',
      dominantDivision: 'U10',
      dominantShare: 0.75,
      totalAssigned: 3,
      totalCapacity: 4,
      message:
        'Base slot F1-THU-1800 is 75% filled by division U10 (3/4 assignments)',
    },
  ],
  coachConflicts: [
    {
      coachId: 'coach-amy',
      reason: 'overlapping slots',
      teams: [
        { teamId: 'U8-T01', slotId: 'F1-TUE-1800' },
        { teamId: 'U10-T03', slotId: 'F1-TUE-1800-LATE' },
      ],
    },
  ],
  dataQualityWarnings: [
    'Slot F2-WED-1700 missing preferred day metadata; defaulted to unknown.',
  ],
};
