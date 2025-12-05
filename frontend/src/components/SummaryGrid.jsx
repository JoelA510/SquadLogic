import React from 'react';

function SummaryGrid({ completed, pending }) {
    return (
        <section className="summary-grid" aria-label="Roadmap progress summary">
            <article className="summary-card glass-panel" data-tone="complete">
                <h2>{completed}</h2>
                <p>Automation pillars active</p>
            </article>
            <article className="summary-card glass-panel" data-tone="progress">
                <h2>{pending}</h2>
                <p>Integrations planned</p>
            </article>
        </section>
    );
}

export default SummaryGrid;
