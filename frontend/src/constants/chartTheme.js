/**
 * Recharts colours as theme tokens (`frontend/src/index.css`), so the charts re-theme with
 * `data-theme` like the rest of the page. Recharts writes these into SVG presentation attributes
 * and inline styles, where `var()` resolves against the current theme.
 *
 * Tick labels take `--text-secondary` (6.3:1 on the light surface, 8.1:1 on the dark one); the
 * series colours are the primary and accent tokens, each at least 3:1 against the surface in both
 * themes (WCAG 1.4.11). `tests/chartColorTokens.test.js` refuses a literal colour in any chart.
 */

export const CHART_COLORS = {
  grid: 'var(--border)',
  axis: 'var(--text-secondary)',
  primary: 'var(--primary)',
  danger: 'var(--danger)',
  cursor: 'var(--bg-hover)',
};

/** Categorical series, in order: primary first, then the accents. */
export const CHART_SERIES = [
  'var(--primary)',
  'var(--accent-teal)',
  'var(--accent-amber)',
  'var(--accent-rose)',
  'var(--accent-violet)',
];

/** XAxis / YAxis props: the axis line and the tick labels in the secondary text colour. */
export const CHART_AXIS_PROPS = {
  stroke: CHART_COLORS.axis,
  tick: { fill: CHART_COLORS.axis },
};

/** Tooltip props: a surface card with primary text, in either theme. */
export const CHART_TOOLTIP_PROPS = {
  contentStyle: {
    backgroundColor: 'var(--bg-surface)',
    border: '1px solid var(--border)',
    borderRadius: '12px',
    boxShadow: 'var(--shadow-md)',
    color: 'var(--text-primary)',
  },
  labelStyle: { color: 'var(--text-primary)' },
  itemStyle: { color: 'var(--text-primary)' },
};

/** The hover cursor: a band behind a bar chart's column, a rule across a line or area chart. */
export const CHART_BAR_CURSOR = { fill: CHART_COLORS.cursor };
export const CHART_LINE_CURSOR = { stroke: 'var(--border-strong)' };

/** The hovered point's ring, in the surface colour (Recharts' default is white in both themes). */
export const CHART_ACTIVE_DOT = { r: 5, stroke: 'var(--bg-surface)', strokeWidth: 2 };
