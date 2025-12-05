import React from 'react';

function InsightSection({ title, items, emptyMessage, renderItem }) {
    const hasItems = items && items.length > 0;
    const sectionId = `insight-${title.toLowerCase().replace(/\s+/g, '-')}`;

    return (
        <article aria-labelledby={sectionId}>
            <h3 id={sectionId}>{title}</h3>
            {hasItems ? (
                <div className="insights-grid">{items.map(renderItem)}</div>
            ) : (
                <p className="insight__empty">{emptyMessage}</p>
            )}
        </article>
    );
}

export default InsightSection;
