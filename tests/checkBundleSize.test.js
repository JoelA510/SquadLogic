// @vitest-environment node
/**
 * Bundle-budget gate (scripts/check-bundle-size.js), driven on a fake file
 * list so it does not depend on a full build.
 *
 * The gate used to print "no files matched" among the passing lines and exit
 * 0, so a renamed chunk silently escaped its budget; lucide-vendor (first
 * paint, modulepreloaded) matched no rule; and the `main entry` regex also
 * matched a lazy `index-*.js` chunk and counted it in first paint.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { evaluateBudget, parseFirstPaint } from '../scripts/check-bundle-size.js';

const HTML = `<!doctype html><html><head>
<link rel="icon" type="image/png" href="/favicon.png" />
<script type="module" crossorigin src="/assets/index-ENTRY111.js"></script>
<link rel="modulepreload" crossorigin href="/assets/react-vendor-AAAA.js">
<link rel="modulepreload" crossorigin href="/assets/lucide-vendor-BBBB.js">
<link rel="stylesheet" crossorigin href="/assets/index-CSS1.css">
</head><body></body></html>`;

// gzip size is encoded in the fake file itself so tests control it exactly.
const FILES = [
  { path: 'assets/index-ENTRY111.js', size: 400000, gz: 140000 },
  { path: 'assets/index-LAZY2222.js', size: 3000, gz: 965 },
  { path: 'assets/index-CSS1.css', size: 90000, gz: 21000 },
  { path: 'assets/react-vendor-AAAA.js', size: 50000, gz: 17000 },
  { path: 'assets/lucide-vendor-BBBB.js', size: 30000, gz: 7800 },
  { path: 'assets/SomePage-CCCC.js', size: 9000, gz: 2500 },
];
const gzipSize = (f) => f.gz;

/** @returns {any} */
function budget(overrides = {}) {
  return {
    rules: [
      {
        match: '^assets/index-.*\\.js$',
        label: 'main entry',
        firstPaint: true,
        maxGzipBytes: 140450,
      },
      {
        match: '^assets/index-.*\\.css$',
        label: 'main css',
        firstPaint: true,
        maxGzipBytes: 30000,
      },
      {
        match: '^assets/react-vendor-.*\\.js$',
        label: 'react vendor',
        firstPaint: true,
        maxGzipBytes: 25000,
      },
      {
        match: '^assets/lucide-vendor-.*\\.js$',
        label: 'lucide vendor',
        firstPaint: true,
        maxGzipBytes: 10000,
      },
    ],
    totalFirstPaintGzipBytes: 250000,
    ...overrides,
  };
}

const run = (b = budget(), files = FILES, html = HTML) =>
  evaluateBudget({ files, budget: b, firstPaint: parseFirstPaint(html), gzipSize });

describe('parseFirstPaint', () => {
  it('reads the entry script, modulepreloads and stylesheets, and nothing else', () => {
    expect(parseFirstPaint(HTML)).toEqual({
      entries: ['assets/index-ENTRY111.js'],
      assets: [
        'assets/index-ENTRY111.js',
        'assets/react-vendor-AAAA.js',
        'assets/lucide-vendor-BBBB.js',
        'assets/index-CSS1.css',
      ],
    });
  });

  it('reads the real built index.html shape (attribute order independent)', () => {
    const fp = parseFirstPaint(
      '<link href="/assets/a.css" rel="stylesheet"><script src="/assets/e.js" type="module">'
    );
    expect(fp.assets).toEqual(['assets/a.css', 'assets/e.js']);
    expect(fp.entries).toEqual(['assets/e.js']);
  });
});

