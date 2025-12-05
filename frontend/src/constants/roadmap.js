export const ROADMAP_SECTIONS = [
    {
        id: 'team-generation',
        title: 'Team Generation',
        status: 'in-progress',
        summary:
            'Balanced roster allocator with buddy diagnostics and overflow tracking is ready; wiring the summary UI into the admin experience is underway.',
        actions: ['Connect Supabase persistence', 'Complete roster review workflows'],
    },
    {
        id: 'practice-scheduling',
        title: 'Practice Scheduling',
        status: 'in-progress',
        summary:
            'Allocator honors coach preferences, manual locks, and fairness scoring with automated swap recovery. Admin dashboards are still being assembled.',
        actions: ['Wire scheduler run logs', 'Expose manual adjustment tooling'],
    },
    {
        id: 'game-scheduling',
        title: 'Game Scheduling',
        status: 'in-progress',
        summary:
            'Round-robin generator and conflict-aware slot allocator are ready; Supabase persistence and admin tooling remain.',
        actions: ['Persist game assignments', 'Add conflict resolution dashboard'],
    },
    {
        id: 'evaluation',
        title: 'Evaluation Pipeline',
        status: 'in-progress',
        summary:
            'Practice and game metrics aggregate into readiness signals. Next step is wiring Supabase orchestration.',
        actions: ['Store evaluator snapshots', 'Surface dashboard visualisations'],
    },
    {
        id: 'output-generation',
        title: 'Output Generation',
        status: 'in-progress',
        summary:
            'CSV formatters produce master and per-team exports; storage integration and email workflows are upcoming.',
        actions: ['Implement Supabase storage uploads', 'Draft coach email templates'],
    },
];
