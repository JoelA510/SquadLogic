import React from 'react';
import PropTypes from 'prop-types';
import { HEAT_MODEL } from '@squadlogic/core/heat/index.js';

const GROUPS = [
  ['forecast', 'Forecast data'],
  ['crosscheck', "NWS's own WBGT forecast, for cross-check"],
  ['model', 'WBGT model'],
  ['surface', 'Turf vs grass basis'],
  ['variability', 'On-site vs modeled WBGT'],
  ['solar', 'Solar position and clear-sky models'],
  ['thresholds', 'Thresholds and actions'],
];

const External = ({ href, children }) => (
  <a href={href} target="_blank" rel="noopener noreferrer" className="text-link">
    {children}
    <span className="sr-only"> (opens in a new tab)</span>
  </a>
);

External.propTypes = { href: PropTypes.string.isRequired, children: PropTypes.node.isRequired };

/**
 * Every source, model and threshold behind the rows on screen, rendered from
 * the rows' provenance (`sourcesForProvenance`), plus the organisation's own
 * governing-body links. Nothing here is typed into the component: a source
 * the provenance does not name is not listed, and one it names that the
 * catalogue lacks throws upstream.
 */
export default function HeatSourcesPanel({
  sources,
  grids,
  category,
  categorySource,
  thresholdNote,
  guidanceLinks,
  formatInstant,
}) {
  const byGroup = (group) => sources.filter((s) => s.group === group);
  return (
    <section className="card" aria-labelledby="heat-sources-heading" data-testid="heat-sources">
      <div className="card-head">
        <h3 id="heat-sources-heading">Sources</h3>
      </div>
      <div className="card-body space-y-4 text-sm">
        {sources.length === 0 && (
          <p className="text-text-muted">Sources are listed once a row has been computed.</p>
        )}
        {GROUPS.map(([group, title]) => {
          const entries = byGroup(group);
          if (entries.length === 0) return null;
          return (
            <div key={group}>
              <h4 className="font-semibold text-text-primary">{title}</h4>
              <ul className="list-disc pl-5 space-y-1">
                {entries.map((s) => (
                  <li key={s.id} data-testid={`heat-source-${s.id}`}>
                    {s.citation ? (
                      <>
                        {s.citation}{' '}
                        <External href={s.url}>{s.doi ? `doi:${s.doi}` : s.url}</External>
                      </>
                    ) : (
                      <External href={s.url}>{s.title}</External>
                    )}
                    {s.also?.map((a) => (
                      <span key={a.url}>
                        {' · '}
                        <External href={a.url}>{a.label}</External>
                      </span>
                    ))}
                    {group === 'forecast' &&
                      grids.map((g) => (
                        <span key={g.gridpointUrl} className="block text-text-muted">
                          Grid {g.gridId} {g.gridX},{g.gridY}: NWS updated{' '}
                          {formatInstant(g.updateTime)}, retrieved {formatInstant(g.retrievedAt)} (
                          <External href={g.gridpointUrl}>endpoint</External>)
                        </span>
                      ))}
                    {group === 'thresholds' && (
                      <span className="block text-text-muted" data-testid="heat-threshold-category">
                        Category {category} (
                        {categorySource === 'configured'
                          ? 'set by this organization'
                          : 'default; not configured'}
                        ).{thresholdNote ? ` ${thresholdNote}` : ''}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
        <div>
          <h4 className="font-semibold text-text-primary">Governing-body guidance</h4>
          {guidanceLinks.length === 0 ? (
            <p className="text-text-muted">None configured for this organization.</p>
          ) : (
            <ul className="list-disc pl-5 space-y-1" data-testid="heat-guidance-links">
              {guidanceLinks.map((l) => (
                <li key={l.url}>
                  <External href={l.url}>{l.label}</External>
                </li>
              ))}
            </ul>
          )}
        </div>
        <p className="text-xs text-text-muted">
          Model {HEAT_MODEL.id} v{HEAT_MODEL.version}.
        </p>
      </div>
    </section>
  );
}

HeatSourcesPanel.propTypes = {
  sources: PropTypes.arrayOf(PropTypes.object).isRequired,
  grids: PropTypes.arrayOf(PropTypes.object).isRequired,
  category: PropTypes.oneOf([1, 2, 3]).isRequired,
  categorySource: PropTypes.oneOf(['configured', 'default']).isRequired,
  thresholdNote: PropTypes.string,
  guidanceLinks: PropTypes.arrayOf(
    PropTypes.shape({ label: PropTypes.string, url: PropTypes.string })
  ).isRequired,
  formatInstant: PropTypes.func.isRequired,
};
