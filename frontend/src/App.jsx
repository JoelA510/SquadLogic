import { useMemo } from 'react';
import './App.css';

const roadmapSections = [
  {
    id: 'team-generation',
    title: 'Team Generation',
    status: 'complete',
    summary:
      'Balanced roster allocator with buddy diagnostics and overflow tracking is available for integration.',
    actions: ['Connect Supabase persistence', 'Design roster review workflows'],
  },
  {
    id: 'practice-scheduling',
    title: 'Practice Scheduling',
    status: 'complete',
    summary:
      'Allocator honors coach preferences, manual locks, and fairness scoring with automated swap recovery.',
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

const statusLabels = {
  complete: { label: 'Complete', tone: 'status-complete' },
  'in-progress': { label: 'In Progress', tone: 'status-progress' },
  pending: { label: 'Pending', tone: 'status-pending' },
};

function App() {
  const summary = useMemo(() => {
    const completed = roadmapSections.filter((section) => section.status === 'complete').length;
    const pending = roadmapSections.length - completed;
    return {
      completed,
      pending,
    };
  }, []);

  return (
    <div className="app-shell">
      <header className="hero">
        <h1>GotSport Teamer Scheduler Admin</h1>
        <p>
          This prototype dashboard introduces the future admin experience. It surfaces roadmap agents and next steps while the
          Supabase-backed workflows are still under construction.
        </p>
      </header>

      <section className="summary-grid" aria-label="Roadmap progress summary">
        <article className="summary-card" data-tone="complete">
          <h2>{summary.completed}</h2>
          <p>Automation pillars already implemented</p>
        </article>
        <article className="summary-card" data-tone="progress">
          <h2>{summary.pending}</h2>
          <p>Follow-up integrations still planned</p>
        </article>
      </section>

      <section aria-labelledby="roadmap-heading" className="roadmap-section">
        <h2 id="roadmap-heading">Core agents</h2>
        <ul className="roadmap-list">
          {roadmapSections.map((section) => {
            const status = statusLabels[section.status] ?? statusLabels.pending;
            return (
              <li key={section.id} className="roadmap-item">
                <div className={`status-pill ${status.tone}`}>
                  <span className="status-dot" aria-hidden="true" />
                  <span>{status.label}</span>
                </div>
                <div className="roadmap-body">
                  <h3>{section.title}</h3>
                  <p>{section.summary}</p>
                  {section.actions.length > 0 && (
                    <div>
                      <p className="actions-heading">Next actions</p>
                      <ul className="actions-list">
                        {section.actions.map((action, index) => (
                          <li key={index}>{action}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}

export default App;