describe('evaluateBudget', () => {
  it('passes the baseline and has exercised every rule (meta-assertion)', () => {
    const r = run();
    expect(r.violations).toEqual([]);
    for (const rule of budget().rules) {
      expect(r.passed.some((l) => l.startsWith(`OK ${rule.label} (`))).toBe(true);
    }
  });

  it('fails a rule that matches zero files, naming the rule', () => {
    const b = budget();
    b.rules.push({
      match: '^assets/bogus-vendor-.*\\.js$',
      label: 'bogus vendor',
      maxGzipBytes: 1000,
    });
    const r = run(b);
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0]).toMatch(/^\[NO MATCH\] rule "bogus vendor"/);
    expect(r.passed.join('\n')).not.toMatch(/bogus/);
  });

  it('fails a first-paint file that no firstPaint rule budgets', () => {
    const b = budget();
    b.rules = b.rules.filter((rule) => rule.label !== 'lucide vendor');
    const r = run(b);
    expect(r.violations).toEqual([
      '[UNBUDGETED FIRST-PAINT] assets/lucide-vendor-BBBB.js is loaded by index.html but no firstPaint rule matches it',
    ]);
  });

  it('counts a modulepreloaded chunk in the first-paint total even with no rule for it', () => {
    const b = budget();
    b.rules = b.rules.filter((rule) => rule.label !== 'lucide vendor');
    expect(run(b).firstPaintTotal).toBe(140000 + 21000 + 17000 + 7800);
  });

  it('warns, without failing, on lazy files that match no rule', () => {
    const r = run();
    expect(r.violations).toEqual([]);
    expect(r.warnings).toEqual([
      'assets/index-LAZY2222.js (965 B gz)',
      'assets/SomePage-CCCC.js (2.44 KB gz)',
    ]);
  });

  it('keeps the lazy index-*.js chunk out of main entry and out of the first-paint total', () => {
    const r = run();
    expect(r.passed).not.toContain('OK main entry (assets/index-LAZY2222.js): 965 B gz');
    expect(r.passed).toContain(
      'SKIP main entry (assets/index-LAZY2222.js): matches the regex but index.html does not load it'
    );
    expect(r.firstPaintTotal).toBe(140000 + 21000 + 17000 + 7800);
  });

  it('fails a firstPaint rule whose regex matches only lazy files', () => {
    const b = budget();
    b.rules.push({
      match: '^assets/SomePage-.*\\.js$',
      label: 'page',
      firstPaint: true,
      maxGzipBytes: 9000,
    });
    expect(run(b).violations[0]).toMatch(/^\[NO MATCH\] rule "page" .* loaded by index\.html/);
  });

  it('fails over-budget chunks and an over-budget first-paint total', () => {
    const b = budget({ totalFirstPaintGzipBytes: 185799 });
    b.rules[0].maxGzipBytes = 139999;
    const r = run(b);
    expect(r.violations).toHaveLength(2);
    expect(r.violations[0]).toMatch(/^\[GZIP\] main entry \(assets\/index-ENTRY111\.js\)/);
    expect(r.violations[1]).toMatch(/^\[GZIP\] total first-paint \(4 files\)/);
  });

  it('fails a rule with no size cap instead of passing it unchecked', () => {
    const b = budget();
    b.rules.push({ match: '^assets/SomePage-.*\\.js$', label: 'uncapped' });
    expect(run(b).violations).toEqual([
      '[CONFIG] rule "uncapped" needs a match and exactly one of maxGzipBytes / maxRawBytes',
    ]);
  });

  it('fails when index.html has no entry or loads a file missing from dist', () => {
    expect(run(budget(), FILES, '<html></html>').violations).toContain(
      '[FIRST-PAINT] index.html has no <script type="module" src> entry'
    );
    const html = HTML.replace('lucide-vendor-BBBB', 'lucide-vendor-GONE');
    expect(run(budget(), FILES, html).violations).toContain(
      '[FIRST-PAINT] index.html loads assets/lucide-vendor-GONE.js, not found in dist'
    );
  });
});

describe('config/bundle-budget.json', () => {
  const real = JSON.parse(readFileSync('config/bundle-budget.json', 'utf8'));

  it('every rule has exactly one cap and a rationale', () => {
    expect(real.rules.length).toBeGreaterThanOrEqual(10);
    for (const rule of real.rules) {
      expect(typeof rule.rationale).toBe('string');
      expect(
        [rule.maxGzipBytes, rule.maxRawBytes].filter((n) => typeof n === 'number')
      ).toHaveLength(1);
    }
  });

  it('flags the first-paint rules, including the modulepreloaded lucide vendor', () => {
    expect(
      real.rules
        .filter((r) => r.firstPaint)
        .map((r) => r.label)
        .sort()
    ).toEqual(['lucide vendor', 'main css', 'main entry', 'react vendor', 'supabase vendor']);
  });
});
