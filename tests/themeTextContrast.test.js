/**
 * The text tokens meet WCAG 2.2 AA (4.5:1) in both themes, computed from `frontend/src/index.css`
 * (plan item M4.2, "Discovered during execution": the `-400` palette sweep).
 *
 * `tests/paletteTextShades.test.js` keeps text on the tokens; this holds the tokens to the bar:
 *
 * - each text token on each page surface (`--bg-app`, `--bg-surface`, `--bg-sunken`,
 *   `--bg-hover`), light and dark;
 * - each text token on each translucent tint in the same string literal of the source
 *   (`'bg-red-500/10 text-status-error-text'`), the tint composited over `--bg-surface` and
 *   `--bg-sunken`, where the cards and panels that carry these chips sit, light and dark. The
 *   pairs come from the source, so a new tint behind a token is measured without listing it.
 *   Not measured: a tint over `--bg-app` or a hovered row, and a pairing split across literals.
 *
 * The axe scan (`tests/e2e/features/accessibility.feature`) measures what the mock seed renders;
 * this measures every pairing the source declares, rendered or not.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INDEX_CSS = readFileSync(path.join(ROOT, 'frontend', 'src', 'index.css'), 'utf8');
const TAILWIND_THEME = readFileSync(
  path.join(ROOT, 'node_modules', 'tailwindcss', 'theme.css'),
  'utf8'
);
const FRONTEND_SRC = path.join(ROOT, 'frontend', 'src');
const AA = 4.5;

/** Text utility → the prototype token it resolves to (index.css `@theme` and its aliases). */
const TEXT_TOKENS = {
  'text-text-primary': '--text-primary',
  'text-text-secondary': '--text-secondary',
  'text-text-muted': '--text-muted',
  'text-text-accent': '--primary-text',
  'text-status-success-text': '--success-text',
  'text-status-warning-text': '--warning-text',
  'text-status-error-text': '--danger-text',
};
const SURFACES = ['--bg-app', '--bg-surface', '--bg-sunken', '--bg-hover'];
const TINT_SURFACES = ['--bg-surface', '--bg-sunken'];
/** Tint families that are theme tokens rather than Tailwind's palette (index.css `@theme`). */
const THEME_TINTS = {
  brand: '--primary',
  'brand-400': '--primary-light',
  'brand-500': '--primary',
  'brand-600': '--primary-hover',
  'status-success': '--success',
  'status-warning': '--warning',
  'status-error': '--danger',
  'bg-surface': '--bg-surface',
  'bg-app': '--bg-app',
  'bg-glass': '--bg-sunken',
  'bg-surface-hover': '--bg-hover',
};

/** The custom properties declared directly in the block that opens with `selector {`. */
function block(css, selector) {
  const start = css.indexOf(`\n${selector} {`);
  if (start < 0) throw new Error(`index.css has no ${selector} block`);
  const end = css.indexOf('\n}', start);
  const vars = {};
  for (const m of css.slice(start, end).matchAll(/(--[\w-]+):\s*([^;]+);/g))
    vars[m[1]] = m[2].trim();
  return vars;
}

const LIGHT = block(INDEX_CSS, ':root');
const THEMES = { light: LIGHT, dark: { ...LIGHT, ...block(INDEX_CSS, "[data-theme='dark']") } };

/** `#rrggbb` → [r, g, b] in 0..1 */
function hex(value) {
  const m = /^#([0-9a-f]{6})$/i.exec(value);
  if (!m) throw new Error(`not a #rrggbb colour: ${value}`);
  return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255);
}

/** `oklch(L% C H)` → sRGB [r, g, b] in 0..1, clamped (CSS Color 4). */
function oklch(value) {
  const m = /^oklch\(([\d.]+)%\s+([\d.]+)\s+([\d.]+)\)$/.exec(value);
  if (!m) throw new Error(`not an oklch() colour: ${value}`);
  const [L, C, H] = [Number(m[1]) / 100, Number(m[2]), (Number(m[3]) * Math.PI) / 180];
  const [a, b] = [C * Math.cos(H), C * Math.sin(H)];
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const mm = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const lin = [
    4.0767416621 * l - 3.3077115913 * mm + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * mm - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * mm + 1.707614701 * s,
  ];
  return lin.map((v) => {
    const c = v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
    return Math.min(1, Math.max(0, c));
  });
}

/** A token's colour in a theme, following `var()` aliases. */
function tokenColour(theme, name) {
  let value = THEMES[theme][name];
  for (let i = 0; value && value.startsWith('var(') && i < 5; i += 1) {
    value = THEMES[theme][value.slice(4, -1).trim()];
  }
  if (!value) throw new Error(`${name} is not declared for the ${theme} theme`);
  return hex(value);
}

