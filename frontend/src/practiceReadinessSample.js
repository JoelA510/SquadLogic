export const practiceReadinessSnapshot = {
  generatedAt: '2024-07-15T12:10:00Z',
  summary: {
    totalTeams: 18,
    assignedTeams: 17,
    unassignedTeams: 1,
    assignmentRate: 0.9444,
    manualFollowUpRate: 0.0556,
  },
  unassignedByReason: [
    {
      reason: 'no shared slot capacity',
      count: 1,
      teamIds: ['U10-T04'],
      divisionBreakdown: [
        { division: 'U10', count: 1, percentage: 1 },
      ],
    },
  ],
  slotUtilization: [
    { slotId: 'F1-TUE-1800', utilization: 1, capacity: 2, assignedCount: 2 },
    { slotId: 'F1-THU-1800', utilization: 0.75, capacity: 4, assignedCount: 3 },
    { slotId: 'F2-WED-1700', utilization: 0.5, capacity: 2, assignedCount: 1 },
  ],
  baseSlotDistribution: [
    {
      baseSlotId: 'F1-TUE-1800',
      day: 'Tuesday',
      representativeStart: '2024-08-20T18:00:00Z',
      totalAssigned: 2,
      totalCapacity: 2,
      utilization: 1,
      divisionBreakdown: [
        { division: 'U8', count: 1, percentage: 0.5 },
        { division: 'U10', count: 1, percentage: 0.5 },
      ],
    },
    {
      baseSlotId: 'F1-THU-1800',
      day: 'Thursday',
      representativeStart: '2024-08-22T18:00:00Z',
      totalAssigned: 3,
      totalCapacity: 4,
      utilization: 0.75,
      divisionBreakdown: [
        { division: 'U10', count: 3, percentage: 1.0 },
      ],
    },
    {
      baseSlotId: 'F2-WED-1700',
      day: 'Wednesday',
      representativeStart: '2024-08-21T17:00:00Z',
      totalAssigned: 1,
      totalCapacity: 2,
      utilization: 0.5,
      divisionBreakdown: [
        { division: 'U12', count: 1, percentage: 1.0 },
      ],
    },
  ],
  underutilizedBaseSlots: [
    {
      baseSlotId: 'F3-WED-1900',
      day: 'Wednesday',
      representativeStart: '2024-08-21T19:00:00Z',
      totalAssigned: 1,
      totalCapacity: 5,
      utilization: 0.2,
    },
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
  dayConcentrationAlerts: [
    {
      division: 'U12',
      dominantDay: 'Wednesday',
      dominantShare: 0.6667,
      totalAssignments: 6,
      message: 'Division U12 has 66.7% of practices on Wednesday (4/6)',
    },
  ],
  divisionDayDistribution: {
    U8: {
      totalAssigned: 5,
      averageStartMinutes: 1080,
      dayBreakdown: [
        { day: 'Tuesday', count: 3, percentage: 0.6 },
        { day: 'Thursday', count: 2, percentage: 0.4 },
      ],
    },
    U10: {
      totalAssigned: 7,
      averageStartMinutes: 1050,
      dayBreakdown: [
        { day: 'Tuesday', count: 3, percentage: 0.4286 },
        { day: 'Thursday', count: 3, percentage: 0.4286 },
        { day: 'Wednesday', count: 1, percentage: 0.1428 },
      ],
    },
    U12: {
      totalAssigned: 6,
      averageStartMinutes: 1020,
      dayBreakdown: [
        { day: 'Wednesday', count: 4, percentage: 0.6667 },
        { day: 'Tuesday', count: 2, percentage: 0.3333 },
      ],
    },
  },
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
