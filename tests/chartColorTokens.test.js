/**
 * The charts take their colours from the theme tokens (plan item M4.2, "Discovered during
 * execution": the analytics page's Recharts axes, gridlines and series kept hard-coded slate
 * colours, which did not re-theme, so the dark theme drew `#475569` tick labels on a dark card).
 *
 * Recharts writes its colours into SVG attributes and inline styles, where a `var(--token)`
 * resolves against the theme like any other CSS, so a literal colour has no reason to be there.
 * Every file that imports `recharts` is held to it; the shared values live in
 * `frontend/src/constants/chartTheme.js`, which is held to it too.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FRONTEND_SRC = path.join(ROOT, 'frontend', 'src');
const CHART_THEME = path.join(FRONTEND_SRC, 'constants', 'chartTheme.js');

/** A literal colour: `#rgb`, `#rrggbb`, `#rrggbbaa`, or an rgb()/rgba()/hsl()/hsla() call. */
const LITERAL_COLOUR =
  /(['"`\s{(:,=])(#[0-9a-f]{3}(?:[0-9a-f]{3})?(?:[0-9a-f]{2})?|(?:rgba?|hsla?)\([^)]*\))/gi;

function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.jsx?$/.test(entry.name) ? [full] : [];
  });
}

function literalColours(text) {
  return text.split('\n').flatMap((line, index) =>
    [...line.matchAll(LITERAL_COLOUR)]
      // A `#` that starts an id reference or a fragment is not a colour: `url(#colorFairness)`.
      .filter((m) => m[1] !== '(' || !/url\($/.test(line.slice(0, m.index + 1)))
      .map((m) => `${index + 1}: ${m[2]}`)
  );
}

describe('chart colours come from the theme tokens', () => {
  const chartFiles = sourceFiles(FRONTEND_SRC).filter((file) =>
    /from ['"]recharts['"]/.test(readFileSync(file, 'utf8'))
  );

  it('finds the chart files (the scan is not matching nothing)', () => {
    const names = chartFiles.map((file) => path.basename(file));
    expect(names).toContain('AnalyticalDashboard.jsx');
    expect(names).toContain('EnterpriseDashboard.jsx');
  });

  it('recognises a literal colour, and not a token or a gradient reference', () => {
    expect(
      literalColours(
        [
          'stroke="#475569"',
          "fill: '#fff',",
          "cursor={{ fill: 'rgba(15,23,42,0.05)' }}",
          "boxShadow: '0 10px 15px -3px rgb(0 0 0 / 0.1)',",
          "const COLORS = ['#2cdb85', '#60a5fa'];",
        ].join('\n')
      )
    ).toEqual([
      '1: #475569',
      '2: #fff',
      '3: rgba(15,23,42,0.05)',
      '4: rgb(0 0 0 / 0.1)',
      '5: #2cdb85',
      '5: #60a5fa',
    ]);
    expect(
      literalColours(
        'stroke="var(--border)" fill="url(#colorFairness)" id="colorFairness" fill={CHART.series}'
      )
    ).toEqual([]);
  });

  it('uses no literal colour in a chart file or the chart theme', () => {
    const offenders = [...chartFiles, CHART_THEME].flatMap((file) =>
      literalColours(readFileSync(file, 'utf8')).map(
        (hit) => `${path.relative(FRONTEND_SRC, file)}:${hit}`
      )
    );
    expect(
      offenders,
      'Use a token (frontend/src/constants/chartTheme.js, frontend/src/index.css)'
    ).toEqual([]);
  });
});
