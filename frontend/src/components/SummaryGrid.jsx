import React from 'react';

function SummaryGrid({ completed, pending }) {
    return (
        <section className="summary-grid" aria-label="Roadmap progress summary">
            <article className="summary-card glass-panel" data-tone="complete">
                <h2>{completed}</h2>
                <p>System Modules Ready</p>
            </article>
            <article className="summary-card glass-panel" data-tone="progress">
                <h2>{pending}</h2>
                <p>Upcoming Features</p>
            </article>
        </section>
    );
}

export default SummaryGrid;