/** A tint's base colour: a theme token, or a Tailwind palette colour from its theme.css. */
function tintColour(theme, family) {
  if (THEME_TINTS[family]) return tokenColour(theme, THEME_TINTS[family]);
  const m = new RegExp(`--color-${family}:\\s*(oklch\\([^)]*\\));`).exec(TAILWIND_THEME);
  return m ? oklch(m[1]) : null;
}

const over = (top, alpha, bottom) => top.map((c, i) => c * alpha + bottom[i] * (1 - alpha));

function luminance(rgb) {
  const [r, g, b] = rgb.map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.jsx?$/.test(entry.name) ? [full] : [];
  });
}

const TEXT_CLASS = new RegExp(
  `(?<![\\w:-])(${Object.keys(TEXT_TOKENS).join('|')})(?![\\w/-])`,
  'g'
);
const TINT_CLASS = /(?<![\w:-])bg-([a-z]+(?:-[a-z]+)?(?:-\d{2,3})?)\/(\d+|\[[\d.]+\])(?![\w-])/g;

/**
 * `{ file, line, text, family, alpha }` for each text token sharing a string literal with a tint.
 * Literals, not lines: `cond ? 'bg-amber-500/20 text-a' : 'bg-blue-500/20 text-b'` pairs each
 * text with its own tint only.
 */
function tintPairs() {
  const pairs = [];
  for (const file of sourceFiles(FRONTEND_SRC)) {
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, index) => {
        for (const literal of line.split(/['"`]/)) {
          const texts = [...literal.matchAll(TEXT_CLASS)].map((m) => m[1]);
          if (texts.length === 0) continue;
          for (const t of literal.matchAll(TINT_CLASS)) {
            const raw = t[2].replace(/[[\]]/g, '');
            const alpha = raw.includes('.') ? Number(raw) : Number(raw) / 100;
            for (const text of new Set(texts)) {
              pairs.push({
                file: path.relative(FRONTEND_SRC, file),
                line: index + 1,
                text,
                family: t[1],
                alpha,
              });
            }
          }
        }
      });
  }
  return pairs;
}

describe('text tokens meet 4.5:1 in both themes (computed from index.css)', () => {
  it('reads both themes and the palette (the parsers are not matching nothing)', () => {
    expect(Object.keys(LIGHT).length).toBeGreaterThan(40);
    expect(THEMES.dark['--bg-surface']).not.toBe(LIGHT['--bg-surface']);
    expect(tintColour('light', 'red-500')).not.toBeNull();
    // Known values: white on black is 21:1, and the old `text-blue-400` on white failed.
    expect(contrast([1, 1, 1], [0, 0, 0])).toBeCloseTo(21, 5);
    expect(contrast(oklch('oklch(70.7% 0.165 254.624)'), [1, 1, 1])).toBeLessThan(AA);
  });

  for (const theme of ['light', 'dark']) {
    it(`every text token on every surface (${theme})`, () => {
      const failures = [];
      for (const [cls, token] of Object.entries(TEXT_TOKENS)) {
        for (const surface of SURFACES) {
          const ratio = contrast(tokenColour(theme, token), tokenColour(theme, surface));
          if (ratio < AA) failures.push(`${cls} on ${surface}: ${ratio.toFixed(2)}:1`);
        }
      }
      expect(failures).toEqual([]);
    });

    it(`every text token on the tints in its string literal (${theme})`, () => {
      const pairs = tintPairs();
      // A scan that found no pairs measured nothing.
      expect(pairs.length).toBeGreaterThan(40);
      const failures = [];
      const unknown = new Set();
      for (const pair of pairs) {
        const tint = tintColour(theme, pair.family);
        if (!tint) {
          unknown.add(pair.family);
          continue;
        }
        const fg = tokenColour(theme, TEXT_TOKENS[pair.text]);
        for (const surface of TINT_SURFACES) {
          const bg = over(tint, pair.alpha, tokenColour(theme, surface));
          const ratio = contrast(fg, bg);
          if (ratio < AA) {
            failures.push(
              `${pair.file}:${pair.line} ${pair.text} on bg-${pair.family}/${pair.alpha} over ` +
                `${surface}: ${ratio.toFixed(2)}:1`
            );
          }
        }
      }
      expect(failures).toEqual([]);
      // A tint whose colour can't be resolved is not measured, so it is named here: only the
      // `accent-500` family, which no theme declares (the class renders nothing).
      expect([...unknown].sort()).toEqual(['accent-500']);
    });
  }
});
