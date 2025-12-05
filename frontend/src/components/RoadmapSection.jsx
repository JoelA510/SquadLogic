import React from 'react';

const statusLabels = {
    complete: { label: 'Complete', tone: 'status-complete' },
    'in-progress': { label: 'In Progress', tone: 'status-progress' },
    pending: { label: 'Pending', tone: 'status-pending' },
};

function RoadmapSection({ roadmapSections }) {
    return (
        <section aria-labelledby="roadmap-heading" className="section-panel glass-panel roadmap-section">
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
                                    <div className="roadmap-actions">
                                        <p className="roadmap-actions__label">Next actions</p>
                                        <ul className="actions-list">
                                            {section.actions.map((action) => (
                                                <li key={action}>{action}</li>
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
    );
}

export default RoadmapSection;
